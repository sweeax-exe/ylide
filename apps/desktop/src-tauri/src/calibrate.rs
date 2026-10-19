//! "Optimize for this PC": a 2-4 minute calibration of how llama-server runs
//! the chat model on this machine.
//!
//! `--fit` stays the placement engine (it adapts to the free VRAM at every
//! start), so no GPU layer count is ever stored. The calibration tunes what
//! fit takes as given: the load mode, the KV cache type (only if the user
//! allows the lossy one), the batch size, the generation threads and their
//! CPU affinity (one CCD vs. all cores on Ryzen), and llama.cpp's GPU cache
//! for experts kept in RAM. Coordinate descent: each step starts from the
//! best so far and keeps a change only when it is clearly faster.
//!
//! Every trial restarts the server with the candidate settings and measures
//! a fixed request (prompt processing and generation). A trial that does not
//! start, does not fit, leaves too little VRAM or RAM, or generates far slower
//! than the baseline (the signature of VRAM spilling into shared memory on
//! Windows) is dropped. The result is stored per model file and hardware;
//! starts use it while those stay the same.

use crate::error::{AppError, AppResult};
use crate::models::InstalledModel;
use crate::runtime::{StartTuning, Tuning};
use crate::state::AppState;
use hardware::{Backend, HardwareProfile};
use registry::estimate::{KvCacheType, Placement, Plan};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

type Cmd<T> = Result<T, AppError>;

/// Measured speeds of one configuration (tokens per second).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Speeds {
    /// Reading the prompt.
    pub prompt_tps: f64,
    /// Writing the answer.
    pub gen_tps: f64,
}

impl Speeds {
    /// Seconds for a typical agent step (4,000 prompt tokens, 400 answer tokens):
    /// the one number trials are compared by.
    pub fn step_seconds(&self) -> f64 {
        4000.0 / self.prompt_tps.max(0.1) + 400.0 / self.gen_tps.max(0.1)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TrialKind {
    Baseline,
    LoadMode,
    KvCache,
    BatchSize,
    Threads,
    ExpertCache,
    Confirm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TrialOutcome {
    /// Measured; the reference (baseline, confirmation).
    Measured,
    /// Faster: kept.
    Better,
    /// Not faster enough: dropped.
    Worse,
    /// Faster, but its answer differed from the reference: dropped.
    Different,
    /// Ran out of GPU memory or RAM, or spilled into shared memory: dropped.
    Overflow,
    /// Did not start or answer.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Trial {
    pub kind: TrialKind,
    pub tuning: Tuning,
    pub speeds: Option<Speeds>,
    pub outcome: TrialOutcome,
    /// Technical detail for failed trials.
    pub note: Option<String>,
}

/// What a calibration is valid for. When any of it changes (another model
/// file, runtime build, GPU driver, RAM speed, ...), it is measured again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CalibrationKey {
    pub model_path: String,
    #[ts(type = "number")]
    pub model_bytes: u64,
    #[ts(type = "number")]
    pub model_modified: u64,
    /// Runtime build and variant, e.g. "b11669/cuda-13.4".
    pub runtime: String,
    /// GPU name, VRAM and driver.
    pub gpu: String,
    /// CPU brand and core counts.
    pub cpu: String,
    /// RAM size and the speed it runs at.
    pub ram: String,
    pub context: u32,
    pub slots: u32,
    pub projector: bool,
}

impl CalibrationKey {
    /// Names of the fields that differ from `other`.
    pub fn changes(&self, other: &CalibrationKey) -> Vec<String> {
        let mut out = Vec::new();
        let mut diff = |name: &str, differs: bool| {
            if differs {
                out.push(name.to_string());
            }
        };
        diff("model", (&self.model_path, self.model_bytes, self.model_modified) != (&other.model_path, other.model_bytes, other.model_modified));
        diff("runtime", self.runtime != other.runtime);
        diff("gpu", self.gpu != other.gpu);
        diff("cpu", self.cpu != other.cpu);
        diff("ram", self.ram != other.ram);
        diff("context", self.context != other.context);
        diff("slots", self.slots != other.slots);
        diff("projector", self.projector != other.projector);
        out
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CalibrationResult {
    pub key: CalibrationKey,
    pub model_id: String,
    pub quant: String,
    pub baseline: Speeds,
    /// Speeds with `tuning` (the confirmation run), equal to `baseline` when nothing helped.
    pub best: Speeds,
    pub tuning: Tuning,
    pub trials: Vec<Trial>,
    #[ts(type = "number")]
    pub created_at_unix_ms: u64,
}

/// Progress pushed on `runtime://calibration`.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "state")]
#[ts(export)]
pub enum CalibrationEvent {
    Running {
        /// The trial being measured now.
        current: TrialKind,
        trials: Vec<Trial>,
        /// Estimated number of trials in all.
        total: u32,
    },
    Done {
        result: Box<CalibrationResult>,
    },
    Cancelled,
    Failed {
        message: String,
    },
}

/// What the Models page shows for the selected model.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CalibrationStatus {
    /// The last calibration of this model file, also when it no longer applies.
    pub result: Option<CalibrationResult>,
    /// What changed since (empty: it applies).
    pub changes: Vec<String>,
    pub running: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CalibrationOptions {
    /// Also try a q8_0 KV cache (very slightly lossy).
    pub allow_lossy_kv: bool,
}

// ------------------------------------------------------------------ storage

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoreFile {
    results: Vec<CalibrationResult>,
}

fn store_path(state: &AppState) -> PathBuf {
    state.paths.data.join("calibration.json")
}

fn load_results(path: &Path) -> Vec<CalibrationResult> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<StoreFile>(&s).ok())
        .map(|f| f.results)
        .unwrap_or_default()
}

/// Keeps one result per model file (the newest).
fn save_result(path: &Path, result: CalibrationResult) -> AppResult<()> {
    let mut results = load_results(path);
    results.retain(|r| r.key.model_path != result.key.model_path);
    results.push(result);
    write_results(path, results)
}

fn write_results(path: &Path, results: Vec<CalibrationResult>) -> AppResult<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&StoreFile { results })?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// ------------------------------------------------------------------ keys

/// What a calibration of `installed` depends on, right now.
pub fn key_for(state: &AppState, installed: &InstalledModel, plan: Option<&Plan>) -> Option<CalibrationKey> {
    let settings = state.settings();
    let hw = state.hardware();
    let registry = state.registry();
    let path = installed.primary_path()?.to_string();
    let meta = std::fs::metadata(&path).ok()?;
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let runtime = state.runtime.select(&hw, &registry, &settings)?;
    let model = registry.models.iter().find(|m| m.id == installed.model_id);
    let context = settings
        .models
        .context
        .or(plan.map(|p| p.context))
        .or(model.map(|m| m.context.recommended.min(32_768)))
        .unwrap_or(16_384);
    Some(CalibrationKey {
        model_path: path,
        model_bytes: meta.len(),
        model_modified: modified,
        runtime: format!("{}/{}", runtime.version, runtime.variant),
        gpu: gpu_label(&hw),
        cpu: format!("{} ({}C/{}T)", hw.cpu.brand, hw.cpu.physical_cores, hw.cpu.logical_cores),
        ram: ram_label(&hw, &hardware::memory_modules()),
        context,
        slots: settings.models.slots.clamp(1, 8),
        projector: installed.projector.as_ref().is_some_and(|p| Path::new(&p.path).is_file()),
    })
}

fn gpu_label(hw: &HardwareProfile) -> String {
    match hw.primary_gpu() {
        Some(g) => format!(
            "{}, {} MiB, driver {}",
            g.name,
            g.dedicated_vram_bytes >> 20,
            hw.acceleration.cuda_driver.as_deref().unwrap_or("-")
        ),
        None => "none".into(),
    }
}

fn ram_label(hw: &HardwareProfile, modules: &[hardware::MemoryModule]) -> String {
    let speed = modules.iter().filter_map(|m| m.configured_mts).min();
    let kind = modules.first().map_or("RAM", |m| m.kind.as_str());
    match speed {
        Some(mts) => format!("{} GiB {kind}-{mts}", hw.memory.total_bytes >> 30),
        None => format!("{} GiB", hw.memory.total_bytes >> 30),
    }
}

/// How the chat server starts: with the calibrated settings when they apply
/// (falling back to the defaults once if they no longer start), else with
/// the user's settings alone. The user's KV cache choice always wins.
pub fn start_tuning(state: &AppState, installed: &InstalledModel, plan: Option<&Plan>) -> StartTuning {
    let settings = state.settings();
    let defaults = Tuning::from_settings(&settings);
    let calibrated = key_for(state, installed, plan).and_then(|key| load_results(&store_path(state)).into_iter().find(|r| r.key == key));
    match calibrated {
        Some(r) if r.tuning != Tuning::default() => {
            let mut tuning = r.tuning;
            if defaults.kv.is_some() {
                tuning.kv = defaults.kv;
            }
            StartTuning {
                tuning,
                fallback: Some(defaults),
                calibrated: true,
                trial: false,
            }
        }
        _ => StartTuning {
            tuning: defaults,
            ..StartTuning::default()
        },
    }
}

// ------------------------------------------------------------------ commands

/// The cancel token of the running calibration.
static RUNNING: std::sync::Mutex<Option<CancellationToken>> = std::sync::Mutex::new(None);

fn selected(state: &AppState) -> AppResult<InstalledModel> {
    let settings = state.settings();
    let selection = settings.models.chat.clone().ok_or_else(|| AppError::new("no_model_selected", "choose a model first"))?;
    state
        .models
        .find(&selection.model_id, &selection.quant)
        .ok_or_else(|| AppError::new("model_not_installed", format!("{} {}", selection.model_id, selection.quant)))
}

#[tauri::command]
pub fn calibration_get(state: State<'_, AppState>) -> Cmd<CalibrationStatus> {
    let running = state.runtime.is_calibrating();
    let Ok(installed) = selected(&state) else {
        return Ok(CalibrationStatus { result: None, changes: vec![], running });
    };
    let plan = crate::commands::plan_for(&state, &installed.model_id, &installed.quant);
    let key = key_for(&state, &installed, plan.as_ref());
    let path = installed.primary_path().unwrap_or_default();
    let result = load_results(&store_path(&state)).into_iter().find(|r| r.key.model_path == path);
    let changes = match (&result, &key) {
        (Some(r), Some(k)) => r.key.changes(k),
        _ => vec![],
    };
    Ok(CalibrationStatus { result, changes, running })
}

/// Forgets the calibration of the selected model; the next start uses the defaults.
#[tauri::command]
pub fn calibration_reset(state: State<'_, AppState>) -> Cmd<()> {
    let installed = selected(&state)?;
    let path = store_path(&state);
    let mut results = load_results(&path);
    results.retain(|r| Some(r.key.model_path.as_str()) != installed.primary_path());
    write_results(&path, results)
}

#[tauri::command]
pub fn calibration_cancel() -> Cmd<()> {
    if let Some(token) = RUNNING.lock().unwrap().as_ref() {
        token.cancel();
    }
    Ok(())
}

/// Starts the calibration of the running chat model. Only while nothing uses
/// it: no agent run, no chat or inline request.
#[tauri::command]
pub async fn calibration_run(app: AppHandle, state: State<'_, AppState>, options: CalibrationOptions) -> Cmd<()> {
    let settings = state.settings();
    if settings.endpoint.enabled {
        return Err(AppError::new("calibration_external", "an external server cannot be calibrated"));
    }
    let installed = selected(&state)?;
    let info = state.runtime.info().filter(|i| matches!(i.status, inference::ServerStatus::Ready) && i.model_id == installed.model_id && i.quant == installed.quant);
    if info.is_none() {
        return Err(AppError::new("calibration_not_running", "start the model first"));
    }
    if state.agents.active() > 0 || !state.requests.lock().unwrap().is_empty() {
        return Err(AppError::new("calibration_busy", "the model is answering; try again when it is idle"));
    }
    if let Some(handle) = state.runtime.ready_handle().await {
        let snap = handle.scheduler.snapshot();
        if snap.slots.iter().any(Option::is_some) || !snap.queued.is_empty() {
            return Err(AppError::new("calibration_busy", "the model is answering; try again when it is idle"));
        }
    }
    let cancel = {
        let mut running = RUNNING.lock().unwrap();
        if running.is_some() || state.runtime.is_calibrating() {
            return Err(AppError::new("calibration_running", "a calibration is already running"));
        }
        let token = CancellationToken::new();
        *running = Some(token.clone());
        token
    };
    state.runtime.set_calibrating(true);
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let event = match calibrate(&app, &state, &installed, options, &cancel).await {
            Ok(result) => {
                let saved = save_result(&store_path(&state), result.clone());
                match saved {
                    Ok(()) => CalibrationEvent::Done { result: Box::new(result) },
                    Err(e) => CalibrationEvent::Failed { message: e.message },
                }
            }
            Err(Stop::Cancelled) => CalibrationEvent::Cancelled,
            Err(Stop::Failed(message)) => CalibrationEvent::Failed { message },
        };
        state.runtime.set_calibrating(false);
        *RUNNING.lock().unwrap() = None;
        // Back to normal: the best known-good settings (the new result, an
        // earlier one, or the defaults).
        if let Err(e) = crate::commands::server_start(app.clone(), app.state::<AppState>(), None).await {
            tracing::warn!("restart after the calibration failed: {e}");
        }
        let _ = app.emit("runtime://calibration", &event);
    });
    Ok(())
}

// ------------------------------------------------------------------ the measurement

#[derive(Debug)]
enum Stop {
    Cancelled,
    Failed(String),
}

/// A trial's measurement, or why it has none.
#[derive(Debug, Clone)]
enum Measure {
    Ok { speeds: Speeds, answer: String },
    Overflow(String),
    Failed(String),
}

/// Tokens generated per measurement; the prompt is about 3,000 tokens.
const GENERATE: u32 = 64;
/// Less free VRAM than this after loading counts as an overflow. `--fit`
/// leaves 1 GiB at load time, but CUDA graphs and buffers take part of it
/// once the first request runs: the reference PC's everyday setup keeps
/// 300-500 MiB free and runs fine. A spill shows in the generation speed.
const MIN_FREE_VRAM: u64 = 128 << 20;
/// Less available RAM than this after loading counts as an overflow.
const MIN_FREE_RAM: u64 = 2 << 30;
/// A change is kept only when the reference step gets this much faster.
const KEEP_IF_FASTER: f64 = 0.03;
/// The expert cache must be clearly faster, it is new in llama.cpp.
const KEEP_CACHE_IF_FASTER: f64 = 0.05;
/// Below this share of the baseline's generation speed a trial spilled.
const SPILL_BELOW: f64 = 0.6;

/// A fixed, code-like prompt of about 3,000 tokens; every trial reads the same.
fn bench_prompt() -> String {
    let mut s = String::from("// Inventory helpers\n");
    for i in 0..170u32 {
        s.push_str(&format!(
            "fn price_{i}(qty: u32, unit: u32) -> u32 {{ let base = qty * unit + {}; if base > {} {{ base - {} }} else {{ base }} }}\n",
            i * 7 % 13,
            100 + i * 3,
            i % 9
        ));
    }
    s.push_str("// Summary of the helpers above:\n");
    s
}

/// Starts the model with a candidate and measures it.
trait Measurer {
    /// Measures `tuning`; an error stops the whole calibration (cancelled).
    async fn measure(&mut self, tuning: &Tuning) -> Result<Measure, Stop>;
    /// The last started server loaded the model without mmap (`-lm none`).
    fn loaded_without_mmap(&self) -> bool;
    /// The trial `current` starts; `trials` are done.
    fn progress(&self, current: TrialKind, trials: &[Trial], total: u32);
}

/// Measures a ready server: warm-up, memory check, then two runs of the
/// fixed request, averaged.
async fn measure_server(client: &inference::LlmClient, prompt: &str, cancel: &CancellationToken) -> Result<Measure, Stop> {
    // Warm-up: first kernels, CUDA graphs, page cache.
    tokio::select! {
        r = client.bench("Hello", 8) => if let Err(e) = r { return Ok(Measure::Failed(e.to_string())) },
        _ = cancel.cancelled() => return Err(Stop::Cancelled),
    }
    if let Some(problem) = memory_problem().await {
        return Ok(Measure::Overflow(problem));
    }
    let mut runs = Vec::new();
    for _ in 0..2 {
        let r = tokio::select! {
            r = client.bench(prompt, GENERATE) => r,
            _ = cancel.cancelled() => return Err(Stop::Cancelled),
        };
        match r {
            Ok(r) => runs.push(r),
            Err(e) => return Ok(Measure::Failed(e.to_string())),
        }
    }
    let n = runs.len() as f64;
    let speeds = Speeds {
        prompt_tps: runs.iter().map(|r| r.prompt_per_second).sum::<f64>() / n,
        gen_tps: runs.iter().map(|r| r.predicted_per_second).sum::<f64>() / n,
    };
    Ok(Measure::Ok {
        speeds,
        answer: runs.pop().map(|r| r.content).unwrap_or_default(),
    })
}

/// Too little VRAM (NVML) or RAM left once the model is loaded.
async fn memory_problem() -> Option<String> {
    let (free_vram, free_ram) = tokio::task::spawn_blocking(|| {
        let hw = hardware::probe(None);
        (hw.primary_gpu().and_then(|g| g.vram_free_bytes), hardware::available_memory())
    })
    .await
    .ok()?;
    if let Some(v) = free_vram
        && v < MIN_FREE_VRAM
    {
        return Some(format!("only {} MiB of VRAM left", v >> 20));
    }
    (free_ram < MIN_FREE_RAM).then(|| format!("only {} MiB of RAM left", free_ram >> 20))
}

/// The app's measurer: restarts the chat server with each candidate.
struct AppMeasurer<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
    installed: &'a InstalledModel,
    plan: Option<Plan>,
    cancel: &'a CancellationToken,
    prompt: String,
}

impl Measurer for AppMeasurer<'_> {
    async fn measure(&mut self, tuning: &Tuning) -> Result<Measure, Stop> {
        if self.cancel.is_cancelled() {
            return Err(Stop::Cancelled);
        }
        let settings = self.state.settings();
        let hw = self.state.hardware();
        let registry = self.state.registry();
        let launch = StartTuning {
            tuning: tuning.clone(),
            trial: true,
            ..StartTuning::default()
        };
        let started = tokio::select! {
            r = self.state.runtime.start(self.app, &hw, &registry, &settings, self.installed, self.plan.clone(), launch) => r,
            _ = self.cancel.cancelled() => return Err(Stop::Cancelled),
        };
        if let Err(e) = started {
            let overflow = e.code == "fit_failed" || e.message.to_lowercase().contains("out of memory") || e.message.contains("failed to allocate");
            return Ok(if overflow { Measure::Overflow(e.message) } else { Measure::Failed(e.message) });
        }
        let Some(handle) = self.state.runtime.ready_handle().await else {
            return Ok(Measure::Failed("the server stopped".into()));
        };
        measure_server(&handle.client, &self.prompt, self.cancel).await
    }

    fn loaded_without_mmap(&self) -> bool {
        self.state.runtime.info().is_some_and(|i| no_mmap_in(&i.command))
    }

    fn progress(&self, current: TrialKind, trials: &[Trial], total: u32) {
        let _ = self.app.emit(
            "runtime://calibration",
            &CalibrationEvent::Running {
                current,
                trials: trials.to_vec(),
                total,
            },
        );
    }
}

/// `-lm none` on a command line.
fn no_mmap_in(command: &[String]) -> bool {
    command.windows(2).any(|w| w[0] == "-lm" && w[1] == "none")
}

/// What the trials depend on, apart from how they are measured.
#[derive(Debug, Clone, Default)]
struct Setup {
    /// The user's own choices: every trial starts from them.
    base: Tuning,
    /// The plan computes weights on the CPU (MoE or partial offload).
    offload: bool,
    moe: bool,
    /// The plan's KV cache type.
    plan_kv: Option<KvCacheType>,
    allow_lossy_kv: bool,
    topology: Option<hardware::CpuTopology>,
    /// `--moe-cache-mib` to try (CUDA, MoE offload, listed by the build).
    expert_cache_mib: Option<u32>,
}

impl Setup {
    /// Estimated number of trials, for the progress display.
    fn total(&self) -> u32 {
        2 + u32::from(self.offload) * 3 + u32::from(self.allow_lossy_kv) + 2 + u32::from(self.expert_cache_mib.is_some())
    }
}

/// What the descent found.
#[derive(Debug)]
struct Found {
    /// The settings to keep (`base` when nothing helped).
    tuning: Tuning,
    baseline: Speeds,
    /// Speeds with `tuning`, as confirmed (the baseline when nothing helped).
    best: Speeds,
    trials: Vec<Trial>,
}

struct Best {
    tuning: Tuning,
    speeds: Speeds,
    answer: String,
}

/// Greedy answers agree on their first 48 tokens' worth of text.
fn same_start(a: &str, b: &str) -> bool {
    let n = 160.min(a.len()).min(b.len());
    n > 0 && a.get(..n) == b.get(..n)
}

struct Descent<'m, M: Measurer> {
    m: &'m mut M,
    trials: Vec<Trial>,
    total: u32,
    baseline: Speeds,
}

impl<M: Measurer> Descent<'_, M> {
    /// Measures `candidate`; a spill below 60 % of the baseline counts as an overflow.
    async fn measure(&mut self, kind: TrialKind, tuning: &Tuning) -> Result<Measure, Stop> {
        self.m.progress(kind, &self.trials, self.total);
        Ok(match self.m.measure(tuning).await? {
            // On Windows an over-full GPU spills into shared memory without an
            // error, and generation collapses (measured: 16.5 instead of 80 tok/s).
            Measure::Ok { speeds, .. } if speeds.gen_tps < self.baseline.gen_tps * SPILL_BELOW => {
                Measure::Overflow(format!("{:.1} tok/s instead of {:.1}", speeds.gen_tps, self.baseline.gen_tps))
            }
            other => other,
        })
    }

    /// Measures `candidate` and keeps it as the new best when it is faster by
    /// `margin` (and, with `same_answer`, answers like the best so far).
    async fn try_candidate(&mut self, kind: TrialKind, candidate: Tuning, best: &mut Best, margin: f64, same_answer: bool) -> Result<(), Stop> {
        let (speeds, outcome, note) = match self.measure(kind, &candidate).await? {
            Measure::Ok { speeds, answer } => {
                let faster = speeds.step_seconds() < best.speeds.step_seconds() * (1.0 - margin);
                let outcome = if !faster {
                    TrialOutcome::Worse
                } else if same_answer && !same_start(&answer, &best.answer) {
                    TrialOutcome::Different
                } else {
                    best.tuning = candidate.clone();
                    best.speeds = speeds;
                    best.answer = answer;
                    TrialOutcome::Better
                };
                (Some(speeds), outcome, None)
            }
            Measure::Overflow(note) => (None, TrialOutcome::Overflow, Some(note)),
            Measure::Failed(note) => (None, TrialOutcome::Failed, Some(note)),
        };
        self.trials.push(Trial { kind, tuning: candidate, speeds, outcome, note });
        Ok(())
    }
}

/// Coordinate descent over the settings, each step from the best so far.
async fn descend(setup: &Setup, m: &mut impl Measurer) -> Result<Found, Stop> {
    let base = setup.base.clone();
    // 1. Today's settings.
    m.progress(TrialKind::Baseline, &[], setup.total());
    let (baseline, answer) = match m.measure(&base).await? {
        Measure::Ok { speeds, answer } => (speeds, answer),
        Measure::Overflow(msg) | Measure::Failed(msg) => return Err(Stop::Failed(msg)),
    };
    let baseline_no_mmap = m.loaded_without_mmap();
    let mut run = Descent {
        m,
        trials: vec![Trial {
            kind: TrialKind::Baseline,
            tuning: base.clone(),
            speeds: Some(baseline),
            outcome: TrialOutcome::Measured,
            note: None,
        }],
        total: setup.total(),
        baseline,
    };
    let mut best = Best {
        tuning: base.clone(),
        speeds: baseline,
        answer,
    };

    // 2. Load mode: where Ylide chose `-lm none`, compare with the mapped file.
    if setup.offload && baseline_no_mmap {
        let candidate = Tuning { no_mmap: Some(false), ..best.tuning.clone() };
        run.try_candidate(TrialKind::LoadMode, candidate, &mut best, KEEP_IF_FASTER, false).await?;
    }

    // 3. A q8_0 KV cache leaves more room for the model, if the user allows it.
    if setup.allow_lossy_kv && base.kv != Some(KvCacheType::Q8_0) && setup.plan_kv != Some(KvCacheType::Q8_0) {
        let candidate = Tuning { kv: Some(KvCacheType::Q8_0), ..best.tuning.clone() };
        run.try_candidate(TrialKind::KvCache, candidate, &mut best, KEEP_IF_FASTER, false).await?;
    }

    // 4. Batch size: smaller first (more VRAM for the model), then larger.
    let current = best.tuning.ubatch.unwrap_or(if setup.moe { 2048 } else { 512 });
    let (smaller, larger) = if setup.moe { (1024, 3072) } else { (current, (current * 2).min(2048)) };
    if smaller < current {
        let candidate = Tuning { ubatch: Some(smaller), ..best.tuning.clone() };
        run.try_candidate(TrialKind::BatchSize, candidate, &mut best, KEEP_IF_FASTER, false).await?;
    }
    if best.tuning.ubatch.is_none_or(|u| u >= current) && larger > current {
        let candidate = Tuning { ubatch: Some(larger), ..best.tuning.clone() };
        run.try_candidate(TrialKind::BatchSize, candidate, &mut best, KEEP_IF_FASTER, false).await?;
    }

    // 5. Generation threads: on the CCD with the largest L3 only, or on every
    //    physical core, pinned. Prompt processing keeps every core.
    if let Some(topo) = setup.topology.as_ref().filter(|_| setup.offload) {
        let all = topo.physical_cpus(None);
        if let Some(group) = topo.largest_l3() {
            let ccd = topo.physical_cpus(Some(&group.cpus));
            if !ccd.is_empty() && ccd.len() < all.len() {
                let candidate = Tuning {
                    threads: Some(ccd.len() as u32),
                    cpu_mask: hardware::cpu_mask(&ccd),
                    cpu_mask_batch: hardware::cpu_mask(&all),
                    ..best.tuning.clone()
                };
                run.try_candidate(TrialKind::Threads, candidate, &mut best, KEEP_IF_FASTER, false).await?;
            }
        }
        if best.tuning.threads.is_none() && !all.is_empty() {
            let candidate = Tuning {
                cpu_mask: hardware::cpu_mask(&all),
                ..best.tuning.clone()
            };
            run.try_candidate(TrialKind::Threads, candidate, &mut best, KEEP_IF_FASTER, false).await?;
        }
    }

    // 6. GPU cache for the experts in RAM: must be clearly faster and answer
    //    exactly like the best so far (degenerate output has been reported).
    if let Some(mib) = setup.expert_cache_mib {
        let candidate = Tuning { moe_cache_mib: Some(mib), ..best.tuning.clone() };
        run.try_candidate(TrialKind::ExpertCache, candidate, &mut best, KEEP_CACHE_IF_FASTER, true).await?;
    }

    // 7. Confirm the winner once; noise must not ship a slower setup.
    let (tuning, final_speeds) = if best.tuning != base {
        let measured = run.measure(TrialKind::Confirm, &best.tuning).await?;
        let (speeds, outcome, note, keep) = match measured {
            Measure::Ok { speeds, .. } => {
                let keep = speeds.step_seconds() < baseline.step_seconds() * 0.99;
                (Some(speeds), if keep { TrialOutcome::Measured } else { TrialOutcome::Worse }, None, keep)
            }
            Measure::Overflow(note) => (None, TrialOutcome::Overflow, Some(note), false),
            Measure::Failed(note) => (None, TrialOutcome::Failed, Some(note), false),
        };
        run.trials.push(Trial { kind: TrialKind::Confirm, tuning: best.tuning.clone(), speeds, outcome, note });
        match speeds {
            Some(s) if keep => (best.tuning, s),
            _ => (base.clone(), baseline),
        }
    } else {
        (base.clone(), baseline)
    };
    Ok(Found {
        tuning,
        baseline,
        best: final_speeds,
        trials: run.trials,
    })
}

/// Runs every trial for the selected model and returns the result (not saved yet).
async fn calibrate(app: &AppHandle, state: &AppState, installed: &InstalledModel, options: CalibrationOptions, cancel: &CancellationToken) -> Result<CalibrationResult, Stop> {
    let plan = crate::commands::plan_for(state, &installed.model_id, &installed.quant);
    let key = key_for(state, installed, plan.as_ref()).ok_or_else(|| Stop::Failed("the model file or runtime is missing".into()))?;
    let settings = state.settings();
    let hw = state.hardware();
    let registry = state.registry();
    let runtime = state.runtime.select(&hw, &registry, &settings).ok_or_else(|| Stop::Failed("no runtime".into()))?;
    let flags = state.runtime.supported_flags(&Path::new(&runtime.dir).join(crate::runtime::SERVER_BINARY)).await;
    let setup = setup_for(plan.as_ref(), Tuning::from_settings(&settings), options, runtime.backend, &flags);
    let mut measurer = AppMeasurer {
        app,
        state,
        installed,
        plan,
        cancel,
        prompt: bench_prompt(),
    };
    let found = descend(&setup, &mut measurer).await?;
    let base = setup.base;
    Ok(CalibrationResult {
        key,
        model_id: installed.model_id.clone(),
        quant: installed.quant.clone(),
        baseline: found.baseline,
        best: found.best,
        // Stored without the user's own KV choice, which applies at start anyway.
        tuning: Tuning {
            kv: found.tuning.kv.filter(|kv| Some(*kv) != base.kv),
            ..found.tuning
        },
        trials: found.trials,
        created_at_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
    })
}

/// The trials that make sense for this plan, runtime and machine.
fn setup_for(plan: Option<&Plan>, base: Tuning, options: CalibrationOptions, backend: Backend, flags: &std::collections::HashSet<String>) -> Setup {
    let placement = plan.map(|p| p.placement);
    let offload = matches!(placement, Some(Placement::MoeOffload { .. } | Placement::PartialOffload { .. }));
    let moe = matches!(placement, Some(Placement::MoeOffload { .. }));
    let expert_cache_mib = (moe && backend == Backend::Cuda && flags.contains("--moe-cache-mib"))
        .then(|| (plan.map_or(0, |p| p.ram_bytes) / 10) >> 20)
        .filter(|mib| *mib >= 512)
        .map(|mib| (mib / 256 * 256) as u32);
    Setup {
        base,
        offload,
        moe,
        plan_kv: plan.map(|p| p.kv_cache_type),
        allow_lossy_kv: options.allow_lossy_kv,
        topology: if offload && flags.contains("-C") { hardware::cpu_topology() } else { None },
        expert_cache_mib,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> CalibrationKey {
        CalibrationKey {
            model_path: "C:/m/model.gguf".into(),
            model_bytes: 21_233_608_512,
            model_modified: 1,
            runtime: "b11669/cuda-13.4".into(),
            gpu: "NVIDIA GeForce RTX 5070 Ti, 16303 MiB, driver 13.3".into(),
            cpu: "AMD Ryzen 9 9950X3D (16C/32T)".into(),
            ram: "63 GiB DDR5-4800".into(),
            context: 131_072,
            slots: 2,
            projector: true,
        }
    }

    #[test]
    fn the_reference_step_weighs_prompt_and_answer() {
        let before = Speeds { prompt_tps: 1390.0, gen_tps: 50.0 };
        let after = Speeds { prompt_tps: 2200.0, gen_tps: 50.0 };
        assert!((before.step_seconds() - (4000.0 / 1390.0 + 8.0)).abs() < 1e-9);
        assert!(after.step_seconds() < before.step_seconds() * (1.0 - KEEP_IF_FASTER), "faster prompt reading counts");
        let noise = Speeds { prompt_tps: 1400.0, gen_tps: 50.3 };
        assert!(noise.step_seconds() > before.step_seconds() * (1.0 - KEEP_IF_FASTER), "noise is not a win");
    }

    #[test]
    fn says_what_changed_since_the_calibration() {
        let a = key();
        assert!(a.changes(&a).is_empty());
        let mut b = a.clone();
        b.ram = "63 GiB DDR5-6000".into();
        b.runtime = "b11700/cuda-13.4".into();
        assert_eq!(a.changes(&b), vec!["runtime", "ram"]);
        let mut c = a.clone();
        c.model_modified = 2;
        assert_eq!(a.changes(&c), vec!["model"]);
    }

    #[test]
    fn results_are_kept_per_model_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calibration.json");
        assert!(load_results(&path).is_empty());
        let result = |model_path: &str, gen_tps: f64| CalibrationResult {
            key: CalibrationKey { model_path: model_path.into(), ..key() },
            model_id: "m".into(),
            quant: "q".into(),
            baseline: Speeds { prompt_tps: 1000.0, gen_tps: 50.0 },
            best: Speeds { prompt_tps: 1500.0, gen_tps },
            tuning: Tuning { ubatch: Some(1024), ..Tuning::default() },
            trials: vec![],
            created_at_unix_ms: 0,
        };
        save_result(&path, result("a.gguf", 55.0)).unwrap();
        save_result(&path, result("b.gguf", 60.0)).unwrap();
        save_result(&path, result("a.gguf", 57.0)).unwrap();
        let all = load_results(&path);
        assert_eq!(all.len(), 2);
        assert_eq!(all.iter().find(|r| r.key.model_path == "a.gguf").unwrap().best.gen_tps, 57.0);
        std::fs::write(&path, "not json").unwrap();
        assert!(load_results(&path).is_empty(), "a broken file means no calibration");
    }

    #[test]
    fn answers_are_compared_by_their_start() {
        assert!(same_start("fn a() { 1 }", "fn a() { 1 }"));
        assert!(!same_start("fn a() { 1 }", "fn a() { 2 }"));
        assert!(!same_start("", ""), "no answer is no evidence");
    }

    #[test]
    fn the_prompt_is_long_enough_and_fixed() {
        let p = bench_prompt();
        assert_eq!(p, bench_prompt());
        // About 3,000 tokens at roughly 4 characters each.
        assert!((10_000..20_000).contains(&p.len()), "{}", p.len());
    }

    /// A measurer that answers from a table instead of starting servers.
    struct Fake<F: FnMut(&Tuning) -> Measure> {
        speeds: F,
        no_mmap: bool,
        progress: std::cell::RefCell<Vec<TrialKind>>,
    }

    impl<F: FnMut(&Tuning) -> Measure> Measurer for Fake<F> {
        async fn measure(&mut self, tuning: &Tuning) -> Result<Measure, Stop> {
            Ok((self.speeds)(tuning))
        }
        fn loaded_without_mmap(&self) -> bool {
            self.no_mmap
        }
        fn progress(&self, current: TrialKind, _trials: &[Trial], _total: u32) {
            self.progress.borrow_mut().push(current);
        }
    }

    fn ok(prompt_tps: f64, gen_tps: f64, answer: &str) -> Measure {
        Measure::Ok {
            speeds: Speeds { prompt_tps, gen_tps },
            answer: answer.into(),
        }
    }

    /// Two CCDs like the 9950X3D: 96 MB L3 on CPUs 0-15, 32 MB on 16-31, SMT siblings adjacent.
    fn two_ccds() -> hardware::CpuTopology {
        hardware::CpuTopology {
            cores: (0..16u32).map(|c| vec![2 * c, 2 * c + 1]).collect(),
            l3: vec![
                hardware::CacheGroup { size_bytes: 96 << 20, cpus: (0..16).collect() },
                hardware::CacheGroup { size_bytes: 32 << 20, cpus: (16..32).collect() },
            ],
        }
    }

    fn moe_setup() -> Setup {
        Setup {
            offload: true,
            moe: true,
            plan_kv: Some(KvCacheType::F16),
            topology: Some(two_ccds()),
            expert_cache_mib: Some(1280),
            ..Setup::default()
        }
    }

    fn run(setup: &Setup, fake: &mut Fake<impl FnMut(&Tuning) -> Measure>) -> Found {
        tauri::async_runtime::block_on(descend(setup, fake)).unwrap_or_else(|e| panic!("{e:?}"))
    }

    #[test]
    fn keeps_clear_wins_and_confirms_them() {
        // The reference PC as measured by hand: mapping costs prompt speed,
        // a smaller batch and the V-Cache CCD win, the expert cache answers differently.
        let mut fake = Fake {
            speeds: |t: &Tuning| match (t.no_mmap, t.ubatch, t.threads, t.moe_cache_mib) {
                (Some(false), ..) => ok(1318.0, 50.0, "a"),
                (_, None, None, None) => ok(2140.0, 50.2, "a"),
                (_, Some(1024), None, None) => ok(2052.0, 53.8, "a"),
                (_, Some(1024), Some(8), None) => ok(2047.0, 56.9, "a"),
                (_, Some(1024), Some(8), Some(_)) => ok(2011.0, 62.0, "b"),
                other => panic!("unexpected trial {other:?}"),
            },
            no_mmap: true,
            progress: Default::default(),
        };
        let found = run(&moe_setup(), &mut fake);
        let kinds: Vec<_> = found.trials.iter().map(|t| (t.kind, t.outcome)).collect();
        use TrialKind::*;
        use TrialOutcome::*;
        assert_eq!(
            kinds,
            vec![(Baseline, Measured), (LoadMode, Worse), (BatchSize, Better), (Threads, Better), (ExpertCache, Different), (Confirm, Measured)]
        );
        assert_eq!(found.tuning.ubatch, Some(1024));
        assert_eq!((found.tuning.threads, found.tuning.cpu_mask.as_deref(), found.tuning.cpu_mask_batch.as_deref()), (Some(8), Some("0x5555"), Some("0x55555555")));
        assert_eq!((found.tuning.no_mmap, found.tuning.moe_cache_mib), (None, None));
        assert_eq!((found.baseline.gen_tps, found.best.gen_tps), (50.2, 56.9));
        assert_eq!(fake.progress.borrow().len(), found.trials.len(), "every trial is announced");
    }

    #[test]
    fn spills_failures_and_noise_never_win() {
        let mut fake = Fake {
            speeds: |t: &Tuning| match (t.ubatch, t.cpu_mask.as_deref()) {
                (None, None) => ok(1400.0, 50.0, "a"),
                // Faster prompts, but generation collapsed: VRAM spilled into shared memory.
                (Some(1024), _) => ok(3000.0, 20.0, "a"),
                (Some(3072), _) => Measure::Failed("exited with code 1".into()),
                (None, Some("0x5555")) => Measure::Overflow("only 300 MiB of VRAM left".into()),
                // 1 % faster: noise.
                (None, Some(_)) => ok(1410.0, 50.4, "a"),
                other => panic!("unexpected trial {other:?}"),
            },
            no_mmap: false,
            progress: Default::default(),
        };
        let setup = Setup { expert_cache_mib: None, ..moe_setup() };
        let found = run(&setup, &mut fake);
        let outcomes: Vec<_> = found.trials.iter().map(|t| t.outcome).collect();
        use TrialOutcome::*;
        assert_eq!(outcomes, vec![Measured, Overflow, Failed, Overflow, Worse], "no load-mode trial without -lm none, no confirmation without a win");
        assert_eq!(found.tuning, Tuning::default());
        assert_eq!(found.best, found.baseline);
    }

    #[test]
    fn a_win_that_does_not_hold_is_dropped() {
        let mut calls = 0;
        let mut fake = Fake {
            speeds: move |t: &Tuning| {
                calls += 1;
                match t.ubatch {
                    None => ok(1000.0, 50.0, "a"),
                    // Faster the first time, back to the baseline in the confirmation.
                    Some(1024) if calls == 2 => ok(1300.0, 50.0, "a"),
                    Some(1024) => ok(1000.0, 50.0, "a"),
                    _ => ok(900.0, 49.0, "a"),
                }
            },
            no_mmap: false,
            progress: Default::default(),
        };
        let setup = Setup { topology: None, expert_cache_mib: None, ..moe_setup() };
        let found = run(&setup, &mut fake);
        assert_eq!(found.trials.last().map(|t| (t.kind, t.outcome)), Some((TrialKind::Confirm, TrialOutcome::Worse)));
        assert_eq!(found.tuning, Tuning::default());
    }

    #[test]
    fn a_dense_model_on_the_gpu_only_tries_the_batch_size() {
        let mut fake = Fake {
            speeds: |t: &Tuning| match t.ubatch {
                None => ok(3000.0, 55.0, "a"),
                Some(1024) => ok(4500.0, 55.0, "a"),
                other => panic!("unexpected batch {other:?}"),
            },
            no_mmap: false,
            progress: Default::default(),
        };
        let setup = Setup {
            topology: Some(two_ccds()),
            plan_kv: Some(KvCacheType::Q8_0),
            allow_lossy_kv: true,
            ..Setup::default()
        };
        let found = run(&setup, &mut fake);
        let kinds: Vec<_> = found.trials.iter().map(|t| t.kind).collect();
        assert_eq!(kinds, vec![TrialKind::Baseline, TrialKind::BatchSize, TrialKind::Confirm], "threads only matter with weights on the CPU; the KV cache is q8_0 already");
        assert_eq!(found.tuning.ubatch, Some(1024));
    }

    /// The calibration's trials on real hardware, without the app (nothing is stored):
    ///
    /// ```text
    /// $env:YLIDE_E2E_MODEL = "<model.gguf>"
    /// $env:YLIDE_E2E_RUNTIME = "<local data>\runtimes\b11669\cuda-13.4"
    /// cargo test -p ylide-desktop --lib calibrate::tests::real_calibration -- --ignored --nocapture
    /// ```
    ///
    /// Optional: `YLIDE_E2E_MMPROJ` (projector file), `YLIDE_E2E_CONTEXT`, `YLIDE_E2E_LOSSY_KV=1`.
    /// Stop the app's own model first: the trials need the GPU.
    #[test]
    #[ignore]
    fn real_calibration() {
        tauri::async_runtime::block_on(real::calibrate_from_env());
    }

    /// MTP speculative decoding with and without, on real hardware: see the `real` module.
    #[test]
    #[ignore]
    fn real_mtp_ab() {
        tauri::async_runtime::block_on(real::mtp_ab_from_env());
    }
}

#[cfg(test)]
mod real {
    //! Runs on real hardware, without the app (nothing is stored). Stop the
    //! app's own model first: these runs need the GPU.
    //!
    //! ```text
    //! $env:YLIDE_E2E_MODEL = "<model.gguf>"
    //! $env:YLIDE_E2E_RUNTIME = "<local data>\runtimes\b11669\cuda-13.4"
    //! cargo test -p ylide-desktop --lib calibrate::tests::real_calibration -- --ignored --nocapture
    //! cargo test -p ylide-desktop --lib calibrate::tests::real_mtp_ab -- --ignored --nocapture
    //! ```
    //!
    //! Optional: `YLIDE_E2E_MMPROJ` (projector), `YLIDE_E2E_CONTEXT`,
    //! `YLIDE_E2E_LOSSY_KV=1`, and for the MTP runs `YLIDE_E2E_MTP_DRAFT`
    //! (an MTP sidecar for `-md`) and `YLIDE_E2E_MTP_ARMS` (e.g. "base,n2,n2np1").
    use super::*;
    use crate::runtime::{LaunchOptions, SERVER_BINARY, backend_of, chat_args, fit_failed, looks_like_oom, parse_help_flags};
    use inference::{LlamaServer, ServerConfig, ServerError};
    use registry::estimate::ComputeBudget;
    use serde_json::{Value, json};
    use std::collections::HashSet;
    use std::time::{Duration, Instant};

    /// The model, runtime and machine from the environment, planned like the app does.
    struct Env {
        binary: PathBuf,
        flags: HashSet<String>,
        model_path: String,
        model: Option<registry::Model>,
        plan: Option<Plan>,
        context: u32,
        device: Option<String>,
        backend: Backend,
        hw: HardwareProfile,
        projector: Option<String>,
        run_dir: tempfile::TempDir,
    }

    impl Env {
        async fn from_env() -> Self {
            let model_path = PathBuf::from(std::env::var_os("YLIDE_E2E_MODEL").expect("set YLIDE_E2E_MODEL to a GGUF file"));
            let runtime = PathBuf::from(std::env::var_os("YLIDE_E2E_RUNTIME").expect("set YLIDE_E2E_RUNTIME to a runtime folder"));
            let binary = runtime.join(SERVER_BINARY);
            let help = tokio::process::Command::new(&binary).arg("--help").output().await.unwrap();
            let flags = parse_help_flags(&String::from_utf8_lossy(&help.stdout));
            let hw = hardware::probe(None);
            let reg = registry::bundled();
            let file_name = model_path.file_name().unwrap().to_string_lossy().to_string();
            // An -mtp twin is planned like the plain file of the same variant.
            let plain = file_name.replace("-mtp.gguf", ".gguf");
            let found = reg.models.iter().find_map(|m| m.variants.iter().find(|v| v.files.iter().any(|f| f.path == file_name || f.path == plain)).map(|v| (m.clone(), v.clone())));
            let projector = std::env::var("YLIDE_E2E_MMPROJ").ok();
            let projector_bytes = projector.as_ref().and_then(|p| std::fs::metadata(p).ok()).map_or(0, |m| m.len());
            let budget = ComputeBudget::from_profile(&hw, &reg.gpu_hints);
            // As plan_for: the largest context that fits, F16 KV before q8_0.
            let plan = found.as_ref().and_then(|(model, variant)| {
                let mut contexts = vec![model.context.recommended, 65_536, 32_768, 16_384, 8_192];
                contexts.retain(|c| *c <= model.context.max);
                contexts.into_iter().find_map(|c| {
                    [KvCacheType::F16, KvCacheType::Q8_0]
                        .into_iter()
                        .find_map(|kv| registry::estimate::plan_with_projector(model, variant, projector_bytes, c, kv, &budget))
                })
            });
            let context = std::env::var("YLIDE_E2E_CONTEXT").ok().and_then(|c| c.parse().ok()).or(plan.as_ref().map(|p| p.context)).unwrap_or(32_768);
            let devices = inference::list_devices(&binary).await.unwrap_or_default();
            let gpu_name = hw.primary_gpu().map(|g| g.name.to_lowercase()).unwrap_or_default();
            let device = devices.iter().find(|d| d.description.to_lowercase().contains(&gpu_name)).map(|d| d.id.clone());
            let backend = backend_of(&runtime.file_name().unwrap_or_default().to_string_lossy());
            println!(
                "model {file_name} ({:?}), plan {:?}, context {context}, device {device:?}",
                found.as_ref().map(|(m, _)| &m.id),
                plan.as_ref().map(|p| (p.placement, p.kv_cache_type, p.ram_bytes >> 20))
            );
            Self {
                binary,
                flags,
                model_path: model_path.display().to_string(),
                model: found.map(|(m, _)| m),
                plan,
                context,
                device,
                backend,
                hw,
                projector,
                run_dir: tempfile::tempdir().unwrap(),
            }
        }

        /// Starts llama-server like the app, with `extra` arguments last.
        async fn start(&self, tuning: &Tuning, extra: &[String], slots: u32) -> Result<(LlamaServer, Vec<String>), Measure> {
            let o = LaunchOptions {
                model_path: &self.model_path,
                model: self.model.as_ref(),
                context: self.context,
                slots,
                plan: self.plan.as_ref(),
                threads: self.hw.cpu.physical_cores,
                ram_total: self.hw.memory.total_bytes,
                ram_available: hardware::available_memory(),
                device: self.device.clone(),
                extra,
                runtime_backend: self.backend,
                projector: self.projector.as_deref(),
                tuning: Some(tuning),
            };
            let args = chat_args(&o, &self.flags);
            println!("\n$ llama-server {}", args.join(" "));
            let started = Instant::now();
            let config = ServerConfig {
                binary: self.binary.clone(),
                args: args.clone(),
                env: vec![],
                ready_timeout: Duration::from_secs(300),
                pid_file: Some(self.run_dir.path().join("chat.pid")),
                key_dir: Some(self.run_dir.path().to_path_buf()),
            };
            let mut server = match LlamaServer::start(config, |_| {}).await {
                Ok(s) => s,
                Err(ServerError::Exited { log_tail, .. }) if looks_like_oom(&log_tail) => return Err(Measure::Overflow("out of memory".into())),
                Err(ServerError::Exited { log_tail, .. }) => return Err(Measure::Failed(log_tail.lines().rev().take(6).collect::<Vec<_>>().join(" | "))),
                Err(e) => return Err(Measure::Failed(e.to_string())),
            };
            println!("  loaded in {:.1} s", started.elapsed().as_secs_f64());
            if fit_failed(&server.logs().lines()) {
                server.stop().await;
                return Err(Measure::Overflow("fit failed".into()));
            }
            Ok((server, args))
        }
    }

    struct Bare {
        env: Env,
        prompt: String,
        last_args: Vec<String>,
        cancel: CancellationToken,
    }

    impl Measurer for Bare {
        async fn measure(&mut self, tuning: &Tuning) -> Result<Measure, Stop> {
            let (mut server, args) = match self.env.start(tuning, &[], 2).await {
                Ok(s) => s,
                Err(m) => return Ok(m),
            };
            self.last_args = args;
            let m = measure_server(&server.client(), &self.prompt, &self.cancel).await;
            if let Ok(Measure::Ok { speeds, .. }) = &m {
                println!("  prompt {:.0} tok/s, answer {:.1} tok/s", speeds.prompt_tps, speeds.gen_tps);
            }
            server.stop().await;
            m
        }

        fn loaded_without_mmap(&self) -> bool {
            no_mmap_in(&self.last_args)
        }

        fn progress(&self, current: TrialKind, _trials: &[Trial], _total: u32) {
            println!("\n== {current:?}");
        }
    }

    pub(super) async fn calibrate_from_env() {
        let env = Env::from_env().await;
        let options = CalibrationOptions {
            allow_lossy_kv: std::env::var("YLIDE_E2E_LOSSY_KV").is_ok_and(|v| v == "1"),
        };
        let setup = setup_for(env.plan.as_ref(), Tuning::default(), options, env.backend, &env.flags);
        println!("trials: offload {}, moe {}, topology {}, expert cache {:?}", setup.offload, setup.moe, setup.topology.is_some(), setup.expert_cache_mib);
        let mut bare = Bare {
            env,
            prompt: bench_prompt(),
            last_args: vec![],
            cancel: CancellationToken::new(),
        };
        let started = Instant::now();
        let found = descend(&setup, &mut bare).await.unwrap_or_else(|e| panic!("{e:?}"));
        println!("\n=== {:.0} s", started.elapsed().as_secs_f64());
        for t in &found.trials {
            let speeds = t.speeds.map_or("-".to_string(), |s| format!("prompt {:7.0}  answer {:5.1}", s.prompt_tps, s.gen_tps));
            println!("{:<12} {:<10} {speeds}  {:?} {}", format!("{:?}", t.kind), format!("{:?}", t.outcome), t.tuning, t.note.clone().unwrap_or_default());
        }
        println!("before: prompt {:.0} tok/s, answer {:.1} tok/s", found.baseline.prompt_tps, found.baseline.gen_tps);
        println!("after:  prompt {:.0} tok/s, answer {:.1} tok/s with {:?}", found.best.prompt_tps, found.best.gen_tps, found.tuning);
    }

    // ------------------------------------------------------------- MTP A/B

    /// One chat completion's result.
    #[derive(Debug, Default, Clone)]
    struct Run {
        text: String,
        prompt_tokens: u64,
        prompt_tps: f64,
        tokens: u64,
        tps: f64,
        drafted: u64,
        accepted: u64,
    }

    async fn chat(server: &LlamaServer, prompt: &str, max_tokens: u32, sampling: &Value) -> Result<Run, String> {
        let endpoint = server.endpoint();
        let mut body = json!({
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "stream": false,
            "cache_prompt": false,
        });
        for (k, v) in sampling.as_object().unwrap() {
            body[k] = v.clone();
        }
        let mut rb = reqwest::Client::builder().no_proxy().build().unwrap().post(format!("{}/v1/chat/completions", endpoint.base_url)).json(&body).timeout(Duration::from_secs(900));
        if let Some(key) = &endpoint.api_key {
            rb = rb.bearer_auth(key);
        }
        let v: Value = rb.send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        let t = &v["timings"];
        let msg = &v["choices"][0]["message"];
        Ok(Run {
            text: format!("{}{}", msg["reasoning_content"].as_str().unwrap_or_default(), msg["content"].as_str().unwrap_or_default()),
            prompt_tokens: t["prompt_n"].as_u64().unwrap_or(0),
            prompt_tps: t["prompt_per_second"].as_f64().unwrap_or(0.0),
            tokens: t["predicted_n"].as_u64().unwrap_or(0),
            tps: t["predicted_per_second"].as_f64().unwrap_or(0.0),
            drafted: t["draft_n"].as_u64().unwrap_or(0),
            accepted: t["draft_n_accepted"].as_u64().unwrap_or(0),
        })
    }

    fn acceptance(r: &Run) -> String {
        if r.drafted == 0 { "-".into() } else { format!("{:.0} %", 100.0 * r.accepted as f64 / r.drafted as f64) }
    }

    /// Phase 0 of the MTP plan: the same workloads with and without
    /// `--spec-type draft-mtp`, as Ylide would run them.
    pub(super) async fn mtp_ab_from_env() {
        let env = Env::from_env().await;
        let draft = std::env::var("YLIDE_E2E_MTP_DRAFT").ok();
        let arms_filter = std::env::var("YLIDE_E2E_MTP_ARMS").ok();
        let mtp = |n: u32| -> Vec<String> {
            let mut a: Vec<String> = ["--spec-type", "draft-mtp", "--spec-draft-n-max", &n.to_string(), "--spec-draft-sampling", "probabilistic"].map(String::from).to_vec();
            if let Some(d) = &draft {
                a.extend(["-md".to_string(), d.clone()]);
            }
            a
        };
        // (name, extra arguments, slots)
        let all_arms: Vec<(&str, Vec<String>, u32)> = vec![
            ("base", vec![], 2),
            ("n2", mtp(2), 2),
            ("n3", mtp(3), 2),
            ("n1", mtp(1), 2),
            ("base-np1", vec![], 1),
            ("n2-np1", mtp(2), 1),
        ];
        let arms: Vec<_> = all_arms.into_iter().filter(|(name, ..)| arms_filter.as_ref().is_none_or(|f| f.split(',').any(|a| a == *name))).collect();
        let agent = env.model.as_ref().and_then(|m| m.request_defaults.as_ref()).and_then(|d| d.agent.clone());
        let mut sampling = json!({});
        if let Some(a) = &agent {
            for (k, v) in [("temperature", a.temperature.map(Value::from)), ("top_p", a.top_p.map(Value::from)), ("top_k", a.top_k.map(Value::from)), ("min_p", a.min_p.map(Value::from)), ("presence_penalty", a.presence_penalty.map(Value::from))] {
                if let Some(v) = v {
                    sampling[k] = v;
                }
            }
            if let Some(kw) = &a.template_kwargs {
                sampling["chat_template_kwargs"] = kw.clone();
            }
        }
        let greedy = {
            let mut g = sampling.clone();
            g["temperature"] = json!(0.0);
            g["top_k"] = json!(1);
            g
        };
        println!("sampling {sampling}");
        let code = "Write a Rust module with a function `parse_csv_line(line: &str) -> Vec<String>` that handles quoted fields with escaped quotes, plus five unit tests. Only code.";
        let edit = format!("{}\nRewrite the first 25 functions above with `cost_` instead of `price_` in their names. Output only the code.", bench_prompt());
        let prose = "Erkläre einem Einsteiger in etwa 250 Wörtern, was ein Mixture-of-Experts-Sprachmodell ist und warum es auf normalen PCs schnell laufen kann.";
        let long = format!("{}\nHow many functions are defined above? Answer with one number.", bench_prompt().repeat(8));

        let mut table = Vec::new();
        let mut greedy_texts: Vec<(String, String)> = Vec::new();
        for (name, extra, slots) in &arms {
            let (server, _) = match env.start(&Tuning::default(), extra, *slots).await {
                Ok(s) => s,
                Err(m) => {
                    println!("  {name}: {m:?}");
                    table.push(format!("{name:<9} did not start: {m:?}"));
                    continue;
                }
            };
            let free = tokio::task::spawn_blocking(|| hardware::probe(None).primary_gpu().and_then(|g| g.vram_free_bytes)).await.ok().flatten();
            let _ = chat(&server, "Hello", 8, &greedy).await; // warm-up
            let mut row = format!("{name:<9} free VRAM {:>5} MiB |", free.map_or(0, |f| f >> 20));
            for (label, prompt, max) in [("code", code.to_string(), 512u32), ("edit", edit.clone(), 512), ("prose", prose.to_string(), 512)] {
                match chat(&server, &prompt, max, &sampling).await {
                    Ok(r) => {
                        println!("  {label}: {} tokens at {:.1} tok/s, prompt {:.0} tok/s, accepted {}", r.tokens, r.tps, r.prompt_tps, acceptance(&r));
                        row.push_str(&format!(" {label} {:>5.1} tok/s ({})", r.tps, acceptance(&r)));
                    }
                    Err(e) => row.push_str(&format!(" {label} error {e}")),
                }
            }
            match chat(&server, &long, 16, &greedy).await {
                Ok(r) => row.push_str(&format!(" | prefill {} tokens {:>6.0} tok/s", r.prompt_tokens, r.prompt_tps)),
                Err(e) => row.push_str(&format!(" | prefill error {e}")),
            }
            if *slots >= 2 {
                // Two agents at once with long prompts (llama.cpp #27572: acceptance drops to 0).
                let second = format!("// second\n{edit}");
                let (a, b) = tokio::join!(chat(&server, &edit, 256, &sampling), chat(&server, &second, 256, &sampling));
                match (a, b) {
                    (Ok(a), Ok(b)) => row.push_str(&format!(" | parallel {:.1}+{:.1} tok/s ({}, {})", a.tps, b.tps, acceptance(&a), acceptance(&b))),
                    (a, b) => row.push_str(&format!(" | parallel error {:?} {:?}", a.err(), b.err())),
                }
            }
            if *slots == 1 {
                match chat(&server, code, 160, &greedy).await {
                    Ok(r) => greedy_texts.push((name.to_string(), r.text)),
                    Err(e) => println!("  greedy: {e}"),
                }
            }
            println!("{row}");
            table.push(row);
            let mut server = server;
            server.stop().await;
        }
        println!("\n=== MTP A/B");
        for row in &table {
            println!("{row}");
        }
        if let [(a, ta), (b, tb), ..] = greedy_texts.as_slice() {
            println!("greedy output {a} vs {b}: {}", if ta == tb { "identical".to_string() } else { format!("DIFFERENT\n--- {a}\n{ta}\n--- {b}\n{tb}") });
        }
    }
}
