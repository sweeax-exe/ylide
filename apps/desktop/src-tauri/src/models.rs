//! Installed models and download jobs.
//!
//! Layout: `<models dir>/<publisher>__<repo>/<file path in repo>`. Files are
//! keyed by repository + path (some repos use identical file names), and the
//! SHA-256 from the registry is verified before a file counts as installed.

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
}

impl InstalledModel {
    /// The file llama-server is started with (first part of split GGUFs).
    pub fn primary_path(&self) -> Option<&str> {
        self.files.first().map(|f| f.path.as_str())
    }
}

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
    pub quant: String,
    pub name: String,
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
            // Drop entries whose files were deleted outside the app.
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

    /// Starts (or resumes) a download. Progress is emitted as `models://job`.
    pub fn start_download(
        self: &Arc<Self>,
        app: &AppHandle,
        gate: Arc<NetworkGate>,
        registry: &Registry,
        model_id: &str,
        quant: &str,
    ) -> AppResult<DownloadJob> {
        let model = registry
            .models
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| AppError::new("unknown_model", model_id))?
            .clone();
        let variant = model
            .variants
            .iter()
            .find(|v| v.quant == quant)
            .ok_or_else(|| AppError::new("unknown_variant", quant))?
            .clone();
        let specs = self.file_specs(&model, &variant);
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

        let id = job_id(model_id, quant);
        let cancel = CancellationToken::new();
        let job = DownloadJob {
            job_id: id.clone(),
            model_id: model_id.to_string(),
            quant: quant.to_string(),
            name: format!("{} {}", model.name, quant),
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
                    let installed = InstalledModel {
                        model_id: model.id.clone(),
                        quant: variant.quant.clone(),
                        name: model.name.clone(),
                        files: specs
                            .iter()
                            .map(|s| InstalledFile {
                                path: s.dest.display().to_string(),
                                size_bytes: s.size_bytes,
                                sha256: Some(s.sha256.clone()),
                            })
                            .collect(),
                        installed_at_unix_ms: now_ms(),
                        custom: false,
                    };
                    {
                        let mut list = store.manifest.lock().unwrap();
                        list.retain(|m| !(m.model_id == installed.model_id && m.quant == installed.quant));
                        list.push(installed);
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
            if let Some(model) = registry.models.iter().find(|m| m.id == model_id)
                && let Some(variant) = model.variants.iter().find(|v| v.quant == quant)
            {
                downloader::discard_partial(&self.file_specs(model, variant)).await?;
            }
        }
        Ok(())
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
        self.save()
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

    #[test]
    fn url_encoding_keeps_safe_characters() {
        assert_eq!(url_encode("Qwen3.6-35B_A3B~x.gguf"), "Qwen3.6-35B_A3B~x.gguf");
        assert_eq!(url_encode("a b+c"), "a%20b%2Bc");
    }
}
