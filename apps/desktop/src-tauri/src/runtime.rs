//! llama.cpp runtimes (one folder per backend) and the managed chat server.
//!
//! * Bundled runtimes (CPU, Vulkan) ship with the installer; others (CUDA, ROCm)
//!   are downloaded on request into `<data>/runtimes/<build>/<variant>/`.
//! * Optional flags (`--fit`, `--cache-ram`, `--metrics`, ...) are only passed
//!   when the installed build lists them in `--help`. `-kvu`, `-fa`, `-dev none`
//!   and the registry's per-model arguments are checked against that list when
//!   there is one (an empty `--help` passes them unchecked); long-standing flags
//!   always are passed (see docs/architecture.md, "Launch flags").
//! * The server is started for the primary GPU (`-dev`), not an iGPU next to it.

use crate::error::{AppError, AppResult};
use crate::models::InstalledModel;
use crate::network::{NetPurpose, NetworkGate};
use crate::settings::Settings;
use downloader::{Downloader, FileSpec, Progress};
use hardware::{Backend, HardwareProfile};
use inference::{Endpoint, LlamaServer, LlmClient, Scheduler, ServerConfig, ServerError, ServerStatus};
use registry::estimate::{KvCacheType, Placement, Plan};
use registry::{Model, Registry};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

#[cfg(windows)]
pub const SERVER_BINARY: &str = "llama-server.exe";
#[cfg(not(windows))]
pub const SERVER_BINARY: &str = "llama-server";

/// License texts of llama.cpp and the libraries its builds link in, which the release archives
/// leave out. scripts/fetch-runtime.mjs checks them against the pinned release and writes them
/// next to the bundled builds; downloaded builds get them on extraction.
const RUNTIME_LICENSES: [(&str, &str); 4] = [
    ("LICENSE-llama.cpp", include_str!("../licenses/LICENSE-llama.cpp")),
    ("LICENSE-httplib", include_str!("../licenses/LICENSE-httplib")),
    ("LICENSE-jsonhpp", include_str!("../licenses/LICENSE-jsonhpp")),
    ("LICENSE-BoringSSL", include_str!("../licenses/LICENSE-BoringSSL")),
];

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuntimeInfo {
    /// Folder name, e.g. "vulkan", "cuda-13.4", "cpu".
    pub variant: String,
    pub backend: Backend,
    pub version: String,
    pub dir: String,
    pub bundled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DownloadableRuntime {
    pub variant: String,
    pub backend: Backend,
    pub version: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// Best choice for this machine (e.g. CUDA on NVIDIA).
    pub recommended: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "state")]
#[ts(export)]
pub enum InstallState {
    Downloading { progress: Option<Progress> },
    Extracting,
    Done,
    Failed { message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuntimeInstall {
    pub variant: String,
    pub state: InstallState,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuntimeStatus {
    pub installed: Vec<RuntimeInfo>,
    pub downloadable: Vec<DownloadableRuntime>,
    /// Variant that will be used for the next start.
    pub selected: Option<String>,
    pub install: Option<RuntimeInstall>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ToolCallSupport {
    Unknown,
    /// The server returned a structured `tool_calls` array.
    Native,
    /// Tool calls arrived as text and were repaired by Ylide.
    Repaired,
    Failed,
}

/// Whether the running model can see images.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum VisionState {
    /// Image input is switched off for this model (or it has none).
    Off,
    /// The vision projector is loaded.
    On,
    /// Image input is on, but the projector file is gone: started without it.
    Missing,
    /// The server did not start with the projector: started without it.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerInfo {
    pub model_id: String,
    pub quant: String,
    pub model_name: String,
    /// Runtime variant, or "external" for a user-configured endpoint.
    pub runtime: String,
    pub device: Option<String>,
    pub context: u32,
    pub slots: u32,
    pub status: ServerStatus,
    pub tool_calls: ToolCallSupport,
    pub vision: VisionState,
    /// The exact command line (without the API key), for transparency.
    pub command: Vec<String>,
}

/// What request handlers need to talk to the active model.
#[derive(Clone)]
pub struct ChatHandle {
    pub client: LlmClient,
    pub scheduler: Scheduler,
    pub model: Option<Model>,
    pub context: u32,
    pub pin_slot: bool,
    /// The vision projector is loaded: requests may carry images.
    pub vision: bool,
}

struct Running {
    server: Option<LlamaServer>,
    handle: ChatHandle,
}

pub struct RuntimeManager {
    runtimes_dir: PathBuf,
    bundled: Vec<PathBuf>,
    run_dir: PathBuf,
    chat: tokio::sync::Mutex<Option<Running>>,
    info: Arc<Mutex<Option<ServerInfo>>>,
    help_cache: Mutex<HashMap<PathBuf, Arc<HashSet<String>>>>,
    install: Arc<Mutex<Option<RuntimeInstall>>>,
}

pub fn backend_of(variant: &str) -> Backend {
    let v = variant.to_lowercase();
    if v.starts_with("cuda") {
        Backend::Cuda
    } else if v.starts_with("vulkan") {
        Backend::Vulkan
    } else if v.starts_with("metal") {
        Backend::Metal
    } else if v.starts_with("rocm") || v.starts_with("hip") {
        Backend::Rocm
    } else {
        Backend::Cpu
    }
}

fn os_name() -> &'static str {
    std::env::consts::OS
}

fn arch_name() -> &'static str {
    std::env::consts::ARCH
}

/// Parses "13.3" into (13, 3).
fn version_pair(v: &str) -> (u32, u32) {
    let mut it = v.split('.').map(|p| p.trim().parse::<u32>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0))
}

/// Can this machine's NVIDIA driver run a CUDA build that needs `min_driver`?
pub fn cuda_driver_ok(hw: &HardwareProfile, min_driver: Option<&str>) -> bool {
    let Some(driver) = hw.acceleration.cuda_driver.as_deref() else { return false };
    min_driver.is_none_or(|min| version_pair(driver) >= version_pair(min))
}

impl RuntimeManager {
    pub fn new(runtimes_dir: PathBuf, bundled: Vec<PathBuf>, run_dir: PathBuf) -> Self {
        Self {
            runtimes_dir,
            bundled,
            run_dir,
            chat: tokio::sync::Mutex::new(None),
            info: Arc::new(Mutex::new(None)),
            help_cache: Mutex::default(),
            install: Arc::default(),
        }
    }

    /// All runtimes found on disk (bundled first).
    pub fn installed(&self) -> Vec<RuntimeInfo> {
        let mut out = Vec::new();
        for base in &self.bundled {
            let version = std::fs::read_to_string(base.join("version.txt")).unwrap_or_default().trim().to_string();
            for (variant, dir) in subdirs_with_server(base) {
                out.push(RuntimeInfo {
                    backend: backend_of(&variant),
                    variant,
                    version: version.clone(),
                    dir: dir.display().to_string(),
                    bundled: true,
                });
            }
        }
        if let Ok(versions) = std::fs::read_dir(&self.runtimes_dir) {
            for v in versions.flatten().filter(|e| e.path().is_dir()) {
                let version = v.file_name().to_string_lossy().into_owned();
                for (variant, dir) in subdirs_with_server(&v.path()) {
                    if out.iter().any(|r| r.variant == variant && r.version == version) {
                        continue;
                    }
                    out.push(RuntimeInfo {
                        backend: backend_of(&variant),
                        variant,
                        version: version.clone(),
                        dir: dir.display().to_string(),
                        bundled: false,
                    });
                }
            }
        }
        out
    }

    /// Picks the runtime for this machine: user override, then CUDA (if the
    /// driver is new enough), ROCm/Metal, Vulkan, CPU.
    pub fn select(&self, hw: &HardwareProfile, registry: &Registry, settings: &Settings) -> Option<RuntimeInfo> {
        let installed = self.installed();
        if let Some(v) = &settings.models.runtime_variant
            && let Some(r) = installed.iter().find(|r| &r.variant == v)
        {
            return Some(r.clone());
        }
        let min_driver = |variant: &str| {
            registry
                .runtimes
                .iter()
                .flat_map(|rt| &rt.assets)
                .find(|a| a.variant == variant && a.os == os_name())
                .and_then(|a| a.min_cuda_driver.clone())
        };
        for backend in hw.preferred_backends() {
            let mut candidates: Vec<&RuntimeInfo> = installed.iter().filter(|r| r.backend == backend).collect();
            if backend == Backend::Cuda {
                candidates.retain(|r| cuda_driver_ok(hw, min_driver(&r.variant).as_deref()));
            }
            // Newest variant first (cuda-13.4 before cuda-12.4).
            candidates.sort_by(|a, b| b.variant.cmp(&a.variant));
            if let Some(r) = candidates.first() {
                return Some((*r).clone());
            }
        }
        installed.into_iter().find(|r| r.backend == Backend::Cpu)
    }

    pub fn status(&self, hw: Option<&HardwareProfile>, registry: &Registry, settings: &Settings) -> RuntimeStatus {
        let installed = self.installed();
        let selected = hw.and_then(|hw| self.select(hw, registry, settings)).map(|r| r.variant);
        let mut downloadable = Vec::new();
        for rt in &registry.runtimes {
            for asset in rt.assets.iter().filter(|a| a.os == os_name() && a.arch == arch_name() && !a.bundled) {
                if installed.iter().any(|r| r.variant == asset.variant) {
                    continue;
                }
                let recommended = hw.is_some_and(|hw| {
                    asset.backend == Backend::Cuda
                        && hw.primary_gpu().is_some_and(|g| g.vendor == hardware::GpuVendor::Nvidia)
                        && cuda_driver_ok(hw, asset.min_cuda_driver.as_deref())
                        && !installed.iter().any(|r| r.backend == Backend::Cuda)
                });
                downloadable.push(DownloadableRuntime {
                    variant: asset.variant.clone(),
                    backend: asset.backend,
                    version: rt.version.clone(),
                    size_bytes: asset.files.iter().map(|f| f.size_bytes).sum(),
                    recommended,
                });
            }
        }
        // Only the newest matching CUDA build is recommended.
        let mut seen_recommended = false;
        for d in downloadable.iter_mut() {
            if d.recommended && seen_recommended {
                d.recommended = false;
            }
            seen_recommended |= d.recommended;
        }
        RuntimeStatus {
            installed,
            downloadable,
            selected,
            install: self.install.lock().unwrap().clone(),
        }
    }

    /// Downloads and unpacks a runtime variant from the registry (checksums verified).
    pub fn start_install(&self, app: &AppHandle, gate: Arc<NetworkGate>, registry: &Registry, variant: &str) -> AppResult<()> {
        let (rt, asset) = registry
            .runtimes
            .iter()
            .flat_map(|rt| rt.assets.iter().map(move |a| (rt, a)))
            .find(|(_, a)| a.variant == variant && a.os == os_name() && a.arch == arch_name())
            .ok_or_else(|| AppError::new("unknown_runtime", variant))?;
        if let Some(job) = self.install.lock().unwrap().as_ref()
            && matches!(job.state, InstallState::Downloading { .. } | InstallState::Extracting)
        {
            return Err(AppError::new("busy", format!("{} is already being installed", job.variant)));
        }
        let version_dir = self.runtimes_dir.join(&rt.version);
        let target = version_dir.join(&asset.variant);
        let downloads = version_dir.join("_downloads");
        let specs: Vec<FileSpec> = asset
            .files
            .iter()
            .map(|f| FileSpec {
                url: f.url.clone(),
                dest: downloads.join(f.url.rsplit('/').next().unwrap_or("runtime.zip")),
                size_bytes: f.size_bytes,
                sha256: f.sha256.clone(),
            })
            .collect();
        let job = Arc::clone(&self.install);
        let variant_name = asset.variant.clone();
        let set = move |app: &AppHandle, state: InstallState| {
            let snapshot = RuntimeInstall {
                variant: variant_name.clone(),
                state,
            };
            *job.lock().unwrap() = Some(snapshot.clone());
            let _ = app.emit("runtime://install", &snapshot);
        };
        set(app, InstallState::Downloading { progress: None });
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let audit = gate.clone();
            let dl = Downloader::new(gate.client()).with_audit(Arc::new(move |url: &str| audit.record(NetPurpose::RuntimeDownload, url, "requested")));
            let cancel = CancellationToken::new();
            let app2 = app.clone();
            let result = dl
                .download("runtime", &specs, &cancel, |p| set(&app2, InstallState::Downloading { progress: Some(p) }))
                .await;
            if let Err(e) = result {
                gate.record(NetPurpose::RuntimeDownload, &specs[0].url, format!("failed: {e}"));
                set(&app, InstallState::Failed { message: e.to_string() });
                return;
            }
            set(&app, InstallState::Extracting);
            let target_dir = target.clone();
            let archives: Vec<PathBuf> = specs.iter().map(|s| s.dest.clone()).collect();
            let extracted = tokio::task::spawn_blocking(move || -> AppResult<()> {
                let _ = std::fs::remove_dir_all(&target_dir);
                std::fs::create_dir_all(&target_dir)?;
                for a in &archives {
                    extract_archive(a, &target_dir)?;
                }
                flatten_single_subdir(&target_dir)?;
                if !target_dir.join(SERVER_BINARY).exists() {
                    return Err(AppError::new("runtime_invalid", format!("{SERVER_BINARY} missing after extraction")));
                }
                write_runtime_licenses(&target_dir)?;
                for a in &archives {
                    let _ = std::fs::remove_file(a);
                }
                Ok(())
            })
            .await
            .unwrap_or_else(|e| Err(AppError::new("runtime_invalid", e)));
            match extracted {
                Ok(()) => {
                    gate.record(NetPurpose::RuntimeDownload, &specs[0].url, "installed, checksums verified");
                    set(&app, InstallState::Done);
                }
                Err(e) => set(&app, InstallState::Failed { message: e.message }),
            }
        });
        Ok(())
    }

    /// Flags the binary understands (parsed from `--help`, cached per binary).
    pub async fn supported_flags(&self, binary: &Path) -> Arc<HashSet<String>> {
        if let Some(f) = self.help_cache.lock().unwrap().get(binary) {
            return f.clone();
        }
        let mut cmd = tokio::process::Command::new(binary);
        cmd.arg("--help").stdin(std::process::Stdio::null()).kill_on_drop(true);
        if let Some(dir) = binary.parent() {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let text = match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
            Ok(Ok(out)) => format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)),
            _ => String::new(),
        };
        let flags = Arc::new(parse_help_flags(&text));
        self.help_cache.lock().unwrap().insert(binary.to_path_buf(), flags.clone());
        flags
    }

    /// Output of the running llama-server (for the "server log" view).
    pub async fn logs(&self) -> Vec<String> {
        let guard = self.chat.lock().await;
        guard.as_ref().and_then(|r| r.server.as_ref()).map(|s| s.logs().lines()).unwrap_or_default()
    }

    fn info_handle(&self) -> Arc<Mutex<Option<ServerInfo>>> {
        self.info.clone()
    }

    pub fn info(&self) -> Option<ServerInfo> {
        self.info.lock().unwrap().clone()
    }

    fn set_info(&self, app: &AppHandle, info: Option<ServerInfo>) {
        *self.info.lock().unwrap() = info.clone();
        let _ = app.emit("runtime://server", &info);
    }

    /// Handle for chat/inline/agent requests, if a model is ready.
    pub async fn chat_handle(&self) -> Option<ChatHandle> {
        let guard = self.chat.lock().await;
        let running = guard.as_ref()?;
        let ready = running.server.as_ref().is_none_or(|s| matches!(s.status(), ServerStatus::Ready));
        ready.then(|| running.handle.clone())
    }

    pub async fn stop(&self, app: &AppHandle) {
        let mut guard = self.chat.lock().await;
        if let Some(mut running) = guard.take()
            && let Some(server) = running.server.as_mut()
        {
            server.stop().await;
        }
        self.set_info(app, None);
    }

    /// Connects to a user-configured OpenAI-compatible endpoint instead of llama-server.
    pub async fn use_external(&self, app: &AppHandle, settings: &Settings) -> AppResult<ServerInfo> {
        self.stop(app).await;
        let ep = &settings.endpoint;
        let client = LlmClient::new(Endpoint {
            base_url: ep.base_url.trim_end_matches('/').to_string(),
            api_key: ep.api_key.clone().filter(|k| !k.is_empty()),
            model: ep.model.clone().filter(|m| !m.is_empty()),
        });
        let status = match client.health().await {
            inference::Health::Ready => ServerStatus::Ready,
            // Many servers have no /health; try listing models instead.
            _ if client.models().await.is_ok() => ServerStatus::Ready,
            _ => ServerStatus::Crashed {
                code: None,
                message: format!("{} is not reachable", ep.base_url),
            },
        };
        let context = ep.context.unwrap_or(32_768);
        let info = ServerInfo {
            model_id: ep.model.clone().unwrap_or_else(|| "external".into()),
            quant: String::new(),
            model_name: ep.model.clone().unwrap_or_else(|| ep.base_url.clone()),
            runtime: "external".into(),
            device: None,
            context,
            slots: settings.models.slots.max(1),
            status: status.clone(),
            tool_calls: ToolCallSupport::Unknown,
            vision: VisionState::Off,
            command: vec![],
        };
        let handle = ChatHandle {
            client,
            scheduler: Scheduler::new(settings.models.slots.max(1) as usize),
            model: None,
            context,
            pin_slot: false,
            vision: false,
        };
        *self.chat.lock().await = Some(Running {
            server: None,
            handle,
        });
        self.set_info(app, Some(info.clone()));
        if let ServerStatus::Crashed { message, .. } = status {
            return Err(AppError::new("endpoint_unreachable", message));
        }
        Ok(info)
    }

    /// Starts llama-server for an installed model.
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        app: &AppHandle,
        hw: &HardwareProfile,
        registry: &Registry,
        settings: &Settings,
        installed: &InstalledModel,
        plan: Option<Plan>,
    ) -> AppResult<ServerInfo> {
        self.stop(app).await;
        let runtime = self
            .select(hw, registry, settings)
            .ok_or_else(|| AppError::new("no_runtime", "no llama.cpp runtime is installed"))?;
        let binary = Path::new(&runtime.dir).join(SERVER_BINARY);
        let mut flags = self.supported_flags(&binary).await;
        let device = pick_device(&binary, &runtime, hw).await;
        let model = registry.models.iter().find(|m| m.id == installed.model_id).cloned();
        let model_path = installed.primary_path().ok_or_else(|| AppError::new("not_found", "model file"))?.to_string();

        let mut context = settings
            .models
            .context
            .or_else(|| plan.as_ref().map(|p| p.context))
            .or_else(|| model.as_ref().map(|m| m.context.recommended.min(32_768)))
            .unwrap_or(16_384);
        let slots = settings.models.slots.clamp(1, 8);
        let extra = &settings.models.extra_args;
        if uses_fit(&flags, runtime.backend, plan.as_ref())
            && let Some(flag) = fit_blocker(extra)
        {
            tracing::warn!("{flag} in the extra llama-server arguments keeps llama.cpp from fitting the model; using the estimated GPU split");
        }
        let fit_fallback = refit_possible(&flags, runtime.backend, plan.as_ref(), extra);
        let mut refitted = false;
        let mut oom_retries = 0;
        // Image input: the projector if its file is there, else a start without it.
        let (mut projector, mut vision) = match &installed.projector {
            Some(p) if Path::new(&p.path).is_file() => (Some(p.clone()), VisionState::On),
            Some(p) => {
                tracing::warn!("the vision projector {} is missing; starting without image input", p.path);
                let _ = app.emit("runtime://log", PROJECTOR_MISSING_NOTE);
                (None, VisionState::Missing)
            }
            None => (None, VisionState::Off),
        };

        loop {
            let launch = LaunchOptions {
                model_path: &model_path,
                model: model.as_ref(),
                context,
                slots,
                plan: plan.as_ref(),
                threads: hw.cpu.physical_cores.max(1),
                ram_total: hw.memory.total_bytes,
                device: device.clone(),
                extra,
                runtime_backend: runtime.backend,
                projector: projector.as_ref().map(|p| p.path.as_str()),
            };
            let args = chat_args(&launch, &flags);
            let mut info = ServerInfo {
                model_id: installed.model_id.clone(),
                quant: installed.quant.clone(),
                model_name: installed.name.clone(),
                runtime: runtime.variant.clone(),
                device: device.clone(),
                context,
                slots,
                status: ServerStatus::Starting,
                tool_calls: ToolCallSupport::Unknown,
                vision,
                command: std::iter::once(binary.display().to_string()).chain(args.iter().cloned()).collect(),
            };
            self.set_info(app, Some(info.clone()));
            let log_app = app.clone();
            let result = LlamaServer::start(
                ServerConfig {
                    binary: binary.clone(),
                    args,
                    env: vec![],
                    ready_timeout: Duration::from_secs(900),
                    pid_file: Some(self.run_dir.join("chat.pid")),
                    key_dir: Some(self.run_dir.clone()),
                },
                move |line| {
                    let _ = log_app.emit("runtime://log", line);
                },
            )
            .await;
            match result {
                Ok(mut server) => {
                    if !refitted && fit_fallback && fit_failed(&server.logs().lines()) {
                        // Only once: the restart runs without `--fit`.
                        tracing::warn!("llama.cpp could not fit the model into free GPU memory; restarting with the estimated split");
                        let _ = app.emit("runtime://log", REFIT_NOTE);
                        server.stop().await;
                        // From now on the build counts as one without `--fit`: the estimated split.
                        flags = Arc::new(flags.iter().filter(|f| *f != "--fit").cloned().collect());
                        refitted = true;
                        continue;
                    }
                    if refitted {
                        // The new server's log starts after the restart; keep the reason visible.
                        server.logs().push(REFIT_NOTE.to_string());
                    }
                    match vision {
                        VisionState::Missing => server.logs().push(PROJECTOR_MISSING_NOTE.to_string()),
                        VisionState::Failed => server.logs().push(PROJECTOR_FAILED_NOTE.to_string()),
                        VisionState::On | VisionState::Off => {}
                    }
                    info.status = ServerStatus::Ready;
                    let handle = ChatHandle {
                        client: server.client(),
                        scheduler: Scheduler::new(slots as usize),
                        model: model.clone(),
                        context,
                        pin_slot: true,
                        vision: vision == VisionState::On,
                    };
                    watch_status(app.clone(), server.watch_status(), info.clone());
                    *self.chat.lock().await = Some(Running {
                        server: Some(server),
                        handle: handle.clone(),
                    });
                    self.set_info(app, Some(info.clone()));
                    self.spawn_tool_self_test(app.clone(), handle, info.clone());
                    return Ok(info);
                }
                Err(ServerError::Exited { log_tail, .. }) if projector.is_some() && projector_failed(&log_tail) => {
                    // The model itself may be fine: start it without image input.
                    tracing::warn!("llama-server did not start with the vision projector; starting without image input");
                    let _ = app.emit("runtime://log", PROJECTOR_FAILED_NOTE);
                    projector = None;
                    vision = VisionState::Failed;
                }
                Err(ServerError::Exited { log_tail, .. }) if oom_retries < 2 && looks_like_oom(&log_tail) && context > 8_192 => {
                    tracing::warn!("llama-server ran out of memory at {context} tokens; retrying with half the context");
                    oom_retries += 1;
                    context = (context / 2).max(8_192);
                }
                Err(e) => {
                    info.status = ServerStatus::Crashed {
                        code: None,
                        message: e.to_string(),
                    };
                    self.set_info(app, Some(info));
                    return Err(e.into());
                }
            }
        }
    }

    /// One tool round trip right after start: does this model+build produce
    /// structured tool calls, repairable text calls, or nothing usable?
    fn spawn_tool_self_test(&self, app: AppHandle, handle: ChatHandle, info: ServerInfo) {
        if !handle.model.as_ref().is_some_and(|m| m.has_role(registry::Role::Agent)) {
            return;
        }
        let shared = self.info_handle();
        tauri::async_runtime::spawn(async move {
            let result = tool_self_test(&handle).await;
            let snapshot = {
                let mut current = shared.lock().unwrap();
                match current.as_mut() {
                    // Only update if the same model is still loaded.
                    Some(i) if i.model_id == info.model_id && i.quant == info.quant => {
                        i.tool_calls = result;
                        Some(i.clone())
                    }
                    _ => None,
                }
            };
            if let Some(s) = snapshot {
                let _ = app.emit("runtime://server", &Some(s));
            }
        });
    }
}

pub(crate) async fn tool_self_test(handle: &ChatHandle) -> ToolCallSupport {
    use inference::{ChatMessage, ChatRequest, ToolDefinition};
    let mut req = ChatRequest::new(vec![ChatMessage::user("Call the ping tool with the message \"ok\". Do not answer with text.")]);
    req.tools = vec![ToolDefinition::function(
        "ping",
        "Health check. Call it with a message.",
        serde_json::json!({"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}),
    )];
    req.temperature = Some(0.0);
    req.max_tokens = Some(512);
    let guard = handle.scheduler.acquire(inference::Priority::Background, None, "tool self-test").await;
    let cancel = CancellationToken::new();
    let result = tokio::time::timeout(Duration::from_secs(120), handle.client.chat(req, &cancel, |_| {})).await;
    drop(guard);
    match result {
        Ok(Ok(r)) if r.message.tool_calls.iter().any(|c| c.function.name == "ping") => ToolCallSupport::Native,
        Ok(Ok(r)) => {
            let text = r.message.content.unwrap_or_default();
            let (calls, _) = agent::textcalls::parse_text_tool_calls(&text, &["ping"]);
            if calls.iter().any(|c| c.function.name == "ping") { ToolCallSupport::Repaired } else { ToolCallSupport::Failed }
        }
        _ => ToolCallSupport::Failed,
    }
}

fn watch_status(app: AppHandle, mut rx: tokio::sync::watch::Receiver<ServerStatus>, info: ServerInfo) {
    tauri::async_runtime::spawn(async move {
        while rx.changed().await.is_ok() {
            let status = rx.borrow().clone();
            let mut snapshot = info.clone();
            snapshot.status = status.clone();
            let _ = app.emit("runtime://server", &Some(snapshot));
            if matches!(status, ServerStatus::Stopped | ServerStatus::Crashed { .. }) {
                break;
            }
        }
    });
}

fn looks_like_oom(log: &str) -> bool {
    let l = log.to_lowercase();
    ["out of memory", "failed to allocate", "cudamalloc failed", "erroroutofdevicememory", "unable to allocate"]
        .iter()
        .any(|p| l.contains(p))
}

/// Server log lines when a model with image input on starts without its projector.
const PROJECTOR_MISSING_NOTE: &str =
    "[ylide] the vision projector of this model is missing; started without image input (switch image input off and on again on the Models page to download it again)";
const PROJECTOR_FAILED_NOTE: &str = "[ylide] llama-server could not load the vision projector; started without image input";

/// llama-server stopped because the projector (`--mmproj`) could not be loaded.
fn projector_failed(log: &str) -> bool {
    ["failed to load multimodal model", "Failed to load CLIP model", "mismatch between text model", "mtmd_init_from_file"]
        .iter()
        .any(|p| log.contains(p))
}

/// Server log line explaining the restart after a failed `--fit`.
const REFIT_NOTE: &str =
    "[ylide] llama.cpp could not fit the model into free GPU memory (\"failed to fit params\") and put every layer on the GPU; restarting once with the estimated split";

/// Whether this launch lets llama.cpp fit the model (`--fit`), before user arguments.
fn uses_fit(flags: &HashSet<String>, backend: Backend, plan: Option<&Plan>) -> bool {
    flags.contains("--fit") && backend != Backend::Cpu && plan.is_none_or(|p| p.placement != Placement::Cpu)
}

/// Whether a failed fit should be retried once with the estimated split. A
/// failed fit leaves every layer on the GPU, which then spills into shared
/// system memory; only MoE and partial offload plans have a better split to
/// fall back to. User arguments that block fitting already get that split.
fn refit_possible(flags: &HashSet<String>, backend: Backend, plan: Option<&Plan>, extra: &[String]) -> bool {
    uses_fit(flags, backend, plan)
        && fit_blocker(extra).is_none()
        && matches!(
            plan.map(|p| p.placement),
            Some(Placement::MoeOffload { .. } | Placement::PartialOffload { .. })
        )
}

/// llama.cpp could not apply `--fit` and kept its defaults (every layer on the GPU).
fn fit_failed(log: &[String]) -> bool {
    log.iter().any(|l| l.contains("failed to fit params") || l.contains("error while trying to fit params"))
}

fn subdirs_with_server(base: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(base) else { return vec![] };
    let mut out: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().join(SERVER_BINARY).is_file())
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    out.sort();
    out
}

/// Every `-x` / `--long-flag` mentioned in `llama-server --help`.
pub fn parse_help_flags(help: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for token in help.split(|c: char| c.is_whitespace() || c == ',' || c == '=' || c == '[' || c == ']') {
        let t = token.trim_matches(|c: char| c == '(' || c == ')' || c == '"' || c == '\'');
        let body = t.trim_start_matches('-');
        let dashes = t.len() - body.len();
        if (dashes == 1 || dashes == 2) && body.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && body.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            out.insert(t.to_string());
        }
    }
    out
}

pub struct LaunchOptions<'a> {
    pub model_path: &'a str,
    pub model: Option<&'a Model>,
    pub context: u32,
    pub slots: u32,
    pub plan: Option<&'a Plan>,
    pub threads: u32,
    pub ram_total: u64,
    pub device: Option<String>,
    pub extra: &'a [String],
    pub runtime_backend: Backend,
    /// Vision projector file (`--mmproj`) for image input.
    pub projector: Option<&'a str>,
}

/// Free GPU memory `--fit` leaves for the desktop and other programs.
const FIT_TARGET_MIB: &str = "1024";

/// Command line for the chat/agent server (see docs/architecture.md, "Launch flags").
pub fn chat_args(o: &LaunchOptions<'_>, flags: &HashSet<String>) -> Vec<String> {
    let has = |f: &str| flags.is_empty() || flags.contains(f);
    let mut a: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));

    push(&["-m", o.model_path, "--alias", "chat"]);
    let unified = has("-kvu") || has("--kv-unified");
    let total_ctx = if unified { o.context } else { o.context.saturating_mul(o.slots) };
    push(&["-c", &total_ctx.to_string(), "-np", &o.slots.to_string()]);
    if unified && flags.contains("--kv-unified") && !flags.contains("-kvu") {
        push(&["--kv-unified"]);
    } else if unified {
        push(&["-kvu"]);
    }
    if has("-fa") {
        push(&["-fa", "on"]);
    }
    // With `--fit`, llama.cpp measures free memory at load time and moves
    // MoE experts (then whole layers) to system RAM until the rest fits. It
    // only does so when the placement is left to it: an explicit `-ngl` or a
    // tensor override makes it give up, and an over-full GPU then spills into
    // shared system memory, which is several times slower. So `-ngl` is
    // passed only without `--fit` (older builds, user arguments that stop
    // fitting, a failed fit), using the estimated split; the user arguments
    // come last and still win.
    let can_fit = flags.contains("--fit") && fit_blocker(o.extra).is_none();
    // Tensor overrides add up and llama.cpp applies the first matching one,
    // so an estimated `--n-cpu-moe` would beat the user's own expert placement.
    let user_places_experts = flag_values(o.extra).any(|(f, v)| places_experts(f, v));
    let fit = ["--fit", "on", "--fit-target", FIT_TARGET_MIB];
    let placement = o.plan.map(|p| p.placement);
    match (o.runtime_backend, placement) {
        (Backend::Cpu, _) | (_, Some(Placement::Cpu)) => {
            push(&["-ngl", "0"]);
            if has("-dev") && o.runtime_backend != Backend::Cpu {
                push(&["-dev", "none"]);
            }
        }
        (_, Some(Placement::MoeOffload { cpu_expert_layers })) => {
            if can_fit {
                push(&fit);
            } else if user_places_experts {
                push(&["-ngl", "999"]);
            } else {
                push(&["-ngl", "999", "--n-cpu-moe", &(cpu_expert_layers + 2).to_string()]);
            }
            push(&["-b", "2048", "-ub", "2048"]);
        }
        (_, Some(Placement::PartialOffload { gpu_layers })) => {
            if can_fit {
                push(&fit);
            } else {
                push(&["-ngl", &gpu_layers.saturating_sub(1).to_string()]);
            }
        }
        (_, Some(Placement::Gpu | Placement::Unified) | None) => {
            if can_fit {
                // Keeps everything on the GPU when it fits, and degrades
                // gracefully when other programs hold more memory than planned.
                push(&fit);
            } else {
                push(&["-ngl", "999"]);
            }
        }
    }
    if let Some(dev) = &o.device
        && o.runtime_backend != Backend::Cpu
        && placement != Some(Placement::Cpu)
    {
        push(&["-dev", dev]);
    }
    if o.plan.is_some_and(|p| p.kv_cache_type == KvCacheType::Q8_0) {
        push(&["-ctk", "q8_0", "-ctv", "q8_0"]);
    }
    push(&["-t", &o.threads.to_string()]);
    // With `--fit`, llama-server adds the projector's worst-case memory to the
    // fit target itself; the estimated split counts it in the plan.
    if let Some(projector) = o.projector
        && has("--mmproj")
    {
        push(&["--mmproj", projector]);
        if flags.contains("--image-max-tokens") {
            push(&["--image-max-tokens", &registry::estimate::IMAGE_MAX_TOKENS.to_string()]);
        }
    }
    if flags.contains("--cache-ram") {
        let mib = if o.ram_total >= 48 << 30 { "8192" } else if o.ram_total >= 24 << 30 { "4096" } else { "1024" };
        push(&["--cache-ram", mib]);
    }
    for optional in ["--metrics", "--no-webui", "--offline"] {
        if flags.contains(optional) {
            push(&[optional]);
        }
    }
    let model_args: Vec<String> = o.model.map(|m| m.llama_args.clone()).unwrap_or_else(|| vec!["--jinja".into()]);
    a.extend(filter_known(&model_args, flags));
    a.extend(o.extra.iter().cloned());
    a
}

/// `(flag, value)` for every flag in `args`: `--flag=value`, or `-flag value`
/// with the next argument as value unless that is a flag itself.
fn flag_values(args: &[String]) -> impl Iterator<Item = (&str, Option<&str>)> {
    let is_flag = |s: &str| s.starts_with('-') && s.parse::<f64>().is_err();
    args.iter().enumerate().filter(move |(_, a)| is_flag(a.as_str())).map(move |(i, a)| match a.split_once('=') {
        Some((flag, value)) => (flag, Some(value)),
        None => (a.as_str(), args.get(i + 1).map(String::as_str).filter(|v| !is_flag(v))),
    })
}

/// The first user argument that keeps llama.cpp (b11669) from fitting the
/// model: a GPU layer count other than the default `auto` ("n_gpu_layers
/// already set by user"), a tensor override ("tensor_buft_overrides already
/// set by user"), tensor split mode ("not implemented for SPLIT_MODE_TENSOR")
/// or `--fit` switched off (llama.cpp accepts off, false, 0 and disabled).
fn fit_blocker(extra: &[String]) -> Option<&str> {
    flag_values(extra).find_map(|(flag, value)| {
        let blocks = match flag {
            "-ngl" | "--gpu-layers" | "--n-gpu-layers" => value != Some("auto"),
            "-fit" | "--fit" => matches!(value, Some("off" | "false" | "0" | "disabled")),
            "-sm" | "--split-mode" => value == Some("tensor"),
            _ => is_tensor_override(flag),
        };
        blocks.then_some(flag)
    })
}

/// Flags that add tensor placement rules (llama.cpp's `tensor_buft_overrides`).
fn is_tensor_override(flag: &str) -> bool {
    matches!(
        flag,
        "-ncmoe" | "--n-cpu-moe" | "-cmoe" | "--cpu-moe" | "-ncffn" | "--n-cpu-ffn" | "-ot" | "--override-tensor"
    )
}

/// User arguments that decide where MoE expert tensors go. A tensor override
/// for other tensors (e.g. `token_embd`) leaves the experts to our split.
fn places_experts(flag: &str, value: Option<&str>) -> bool {
    match flag {
        "-ncmoe" | "--n-cpu-moe" | "-cmoe" | "--cpu-moe" => true,
        "-ot" | "--override-tensor" => value.is_some_and(|v| v.contains("exps")),
        _ => false,
    }
}

/// Drops flags (and their value) that the binary does not know.
fn filter_known(args: &[String], flags: &HashSet<String>) -> Vec<String> {
    if flags.is_empty() {
        return args.to_vec();
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        let takes_value = args.get(i + 1).is_some_and(|n| !n.starts_with('-'));
        if a.starts_with('-') && !flags.contains(a.as_str()) {
            tracing::warn!("llama-server does not know {a}; skipping it");
            i += if takes_value { 2 } else { 1 };
            continue;
        }
        out.push(a.clone());
        i += 1;
    }
    out
}

/// Chooses `-dev` for the primary GPU so llama.cpp never picks the iGPU.
async fn pick_device(binary: &Path, runtime: &RuntimeInfo, hw: &HardwareProfile) -> Option<String> {
    if runtime.backend == Backend::Cpu {
        return None;
    }
    let devices = inference::list_devices(binary).await.ok()?;
    let gpu = hw.primary_gpu()?;
    let name = gpu.name.to_lowercase();
    devices
        .iter()
        .find(|d| d.description.to_lowercase().contains(&name) || name.contains(&d.description.to_lowercase()))
        .or_else(|| devices.first())
        .map(|d| d.id.clone())
}

/// Unpacks `.zip` and `.tar.gz` archives, refusing entries that would escape `dest`.
pub fn extract_archive(archive: &Path, dest: &Path) -> AppResult<()> {
    let name = archive.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.ends_with(".zip") {
        let file = std::fs::File::open(archive)?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| AppError::new("runtime_invalid", e))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| AppError::new("runtime_invalid", e))?;
            let Some(rel) = entry.enclosed_name() else {
                return Err(AppError::new("runtime_invalid", format!("unsafe path in archive: {}", entry.name().map(|n| n.to_string()).unwrap_or_default())));
            };
            let out = dest.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut f = std::fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut f)?;
        }
        Ok(())
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let file = std::fs::File::open(archive)?;
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        for entry in tar.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.into_owned();
            if path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                return Err(AppError::new("runtime_invalid", format!("unsafe path in archive: {}", path.display())));
            }
            entry.unpack_in(dest)?;
        }
        Ok(())
    } else {
        Err(AppError::new("runtime_invalid", format!("unsupported archive {name}")))
    }
}

fn write_runtime_licenses(dir: &Path) -> AppResult<()> {
    for (name, text) in RUNTIME_LICENSES {
        std::fs::write(dir.join(name), text)?;
    }
    Ok(())
}

/// If the server binary ended up in a single subfolder, move everything up.
fn flatten_single_subdir(dir: &Path) -> AppResult<()> {
    if dir.join(SERVER_BINARY).exists() {
        return Ok(());
    }
    let found = walk_find(dir, SERVER_BINARY, 4);
    if let Some(bin_dir) = found.and_then(|p| p.parent().map(Path::to_path_buf)) {
        for entry in std::fs::read_dir(&bin_dir)?.flatten() {
            let to = dir.join(entry.file_name());
            if !to.exists() {
                std::fs::rename(entry.path(), to)?;
            }
        }
    }
    Ok(())
}

fn walk_find(dir: &Path, name: &str, depth: u32) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_file() && entry.file_name() == name {
            return Some(p);
        }
        if p.is_dir()
            && let Some(f) = walk_find(&p, name, depth - 1)
        {
            return Some(f);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn flags(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn plan(placement: Placement, kv: KvCacheType, context: u32) -> Plan {
        Plan {
            placement,
            context,
            kv_cache_type: kv,
            weights_bytes: 0,
            kv_bytes: 0,
            overhead_bytes: 0,
            projector_bytes: 0,
            vram_bytes: 0,
            ram_bytes: 0,
            est_tokens_per_sec: 0.0,
        }
    }

    #[test]
    fn parses_help_output() {
        let help = "-m,    --model FNAME   model path\n-c, --ctx-size N\n-np, --parallel N\n-kvu, --kv-unified\n--fit [on|off]\n--no-webui\n-fa,   --flash-attn [on|off|auto]\nexample: --port 8080 (default: 9931)";
        let f = parse_help_flags(help);
        for expected in ["-m", "--model", "-c", "-np", "-kvu", "--fit", "--no-webui", "-fa", "--port"] {
            assert!(f.contains(expected), "{expected}");
        }
        assert!(!f.contains("-"));
    }

    #[test]
    fn moe_offload_uses_fit_when_available() {
        let reg = registry::bundled();
        let model = reg.models.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap();
        let p = plan(Placement::MoeOffload { cpu_expert_layers: 22 }, KvCacheType::F16, 131_072);
        let o = LaunchOptions {
            model_path: "C:/m/model.gguf",
            model: Some(model),
            context: 131_072,
            slots: 2,
            plan: Some(&p),
            threads: 16,
            ram_total: 64 << 30,
            device: Some("CUDA0".into()),
            extra: &[],
            runtime_backend: Backend::Cuda,
            projector: None,
        };
        let all = flags(&["-m", "--alias", "-c", "-np", "-kvu", "-fa", "-ngl", "--fit", "--fit-target", "-b", "-ub", "-dev", "-t", "--cache-ram", "--metrics", "--no-webui", "--offline", "--jinja", "--reasoning-format"]);
        let args = chat_args(&o, &all).join(" ");
        assert!(args.contains("-c 131072 -np 2 -kvu"), "{args}");
        assert!(args.contains("--fit on --fit-target 1024"));
        // An explicit layer count makes llama.cpp skip fitting (measured: 16 instead of 80 tok/s).
        assert!(!args.contains("-ngl"), "--fit decides the GPU layers: {args}");
        assert!(!args.contains("--n-cpu-moe"), "{args}");
        assert!(args.contains("-dev CUDA0"));
        assert!(args.contains("--jinja --reasoning-format deepseek"));
        assert!(args.contains("--cache-ram 8192"));
        assert!(!args.contains("--api-key"), "the key is added by the server module only");

        // Older build without --fit: fall back to the estimated expert split (+2 margin).
        let old = flags(&["-m", "--alias", "-c", "-np", "-fa", "-ngl", "--n-cpu-moe", "-t", "--jinja"]);
        let args = chat_args(&o, &old).join(" ");
        assert!(args.contains("-ngl 999 --n-cpu-moe 24"), "{args}");
        assert!(args.contains("-c 262144 -np 2"), "without -kvu every slot gets its own context: {args}");
        assert!(!args.contains("--reasoning-format"), "unknown flags are dropped with their value: {args}");
    }

    fn cuda_options<'a>(plan: Option<&'a Plan>, extra: &'a [String]) -> LaunchOptions<'a> {
        LaunchOptions {
            model_path: "m.gguf",
            model: None,
            context: 32_768,
            slots: 1,
            plan,
            threads: 8,
            ram_total: 32 << 30,
            device: Some("CUDA0".into()),
            extra,
            runtime_backend: Backend::Cuda,
            projector: None,
        }
    }

    /// The GPU placement part of a command line: `-ngl`, `--n-cpu-moe`, `--fit`,
    /// `--fit-target` and `-dev`, each with its value.
    fn gpu_args(args: &[String]) -> String {
        let mut out = Vec::new();
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if ["-ngl", "--n-cpu-moe", "--fit", "--fit-target", "-dev"].contains(&a.as_str()) {
                out.push(a.as_str());
                out.extend(it.next().map(String::as_str));
            }
        }
        out.join(" ")
    }

    const WITH_FIT: &[&str] = &["-m", "--alias", "-c", "-np", "-ngl", "--fit", "--fit-target", "-dev", "-t"];

    #[test]
    fn fit_replaces_fixed_layer_counts_for_every_gpu_placement() {
        let with_fit = flags(WITH_FIT);
        let without_fit = flags(&["-m", "--alias", "-c", "-np", "-ngl", "-dev", "-t"]);
        let cases = [
            (Some(Placement::Gpu), "-ngl 999"),
            (Some(Placement::Unified), "-ngl 999"),
            (Some(Placement::PartialOffload { gpu_layers: 20 }), "-ngl 19"),
            (Some(Placement::MoeOffload { cpu_expert_layers: 10 }), "-ngl 999 --n-cpu-moe 12"),
            (None, "-ngl 999"),
        ];
        for (placement, split) in cases {
            let p = placement.map(|pl| plan(pl, KvCacheType::F16, 32_768));
            let o = cuda_options(p.as_ref(), &[]);
            assert_eq!(gpu_args(&chat_args(&o, &with_fit)), "--fit on --fit-target 1024 -dev CUDA0", "{placement:?}");
            // Also the restart after a failed fit, which drops `--fit` from the flags.
            assert_eq!(gpu_args(&chat_args(&o, &without_fit)), format!("{split} -dev CUDA0"), "{placement:?}");
        }

        // A CPU plan on a GPU build: no layers and no device, so nothing to fit.
        let p = plan(Placement::Cpu, KvCacheType::F16, 32_768);
        let args = chat_args(&cuda_options(Some(&p), &[]), &with_fit);
        assert_eq!(gpu_args(&args), "-ngl 0 -dev none");
        assert!(!args.join(" ").contains("--fit"), "{args:?}");
    }

    #[test]
    fn user_placement_arguments_switch_fitting_off() {
        let with_fit = flags(WITH_FIT);
        let moe = plan(Placement::MoeOffload { cpu_expert_layers: 10 }, KvCacheType::F16, 32_768);
        let partial = plan(Placement::PartialOffload { gpu_layers: 20 }, KvCacheType::F16, 32_768);
        let args = |p: &Plan, extra: &[&str]| {
            let extra: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
            chat_args(&cuda_options(Some(p), &extra), &with_fit).join(" ")
        };

        // A layer count stops fitting: the estimated split goes first, the user's value last.
        let a = args(&moe, &["-ngl", "30"]);
        assert!(a.contains("-ngl 999 --n-cpu-moe 12 -b 2048 -ub 2048 -dev CUDA0"), "{a}");
        assert!(a.ends_with("-ngl 30") && !a.contains("--fit on"), "{a}");
        let a = args(&partial, &["--n-gpu-layers=30"]);
        assert!(a.contains("-ngl 19 -dev CUDA0") && a.ends_with("--n-gpu-layers=30") && !a.contains("--fit on"), "{a}");

        // Tensor overrides add up, so the estimated --n-cpu-moe is left out for the user's.
        let a = args(&moe, &["--n-cpu-moe", "5"]);
        assert!(a.contains("-ngl 999 -b 2048 -ub 2048 -dev CUDA0") && a.ends_with("--n-cpu-moe 5"), "{a}");
        assert_eq!(a.matches("--n-cpu-moe").count(), 1, "{a}");
        assert!(!a.contains("--fit on"), "{a}");
        let a = args(&moe, &["-ot", "exps=CPU"]);
        assert!(a.contains("-ngl 999 -b 2048") && !a.contains("--n-cpu-moe") && !a.contains("--fit on"), "{a}");
        // An override for other tensors leaves the experts to the estimated split.
        let a = args(&moe, &["-ot", "token_embd\\.weight=CPU"]);
        assert!(a.contains("-ngl 999 --n-cpu-moe 12 -b 2048") && !a.contains("--fit on"), "{a}");

        // --fit off: the estimated split.
        let a = args(&moe, &["-fit", "off"]);
        assert!(a.contains("-ngl 999 --n-cpu-moe 12") && !a.contains("--fit on"), "{a}");

        // The default layer count and unrelated flags keep fitting on.
        let a = args(&moe, &["-ngl", "auto", "--fit-target", "2048", "--seed", "1"]);
        assert!(a.contains("--fit on --fit-target 1024") && !a.contains("-ngl 999"), "{a}");
    }

    #[test]
    fn finds_user_arguments_that_stop_fitting() {
        let blocker = |extra: &[&str]| fit_blocker(&extra.iter().map(|s| s.to_string()).collect::<Vec<_>>()).map(str::to_string);
        assert_eq!(blocker(&["-ngl", "20"]).as_deref(), Some("-ngl"));
        assert_eq!(blocker(&["--seed", "1", "--gpu-layers=all"]).as_deref(), Some("--gpu-layers"));
        assert_eq!(blocker(&["-ngl", "0"]).as_deref(), Some("-ngl"), "0 is not llama.cpp's default either");
        assert_eq!(blocker(&["-ncmoe", "4"]).as_deref(), Some("-ncmoe"));
        assert_eq!(blocker(&["-cmoe"]).as_deref(), Some("-cmoe"));
        assert_eq!(blocker(&["--override-tensor=exps=CPU"]).as_deref(), Some("--override-tensor"));
        assert_eq!(blocker(&["--fit=off"]).as_deref(), Some("--fit"));
        assert_eq!(blocker(&["-fit", "off"]).as_deref(), Some("-fit"));
        for off in ["0", "false", "disabled"] {
            assert_eq!(blocker(&["--fit", off]).as_deref(), Some("--fit"), "--fit {off}");
        }
        assert_eq!(blocker(&["-ncffn", "4"]).as_deref(), Some("-ncffn"));
        assert_eq!(blocker(&["--split-mode", "tensor"]).as_deref(), Some("--split-mode"));
        assert_eq!(blocker(&["-sm", "layer"]), None, "layer split is the default and fits");
        assert_eq!(blocker(&["-ngl", "auto", "--fit", "on", "--fit-target", "2048", "--temp", "-1"]), None);
        assert_eq!(blocker(&[]), None);
    }

    #[test]
    fn restarts_after_a_failed_fit_only_where_a_better_split_exists() {
        let with_fit = flags(WITH_FIT);
        let without_fit = flags(&["-m", "-c", "-np", "-ngl", "--n-cpu-moe", "-dev", "-t"]);
        let p = |placement| plan(placement, KvCacheType::F16, 32_768);
        let moe = p(Placement::MoeOffload { cpu_expert_layers: 10 });
        let partial = p(Placement::PartialOffload { gpu_layers: 20 });
        let gpu = p(Placement::Gpu);
        let cpu = p(Placement::Cpu);
        let none: Vec<String> = vec![];
        let ngl: Vec<String> = vec!["-ngl".into(), "30".into()];

        assert!(refit_possible(&with_fit, Backend::Cuda, Some(&moe), &none));
        assert!(refit_possible(&with_fit, Backend::Vulkan, Some(&partial), &none));
        // Everything was meant to be on the GPU anyway, or there is no plan to fall back to.
        assert!(!refit_possible(&with_fit, Backend::Cuda, Some(&gpu), &none));
        assert!(!refit_possible(&with_fit, Backend::Cuda, None, &none));
        // No fitting in the first place.
        assert!(!refit_possible(&with_fit, Backend::Cuda, Some(&cpu), &none));
        assert!(!refit_possible(&with_fit, Backend::Cpu, Some(&moe), &none));
        assert!(!refit_possible(&without_fit, Backend::Cuda, Some(&moe), &none));
        // The user's -ngl already disables fitting; llama.cpp's "failed to fit" is expected then.
        assert!(!refit_possible(&with_fit, Backend::Cuda, Some(&moe), &ngl));
        // After the restart the flags no longer contain --fit, so there is no second one.
        let after: HashSet<String> = with_fit.iter().filter(|f| *f != "--fit").cloned().collect();
        assert!(!refit_possible(&after, Backend::Cuda, Some(&moe), &none));
    }

    #[test]
    fn detects_a_failed_fit() {
        let log = |line: &str| vec!["load_backend: loaded CUDA backend".to_string(), line.to_string()];
        assert!(fit_failed(&log("common_fit_params: failed to fit params to free device memory: n_gpu_layers already set by user to 999, abort")));
        assert!(fit_failed(&log("common_fit_params: encountered an error while trying to fit params to free device memory: boom")));
        assert!(!fit_failed(&log("common_fit_params: successfully fit params to free device memory")));
    }

    #[test]
    fn cpu_runtime_never_offloads() {
        let p = plan(Placement::Gpu, KvCacheType::Q8_0, 32_768);
        let o = LaunchOptions {
            model_path: "m.gguf",
            model: None,
            context: 32_768,
            slots: 1,
            plan: Some(&p),
            threads: 8,
            ram_total: 16 << 30,
            device: Some("Vulkan0".into()),
            extra: &["--seed".into(), "1".into()],
            runtime_backend: Backend::Cpu,
            projector: None,
        };
        let args = chat_args(&o, &HashSet::new());
        let joined = args.join(" ");
        assert!(joined.contains("-ngl 0"));
        assert!(!joined.contains("-dev"));
        assert!(joined.contains("-ctk q8_0 -ctv q8_0"));
        assert!(joined.ends_with("--seed 1"), "user arguments come last: {joined}");
    }

    #[test]
    fn cuda_driver_requirement() {
        let mut hw = hardware::probe(None);
        hw.acceleration.cuda_driver = Some("13.3".into());
        assert!(cuda_driver_ok(&hw, Some("13.0")));
        assert!(cuda_driver_ok(&hw, Some("12.4")));
        hw.acceleration.cuda_driver = Some("12.8".into());
        assert!(!cuda_driver_ok(&hw, Some("13.0")));
        hw.acceleration.cuda_driver = None;
        assert!(!cuda_driver_ok(&hw, None));
    }

    #[test]
    fn zip_extraction_refuses_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("evil.zip");
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("../escape.txt", opts).unwrap();
            zip.write_all(b"x").unwrap();
            zip.finish().unwrap();
        }
        let out = dir.path().join("out");
        assert!(extract_archive(&archive, &out).is_err());
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn zip_extraction_and_flattening() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("rt.zip");
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file(format!("build/bin/{SERVER_BINARY}"), opts).unwrap();
            zip.write_all(b"bin").unwrap();
            zip.start_file("build/bin/ggml.dll", opts).unwrap();
            zip.write_all(b"dll").unwrap();
            zip.finish().unwrap();
        }
        let out = dir.path().join("vulkan");
        extract_archive(&archive, &out).unwrap();
        flatten_single_subdir(&out).unwrap();
        assert!(out.join(SERVER_BINARY).exists());
        assert!(out.join("ggml.dll").exists());
        assert_eq!(subdirs_with_server(dir.path()).len(), 1);
    }

    #[test]
    fn runtime_licenses_land_next_to_the_binaries() {
        let dir = tempfile::tempdir().unwrap();
        write_runtime_licenses(dir.path()).unwrap();
        let llama = std::fs::read_to_string(dir.path().join("LICENSE-llama.cpp")).unwrap();
        assert!(llama.starts_with("MIT License") && llama.contains("The ggml authors"));
        assert!(std::fs::read_to_string(dir.path().join("LICENSE-BoringSSL")).unwrap().contains("Apache License"));
        assert!(dir.path().join("LICENSE-httplib").exists() && dir.path().join("LICENSE-jsonhpp").exists());
    }

    #[test]
    fn backend_names() {
        assert_eq!(backend_of("cuda-13.4"), Backend::Cuda);
        assert_eq!(backend_of("vulkan"), Backend::Vulkan);
        assert_eq!(backend_of("rocm-10.0"), Backend::Rocm);
        assert_eq!(backend_of("cpu"), Backend::Cpu);
        assert!(looks_like_oom("ggml_backend_cuda_buffer_type_alloc_buffer: allocating 1234 MiB on device 0: cudaMalloc failed: out of memory"));
    }

    #[test]
    fn image_input_loads_the_projector() {
        let p = plan(Placement::MoeOffload { cpu_expert_layers: 22 }, KvCacheType::F16, 32_768);
        let mut o = cuda_options(Some(&p), &[]);
        let known = flags(&["-m", "--alias", "-c", "-np", "-kvu", "-fa", "-ngl", "--fit", "--fit-target", "-t", "--mmproj", "--image-max-tokens"]);
        assert!(!chat_args(&o, &known).iter().any(|a| a == "--mmproj"), "off by default");
        o.projector = Some(r"C:\models\unsloth__Qwen3.6-35B-A3B-GGUF\mmproj-F16.gguf");
        let args = chat_args(&o, &known).join(" ");
        assert!(args.contains(r"--mmproj C:\models\unsloth__Qwen3.6-35B-A3B-GGUF\mmproj-F16.gguf --image-max-tokens 2048"), "{args}");
        // llama-server adds the projector to the fit target itself.
        assert!(args.contains("--fit on --fit-target 1024"), "{args}");
        // A build that lists no --image-max-tokens still gets the projector; one without --mmproj does not.
        let args = chat_args(&o, &flags(&["-m", "-c", "-np", "-t", "--mmproj"])).join(" ");
        assert!(args.contains("--mmproj ") && !args.contains("--image-max-tokens"), "{args}");
        assert!(!chat_args(&o, &flags(&["-m", "-c", "-np", "-t"])).iter().any(|a| a == "--mmproj"));
        // Unchecked (empty --help): long-standing flags are passed.
        assert!(chat_args(&o, &HashSet::new()).iter().any(|a| a == "--mmproj"));
    }

    #[test]
    fn a_projector_that_does_not_load_is_recognized() {
        assert!(projector_failed("srv    load_model: failed to load multimodal model, 'C:\\m\\mmproj-F16.gguf'"));
        assert!(projector_failed("clip_init: Failed to load CLIP model from C:\\m\\mmproj.gguf"));
        assert!(projector_failed("mismatch between text model (n_embd = 2048) and mmproj (n_embd = 4096)\nhint: you may be using wrong mmproj"));
        assert!(!projector_failed("srv    load_model: failed to load model, 'C:\\m\\model.gguf'"));
        assert!(!projector_failed("cudaMalloc failed: out of memory"));
    }
}
