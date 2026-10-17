//! Installed models and download jobs.
//!
//! Layout: `<models dir>/<publisher>__<repo>/<file path in repo>`. Files are
//! keyed by repository + path (some repos use identical file names), and the
//! SHA-256 from the registry is verified before a file counts as installed.
//!
//! Image input is switched per model: the registry's vision projector is
//! downloaded like a variant (job `<model>@mmproj`) and recorded on every
//! installed variant of the model; an imported model gets a projector file
//! the user picks.

use crate::error::{AppError, AppResult};
use crate::network::{NetPurpose, NetworkGate};
use downloader::{DownloadError, DownloadPhase, Downloader, FileSpec, Progress};
use registry::{Model, Registry, Variant};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledFile {
    pub path: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledModel {
    pub model_id: String,
    pub quant: String,
    pub name: String,
    pub files: Vec<InstalledFile>,
    #[ts(type = "number")]
    pub installed_at_unix_ms: u64,
    /// Imported by the user: the files are theirs and are never deleted by
    /// Ylide. An imported file that matches a registry variant keeps that
    /// model's id, so its recommended settings apply.
    pub custom: bool,
    /// Vision projector loaded with the model (`--mmproj`): image input is
    /// on. Downloaded from the registry (with its hash) or picked by the user.
    #[serde(default)]
    pub projector: Option<InstalledFile>,
}

impl InstalledModel {
    /// The file llama-server is started with (first part of split GGUFs).
    pub fn primary_path(&self) -> Option<&str> {
        self.files.first().map(|f| f.path.as_str())
    }
}

/// Quant part of the job id of a projector download (`<model>@mmproj`).
pub const PROJECTOR_JOB: &str = "mmproj";

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "state")]
#[ts(export)]
pub enum JobState {
    Running,
    Paused,
    Completed,
    Failed { message: String },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DownloadJob {
    pub job_id: String,
    pub model_id: String,
    /// The variant, or [`PROJECTOR_JOB`] for a vision projector.
    pub quant: String,
    pub name: String,
    /// Downloads the vision projector of `model_id`, not a variant.
    pub projector: bool,
    pub state: JobState,
    pub progress: Option<Progress>,
    #[ts(type = "number")]
    pub total_bytes: u64,
}

struct JobEntry {
    job: DownloadJob,
    cancel: CancellationToken,
    discard: bool,
}

pub struct ModelStore {
    dir: Mutex<PathBuf>,
    manifest: Mutex<Vec<InstalledModel>>,
    jobs: Arc<Mutex<HashMap<String, JobEntry>>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `owner/repo` -> `owner__repo` (a valid folder name everywhere).
pub fn repo_folder(repo: &str) -> String {
    repo.replace('/', "__")
}

pub fn job_id(model_id: &str, quant: &str) -> String {
    format!("{model_id}@{quant}")
}

impl ModelStore {
    pub fn new(dir: PathBuf) -> Self {
        let store = Self {
            dir: Mutex::new(dir),
            manifest: Mutex::new(Vec::new()),
            jobs: Arc::default(),
        };
        store.reload();
        store
    }

    pub fn dir(&self) -> PathBuf {
        self.dir.lock().unwrap().clone()
    }

    /// Switches to another models folder (settings change).
    pub fn set_dir(&self, dir: PathBuf) {
        *self.dir.lock().unwrap() = dir;
        self.reload();
    }

    fn manifest_path(&self) -> PathBuf {
        self.dir().join("installed.json")
    }

    fn reload(&self) {
        let list = std::fs::read_to_string(self.manifest_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<InstalledModel>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            // Drop entries whose files were deleted outside the app. A missing
            // projector keeps the entry: the model then starts without image input.
            .filter(|m| m.files.iter().all(|f| Path::new(&f.path).exists()))
            .collect();
        *self.manifest.lock().unwrap() = list;
    }

    fn save(&self) -> AppResult<()> {
        let dir = self.dir();
        std::fs::create_dir_all(&dir)?;
        let list = self.manifest.lock().unwrap().clone();
        let tmp = dir.join("installed.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&list)?)?;
        std::fs::rename(tmp, self.manifest_path())?;
        Ok(())
    }

    pub fn installed(&self) -> Vec<InstalledModel> {
        self.manifest.lock().unwrap().clone()
    }

    pub fn find(&self, model_id: &str, quant: &str) -> Option<InstalledModel> {
        self.manifest.lock().unwrap().iter().find(|m| m.model_id == model_id && m.quant == quant).cloned()
    }

    pub fn jobs(&self) -> Vec<DownloadJob> {
        self.jobs.lock().unwrap().values().map(|j| j.job.clone()).collect()
    }

    /// Where the files of a registry variant live.
    pub fn file_specs(&self, model: &Model, variant: &Variant) -> Vec<FileSpec> {
        let base = self.dir().join(repo_folder(&model.source.hf_repo));
        variant
            .files
            .iter()
            .map(|f| FileSpec {
                url: format!(
                    "https://huggingface.co/{}/resolve/{}/{}",
                    model.source.hf_repo,
                    model.source.revision,
                    f.path.split('/').map(url_encode).collect::<Vec<_>>().join("/")
                ),
                dest: base.join(Path::new(&f.path)),
                size_bytes: f.size_bytes,
                sha256: f.sha256.clone(),
            })
            .collect()
    }

    /// Where the vision projector of a registry model lives, if it has one.
    pub fn projector_spec(&self, model: &Model) -> Option<FileSpec> {
        let variant = Variant {
            quant: PROJECTOR_JOB.into(),
            bits_per_weight: 16.0,
            files: vec![model.projector.clone()?],
            quality_penalty: 0.0,
        };
        self.file_specs(model, &variant).pop()
    }

    /// Starts (or resumes) a download. Progress is emitted as `models://job`.
    pub fn start_download(
        self: &Arc<Self>,
        app: &AppHandle,
        gate: Arc<NetworkGate>,
        registry: &Registry,
        model_id: &str,
        quant: &str,
    ) -> AppResult<DownloadJob> {
        let model = find_model(registry, model_id)?;
        let variant = model
            .variants
            .iter()
            .find(|v| v.quant == quant)
            .ok_or_else(|| AppError::new("unknown_variant", quant))?
            .clone();
        let specs = self.file_specs(&model, &variant);
        let name = format!("{} {}", model.name, quant);
        self.run_job(app, gate, &model, name, specs, Done::Variant(variant))
    }

    /// Downloads the registry model's vision projector. Once it is complete
    /// (checksum verified), every installed variant of the model loads it.
    pub fn start_projector_download(self: &Arc<Self>, app: &AppHandle, gate: Arc<NetworkGate>, registry: &Registry, model_id: &str) -> AppResult<DownloadJob> {
        let model = find_model(registry, model_id)?;
        let spec = self.projector_spec(&model).ok_or_else(|| AppError::new("no_projector", model_id))?;
        let name = format!("{} {}", model.name, PROJECTOR_JOB);
        self.run_job(app, gate, &model, name, vec![spec], Done::Projector)
    }

    fn run_job(self: &Arc<Self>, app: &AppHandle, gate: Arc<NetworkGate>, model: &Model, name: String, specs: Vec<FileSpec>, done: Done) -> AppResult<DownloadJob> {
        let model = model.clone();
        let model_id = model.id.as_str();
        let quant = match &done {
            Done::Variant(v) => v.quant.clone(),
            Done::Projector => PROJECTOR_JOB.to_string(),
        };
        let total: u64 = specs.iter().map(|s| s.size_bytes).sum();

        // Enough space? Partial files from an earlier run count as already there.
        let dir = self.dir();
        std::fs::create_dir_all(&dir)?;
        if let Some(disk) = hardware::disk_for_path(&dir) {
            let on_disk = specs
                .iter()
                .map(|s| std::fs::metadata(&s.dest).or_else(|_| std::fs::metadata(downloader::part_path(&s.dest))).map(|m| m.len()).unwrap_or(0))
                .sum::<u64>();
            let needed = total.saturating_sub(on_disk) + (1 << 30);
            if disk.free_bytes < needed {
                return Err(AppError::new(
                    "disk_full",
                    format!("{} GB free, {} GB needed", disk.free_bytes >> 30, needed >> 30),
                ));
            }
        }

        let id = job_id(model_id, &quant);
        let cancel = CancellationToken::new();
        let job = DownloadJob {
            job_id: id.clone(),
            model_id: model_id.to_string(),
            quant,
            name,
            projector: matches!(done, Done::Projector),
            state: JobState::Running,
            progress: None,
            total_bytes: total,
        };
        {
            let mut jobs = self.jobs.lock().unwrap();
            if let Some(existing) = jobs.get(&id)
                && existing.job.state == JobState::Running
            {
                return Ok(existing.job.clone());
            }
            jobs.insert(
                id.clone(),
                JobEntry {
                    job: job.clone(),
                    cancel: cancel.clone(),
                    discard: false,
                },
            );
        }
        let _ = app.emit("models://job", &job);

        let store = self.clone();
        let app = app.clone();
        let audit_gate = gate.clone();
        let downloader = Downloader::new(gate.client()).with_audit(Arc::new(move |url: &str| {
            audit_gate.record(NetPurpose::ModelDownload, url, "requested")
        }));
        tauri::async_runtime::spawn(async move {
            let emit_progress = |p: Progress| {
                let snapshot = {
                    let mut jobs = store.jobs.lock().unwrap();
                    jobs.get_mut(&id).map(|e| {
                        e.job.progress = Some(p.clone());
                        e.job.clone()
                    })
                };
                if let Some(s) = snapshot {
                    let _ = app.emit("models://job", &s);
                }
            };
            let result = downloader.download(&id, &specs, &cancel, emit_progress).await;
            let (state, discard) = {
                let jobs = store.jobs.lock().unwrap();
                let discard = jobs.get(&id).map(|e| e.discard).unwrap_or(false);
                let state = match &result {
                    Ok(()) => JobState::Completed,
                    Err(DownloadError::Cancelled) if discard => JobState::Cancelled,
                    Err(DownloadError::Cancelled) => JobState::Paused,
                    Err(e) => JobState::Failed { message: e.to_string() },
                };
                (state, discard)
            };
            match &result {
                Ok(()) => {
                    gate.record(NetPurpose::ModelDownload, &specs[0].url, "completed, checksum verified");
                    let files: Vec<InstalledFile> = specs
                        .iter()
                        .map(|s| InstalledFile {
                            path: s.dest.display().to_string(),
                            size_bytes: s.size_bytes,
                            sha256: Some(s.sha256.clone()),
                        })
                        .collect();
                    match &done {
                        Done::Variant(variant) => store.add_variant(&model, &variant.quant, files),
                        Done::Projector => store.set_projector_of(&model.id, files.into_iter().next()),
                    }
                    if let Err(e) = store.save() {
                        tracing::error!("could not save model manifest: {e}");
                    }
                }
                Err(DownloadError::Cancelled) if discard => {
                    let _ = downloader::discard_partial(&specs).await;
                }
                Err(DownloadError::Cancelled) => {}
                Err(e) => gate.record(NetPurpose::ModelDownload, &specs[0].url, format!("failed: {e}")),
            }
            let snapshot = {
                let mut jobs = store.jobs.lock().unwrap();
                jobs.get_mut(&id).map(|e| {
                    e.job.state = state.clone();
                    if state == JobState::Completed
                        && let Some(p) = e.job.progress.as_mut()
                    {
                        p.phase = DownloadPhase::Done;
                    }
                    e.job.clone()
                })
            };
            if let Some(s) = snapshot {
                let _ = app.emit("models://job", &s);
            }
        });
        Ok(job)
    }

    /// Pauses a running download (the partial file is kept).
    pub fn pause(&self, job_id: &str) {
        if let Some(e) = self.jobs.lock().unwrap().get(job_id) {
            e.cancel.cancel();
        }
    }

    /// Stops a download and deletes what was downloaded so far.
    pub async fn cancel(&self, registry: &Registry, job_id: &str) -> AppResult<()> {
        let running = {
            let mut jobs = self.jobs.lock().unwrap();
            match jobs.get_mut(job_id) {
                Some(e) if e.job.state == JobState::Running => {
                    e.discard = true;
                    e.cancel.cancel();
                    true
                }
                Some(_) => {
                    jobs.remove(job_id);
                    false
                }
                None => false,
            }
        };
        if !running && let Some((model_id, quant)) = job_id.split_once('@') {
            // Paused or failed: remove the partial files directly.
            if let Some(model) = registry.models.iter().find(|m| m.id == model_id) {
                let specs = match model.variants.iter().find(|v| v.quant == quant) {
                    Some(variant) => self.file_specs(model, variant),
                    None if quant == PROJECTOR_JOB => self.projector_spec(model).into_iter().collect(),
                    None => vec![],
                };
                downloader::discard_partial(&specs).await?;
            }
        }
        Ok(())
    }

    /// Records a finished variant download. Image input is switched per
    /// model, so a variant of a model that already loads its projector gets it too.
    fn add_variant(&self, model: &Model, quant: &str, files: Vec<InstalledFile>) {
        let mut list = self.manifest.lock().unwrap();
        let projector = list.iter().find(|m| m.model_id == model.id && m.projector.is_some()).and_then(|m| m.projector.clone());
        list.retain(|m| !(m.model_id == model.id && m.quant == quant));
        list.push(InstalledModel {
            model_id: model.id.clone(),
            quant: quant.to_string(),
            name: model.name.clone(),
            files,
            installed_at_unix_ms: now_ms(),
            custom: false,
            projector,
        });
    }

    /// Sets (or clears) the projector of every installed variant of `model_id`.
    fn set_projector_of(&self, model_id: &str, projector: Option<InstalledFile>) {
        for m in self.manifest.lock().unwrap().iter_mut().filter(|m| m.model_id == model_id) {
            m.projector = projector.clone();
        }
    }

    /// Switches image input of `model_id` off: the projector is no longer
    /// loaded, and a downloaded one is deleted (a file the user picked stays).
    pub fn disable_projector(&self, model_id: &str) -> AppResult<()> {
        let old: Vec<InstalledFile> = self.manifest.lock().unwrap().iter().filter(|m| m.model_id == model_id).filter_map(|m| m.projector.clone()).collect();
        self.set_projector_of(model_id, None);
        self.save()?;
        for file in &old {
            self.remove_if_ours(file);
        }
        Ok(())
    }

    /// Uses a projector file the user has (for an imported model). It must be
    /// a GGUF vision projector, not a model.
    pub fn use_projector_file(&self, model_id: &str, path: &Path) -> AppResult<InstalledModel> {
        let meta = std::fs::metadata(path).map_err(|_| AppError::new("not_found", path.display()))?;
        if gguf_architecture(path).as_deref() != Some("clip") {
            return Err(AppError::new("not_projector", path.display()));
        }
        if !self.manifest.lock().unwrap().iter().any(|m| m.model_id == model_id) {
            return Err(AppError::new("model_not_installed", model_id));
        }
        let file = InstalledFile {
            path: path.display().to_string(),
            size_bytes: meta.len(),
            sha256: None,
        };
        self.set_projector_of(model_id, Some(file));
        self.save()?;
        let list = self.manifest.lock().unwrap();
        Ok(list.iter().find(|m| m.model_id == model_id).cloned().expect("checked above"))
    }

    /// Deletes a downloaded projector inside the models folder that no installed model loads any more.
    fn remove_if_ours(&self, file: &InstalledFile) {
        if file.sha256.is_none() {
            return;
        }
        let in_use = self.manifest.lock().unwrap().iter().any(|m| m.projector.as_ref().is_some_and(|p| p.path == file.path));
        let dir = dunce_canonical(&self.dir());
        let p = dunce_canonical(Path::new(&file.path));
        if !in_use && p.starts_with(&dir) {
            let _ = std::fs::remove_file(&p);
        }
    }

    /// Deletes an installed model's files (only files inside the models folder;
    /// imported custom models are just forgotten).
    pub fn delete(&self, model_id: &str, quant: &str) -> AppResult<()> {
        let removed = {
            let mut list = self.manifest.lock().unwrap();
            let pos = list.iter().position(|m| m.model_id == model_id && m.quant == quant);
            pos.map(|p| list.remove(p))
        };
        let Some(model) = removed else { return Ok(()) };
        if !model.custom {
            let dir = dunce_canonical(&self.dir());
            for f in &model.files {
                let p = dunce_canonical(Path::new(&f.path));
                if p.starts_with(&dir) {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
        self.save()?;
        // The projector goes with the model's last variant.
        if let Some(projector) = &model.projector {
            self.remove_if_ours(projector);
        }
        Ok(())
    }

    /// Registers a GGUF file the user already has (any model, any finetune).
    pub fn import_custom(&self, path: &Path, registry: &Registry) -> AppResult<InstalledModel> {
        let meta = std::fs::metadata(path).map_err(|_| AppError::new("not_found", path.display()))?;
        let mut magic = [0u8; 4];
        use std::io::Read;
        std::fs::File::open(path)?.read_exact(&mut magic)?;
        if &magic != b"GGUF" {
            return Err(AppError::new("not_gguf", path.display()));
        }
        let file_name = path.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        // A single-file registry variant with the same file name and size.
        let known = registry.models.iter().find_map(|m| {
            m.variants
                .iter()
                .find(|v| {
                    matches!(v.files.as_slice(), [f] if f.size_bytes == meta.len()
                        && Path::new(&f.path).file_name().is_some_and(|n| n.to_string_lossy().to_lowercase() == file_name))
                })
                .map(|v| (m, v))
        });
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "custom".into());
        let (model_id, quant, name) = match known {
            Some((m, v)) => (m.id.clone(), v.quant.clone(), m.name.clone()),
            None => (format!("custom:{stem}"), "custom".to_string(), stem),
        };
        let model = InstalledModel {
            model_id,
            quant,
            name,
            files: vec![InstalledFile {
                path: path.display().to_string(),
                size_bytes: meta.len(),
                sha256: None,
            }],
            installed_at_unix_ms: now_ms(),
            custom: true,
            projector: None,
        };
        {
            let mut list = self.manifest.lock().unwrap();
            list.retain(|m| !(m.model_id == model.model_id && m.quant == model.quant));
            list.push(model.clone());
        }
        self.save()?;
        Ok(model)
    }
}

/// What finishing a download job records.
enum Done {
    Variant(Variant),
    Projector,
}

fn find_model(registry: &Registry, model_id: &str) -> AppResult<Model> {
    registry.models.iter().find(|m| m.id == model_id).cloned().ok_or_else(|| AppError::new("unknown_model", model_id))
}

/// `general.architecture` of a GGUF file ("clip" for vision projectors), from its header.
fn gguf_architecture(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut head = Vec::new();
    std::fs::File::open(path).ok()?.take(64 << 10).read_to_end(&mut head).ok()?;
    if head.get(..4)? != b"GGUF" {
        return None;
    }
    // The key comes early in the metadata, with a string value: type 8, u64 length, bytes.
    let key = b"general.architecture";
    let at = head.windows(key.len()).position(|w| w == key)? + key.len();
    let value_type = u32::from_le_bytes(head.get(at..at + 4)?.try_into().ok()?);
    let len = u64::from_le_bytes(head.get(at + 4..at + 12)?.try_into().ok()?) as usize;
    if value_type != 8 || len > 64 {
        return None;
    }
    Some(String::from_utf8_lossy(head.get(at + 12..at + 12 + len)?).into_owned())
}

fn dunce_canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).map(|c| PathBuf::from(c.display().to_string().trim_start_matches(r"\\?\"))).unwrap_or_else(|_| p.to_path_buf())
}

fn url_encode(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_specs_use_pinned_revision_and_repo_folders() {
        let reg = registry::bundled();
        let model = reg.models.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap();
        let variant = &model.variants[0];
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path().to_path_buf());
        let specs = store.file_specs(model, variant);
        assert_eq!(specs.len(), 1);
        assert!(specs[0].url.starts_with("https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/"));
        assert!(specs[0].url.contains(&model.source.revision), "downloads are pinned to a commit");
        assert!(specs[0].dest.starts_with(dir.path().join("unsloth__Qwen3.6-35B-A3B-GGUF")));
        assert_eq!(specs[0].sha256.len(), 64);
    }

    #[test]
    fn import_rejects_non_gguf_and_accepts_gguf() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path().join("models"));
        let bad = dir.path().join("x.gguf");
        std::fs::write(&bad, b"nope").unwrap();
        let reg = registry::bundled();
        assert_eq!(store.import_custom(&bad, &reg).unwrap_err().code, "not_gguf");
        let good = dir.path().join("my-finetune.gguf");
        std::fs::write(&good, b"GGUF\x03\x00\x00\x00").unwrap();
        let m = store.import_custom(&good, &reg).unwrap();
        assert_eq!(m.model_id, "custom:my-finetune");
        assert!(m.custom);
        // survives a reload; deleting forgets it but keeps the user's file
        let store = ModelStore::new(dir.path().join("models"));
        assert_eq!(store.installed().len(), 1);
        store.delete(&m.model_id, &m.quant).unwrap();
        assert!(store.installed().is_empty());
        assert!(good.exists(), "imported files are never deleted");
    }

    #[test]
    fn importing_a_registry_file_keeps_the_model_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path().join("models"));
        // One single-file variant gets a tiny size, so a test file can match it.
        let mut reg = registry::bundled();
        let model = reg.models.iter_mut().find(|m| m.variants.iter().any(|v| v.files.len() == 1)).unwrap();
        let variant = model.variants.iter_mut().find(|v| v.files.len() == 1).unwrap();
        let content = b"GGUF\x03\x00\x00\x00padding";
        variant.files[0].size_bytes = content.len() as u64;
        let file_name = Path::new(&variant.files[0].path).file_name().unwrap().to_owned();
        let (id, quant) = (model.id.clone(), variant.quant.clone());
        let path = dir.path().join(file_name);
        std::fs::write(&path, content).unwrap();
        let m = store.import_custom(&path, &reg).unwrap();
        assert_eq!((m.model_id.as_str(), m.quant.as_str()), (id.as_str(), quant.as_str()));
        assert!(m.custom, "the file stays the user's");
        // Same name, different size: an ordinary custom model.
        std::fs::write(&path, b"GGUF\x03\x00\x00\x00").unwrap();
        assert!(store.import_custom(&path, &reg).unwrap().model_id.starts_with("custom:"));
    }

    /// A GGUF header with only `general.architecture`.
    fn gguf_with_architecture(arch: &str) -> Vec<u8> {
        let key = "general.architecture";
        let mut b = b"GGUF".to_vec();
        b.extend(3u32.to_le_bytes());
        b.extend(0u64.to_le_bytes());
        b.extend(1u64.to_le_bytes());
        b.extend((key.len() as u64).to_le_bytes());
        b.extend(key.as_bytes());
        b.extend(8u32.to_le_bytes());
        b.extend((arch.len() as u64).to_le_bytes());
        b.extend(arch.as_bytes());
        b
    }

    #[test]
    fn the_projector_downloads_next_to_the_model() {
        let reg = registry::bundled();
        let model = reg.models.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path().to_path_buf());
        let spec = store.projector_spec(model).unwrap();
        assert!(spec.url.ends_with("/mmproj-F16.gguf") && spec.url.contains(&model.source.revision), "{}", spec.url);
        assert_eq!(spec.dest, dir.path().join("unsloth__Qwen3.6-35B-A3B-GGUF").join("mmproj-F16.gguf"));
        assert_eq!(spec.sha256, model.projector.as_ref().unwrap().sha256);
        assert!(store.projector_spec(reg.models.iter().find(|m| m.id == "gpt-oss-20b").unwrap()).is_none());
    }

    #[test]
    fn image_input_is_switched_per_model() {
        let reg = registry::bundled();
        let model = reg.models.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path().join("models"));
        let file = |name: &str, bytes: &[u8]| {
            let path = store.dir().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
            InstalledFile { path: path.display().to_string(), size_bytes: bytes.len() as u64, sha256: Some("0".repeat(64)) }
        };
        store.add_variant(model, "Q4", vec![file("a.gguf", b"GGUF")]);
        store.add_variant(model, "Q8", vec![file("b.gguf", b"GGUF")]);
        let projector = file("mmproj-F16.gguf", &gguf_with_architecture("clip"));
        store.set_projector_of(&model.id, Some(projector.clone()));
        store.save().unwrap();
        // A variant downloaded later loads it too; the switch is per model.
        store.add_variant(model, "Q6", vec![file("c.gguf", b"GGUF")]);
        assert!(store.installed().iter().all(|m| m.projector.as_ref() == Some(&projector)));
        // The manifest keeps it across restarts.
        let store = ModelStore::new(dir.path().join("models"));
        assert_eq!(store.find(&model.id, "Q8").unwrap().projector, Some(projector.clone()));

        // Deleting a variant keeps the projector for the others; the last one takes it along.
        store.delete(&model.id, "Q4").unwrap();
        store.delete(&model.id, "Q6").unwrap();
        assert!(Path::new(&projector.path).exists());
        store.delete(&model.id, "Q8").unwrap();
        assert!(!Path::new(&projector.path).exists());

        // Off: no longer loaded, and the downloaded file is gone.
        store.add_variant(model, "Q4", vec![file("a.gguf", b"GGUF")]);
        let projector = file("mmproj-F16.gguf", &gguf_with_architecture("clip"));
        store.set_projector_of(&model.id, Some(projector.clone()));
        store.disable_projector(&model.id).unwrap();
        assert!(store.installed().iter().all(|m| m.projector.is_none()));
        assert!(!Path::new(&projector.path).exists());
    }

    #[test]
    fn an_imported_model_takes_a_projector_the_user_picks() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path().join("models"));
        let reg = registry::bundled();
        let model = dir.path().join("my-vlm.gguf");
        std::fs::write(&model, gguf_with_architecture("qwen35")).unwrap();
        let m = store.import_custom(&model, &reg).unwrap();
        assert_eq!(m.projector, None, "off after import");

        assert_eq!(store.use_projector_file(&m.model_id, &model).unwrap_err().code, "not_projector", "the model itself is no projector");
        let text = dir.path().join("notes.gguf");
        std::fs::write(&text, b"not a gguf").unwrap();
        assert_eq!(store.use_projector_file(&m.model_id, &text).unwrap_err().code, "not_projector");
        let mmproj = dir.path().join("mmproj-my-vlm.gguf");
        std::fs::write(&mmproj, gguf_with_architecture("clip")).unwrap();
        assert_eq!(store.use_projector_file("custom:other", &mmproj).unwrap_err().code, "model_not_installed");
        let with = store.use_projector_file(&m.model_id, &mmproj).unwrap();
        assert_eq!(with.projector.as_ref().map(|p| p.path.clone()), Some(mmproj.display().to_string()));
        assert_eq!(with.projector.unwrap().sha256, None);

        // Switching it off keeps the user's file.
        store.disable_projector(&m.model_id).unwrap();
        assert!(mmproj.exists() && store.installed()[0].projector.is_none());
    }

    #[test]
    fn manifests_without_projectors_still_load() {
        let old = r#"{"modelId":"m","quant":"Q4","name":"M","files":[],"installedAtUnixMs":0,"custom":false}"#;
        assert_eq!(serde_json::from_str::<InstalledModel>(old).unwrap().projector, None);
    }

    #[test]
    fn url_encoding_keeps_safe_characters() {
        assert_eq!(url_encode("Qwen3.6-35B_A3B~x.gguf"), "Qwen3.6-35B_A3B~x.gguf");
        assert_eq!(url_encode("a b+c"), "a%20b%2Bc");
    }
}
