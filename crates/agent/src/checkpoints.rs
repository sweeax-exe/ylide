//! Undo for agent changes.
//!
//! Before an agent touches a file, its current state (content, or "did not
//! exist") is stored once per checkpoint. Blobs are content-addressed
//! (SHA-256) and shared; run manifests are small JSON files. Restoring a
//! checkpoint undoes every change made at or after it.
//!
//! Shell commands can have effects outside tracked files; the UI says so.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;
use workspace::Workspace;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckpointFile {
    pub path: String,
    pub existed: bool,
    /// SHA-256 of the previous content when it existed.
    pub blob: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Checkpoint {
    pub id: String,
    pub run_id: String,
    pub seq: u32,
    /// e.g. "T2: Add input validation (coder)"
    pub label: String,
    #[ts(type = "number")]
    pub created_at_unix_ms: u64,
    pub files: Vec<CheckpointFile>,
}

pub struct CheckpointStore {
    dir: PathBuf,
    runs: Mutex<HashMap<String, Vec<Checkpoint>>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl CheckpointStore {
    /// `dir` is per project, e.g. `<app data>/checkpoints/<hash of project path>`.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            runs: Mutex::new(HashMap::new()),
        }
    }

    fn run_file(&self, run_id: &str) -> PathBuf {
        let safe: String = run_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        self.dir.join("runs").join(format!("{safe}.json"))
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.dir.join("blobs").join(&hash[..2]).join(hash)
    }

    fn with_run<T>(&self, run_id: &str, f: impl FnOnce(&mut Vec<Checkpoint>) -> io::Result<T>) -> io::Result<T> {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        if !runs.contains_key(run_id) {
            let loaded = fs::read_to_string(self.run_file(run_id))
                .ok()
                .and_then(|s| serde_json::from_str::<Vec<Checkpoint>>(&s).ok())
                .unwrap_or_default();
            runs.insert(run_id.to_string(), loaded);
        }
        let cps = runs.get_mut(run_id).expect("inserted above");
        let out = f(cps)?;
        let path = self.run_file(run_id);
        fs::create_dir_all(path.parent().expect("runs dir"))?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(cps)?)?;
        fs::rename(tmp, path)?;
        Ok(out)
    }

    /// Starts a new checkpoint in `run_id`.
    pub fn begin(&self, run_id: &str, label: &str) -> io::Result<Checkpoint> {
        self.with_run(run_id, |cps| {
            let seq = cps.last().map(|c| c.seq + 1).unwrap_or(1);
            let cp = Checkpoint {
                id: format!("{run_id}-{seq}"),
                run_id: run_id.to_string(),
                seq,
                label: label.to_string(),
                created_at_unix_ms: now_ms(),
                files: vec![],
            };
            cps.push(cp.clone());
            Ok(cp)
        })
    }

    /// Records the state of `rel` before it is changed (once per checkpoint).
    pub fn snapshot_before(&self, run_id: &str, checkpoint_id: &str, ws: &Workspace, rel: &str) -> io::Result<()> {
        let abs = ws.resolve(rel).map_err(io::Error::other)?;
        let rel = ws.relative(&abs).unwrap_or_else(|| rel.to_string());
        self.with_run(run_id, |cps| {
            let cp = cps
                .iter_mut()
                .find(|c| c.id == checkpoint_id)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown checkpoint"))?;
            if cp.files.iter().any(|f| f.path == rel) {
                return Ok(());
            }
            let entry = match fs::read(&abs) {
                Ok(bytes) => {
                    let hash = hex::encode(Sha256::digest(&bytes));
                    let blob = self.blob_path(&hash);
                    if !blob.exists() {
                        fs::create_dir_all(blob.parent().expect("blob dir"))?;
                        fs::write(&blob, &bytes)?;
                    }
                    CheckpointFile {
                        path: rel.clone(),
                        existed: true,
                        blob: Some(hash),
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => CheckpointFile {
                    path: rel.clone(),
                    existed: false,
                    blob: None,
                },
                Err(e) => return Err(e),
            };
            cp.files.push(entry);
            Ok(())
        })
    }

    pub fn list(&self, run_id: &str) -> Vec<Checkpoint> {
        self.with_run(run_id, |cps| Ok(cps.clone())).unwrap_or_default()
    }

    /// Content of a file as it was before the checkpoint (None = did not exist).
    pub fn original(&self, file: &CheckpointFile) -> io::Result<Option<Vec<u8>>> {
        match &file.blob {
            Some(hash) if file.existed => fs::read(self.blob_path(hash)).map(Some),
            _ => Ok(None),
        }
    }

    /// Undoes all changes made at or after `checkpoint_id` and forgets those
    /// checkpoints. Returns the restored paths.
    pub fn restore(&self, run_id: &str, checkpoint_id: &str, ws: &Workspace) -> io::Result<Vec<String>> {
        self.with_run(run_id, |cps| {
            let target = cps
                .iter()
                .find(|c| c.id == checkpoint_id)
                .map(|c| c.seq)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown checkpoint"))?;
            // Earliest recorded state per path among the undone checkpoints.
            let mut earliest: BTreeMap<String, CheckpointFile> = BTreeMap::new();
            for cp in cps.iter().filter(|c| c.seq >= target) {
                for f in &cp.files {
                    earliest.entry(f.path.clone()).or_insert_with(|| f.clone());
                }
            }
            for f in earliest.values() {
                let abs = ws.resolve(&f.path).map_err(io::Error::other)?;
                match self.original(f)? {
                    Some(bytes) => {
                        if let Some(parent) = abs.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        fs::write(&abs, bytes)?;
                    }
                    None => match fs::remove_file(&abs) {
                        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                        _ => {}
                    },
                }
            }
            cps.retain(|c| c.seq < target);
            Ok(earliest.into_keys().collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(name: &str) -> (Workspace, PathBuf, CheckpointStore) {
        let base = std::env::temp_dir().join(format!("cp-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let proj = base.join("project");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("a.txt"), "original a").unwrap();
        let ws = Workspace::open(&proj).unwrap();
        (ws, proj, CheckpointStore::new(base.join("store")))
    }

    #[test]
    fn restores_modified_created_and_deleted_files() {
        let (ws, proj, store) = setup("restore");
        let cp1 = store.begin("run1", "T1").unwrap();
        store.snapshot_before("run1", &cp1.id, &ws, "a.txt").unwrap();
        fs::write(proj.join("a.txt"), "changed").unwrap();
        store.snapshot_before("run1", &cp1.id, &ws, "new/b.txt").unwrap();
        fs::create_dir_all(proj.join("new")).unwrap();
        fs::write(proj.join("new/b.txt"), "created").unwrap();

        let cp2 = store.begin("run1", "T2").unwrap();
        store.snapshot_before("run1", &cp2.id, &ws, "a.txt").unwrap(); // state "changed"
        fs::remove_file(proj.join("a.txt")).unwrap();

        // Undo only T2: a.txt comes back as "changed"
        let restored = store.restore("run1", &cp2.id, &ws).unwrap();
        assert_eq!(restored, vec!["a.txt"]);
        assert_eq!(fs::read_to_string(proj.join("a.txt")).unwrap(), "changed");
        assert_eq!(store.list("run1").len(), 1);

        // Undo T1: everything back to the start
        store.restore("run1", &cp1.id, &ws).unwrap();
        assert_eq!(fs::read_to_string(proj.join("a.txt")).unwrap(), "original a");
        assert!(!proj.join("new/b.txt").exists());
        assert!(store.list("run1").is_empty());
    }

    #[test]
    fn snapshot_is_taken_once_per_checkpoint() {
        let (ws, proj, store) = setup("once");
        let cp = store.begin("r", "x").unwrap();
        store.snapshot_before("r", &cp.id, &ws, "a.txt").unwrap();
        fs::write(proj.join("a.txt"), "v2").unwrap();
        store.snapshot_before("r", &cp.id, &ws, "a.txt").unwrap();
        fs::write(proj.join("a.txt"), "v3").unwrap();
        store.restore("r", &cp.id, &ws).unwrap();
        assert_eq!(fs::read_to_string(proj.join("a.txt")).unwrap(), "original a");
    }

    #[test]
    fn manifests_survive_restart() {
        let (ws, proj, store) = setup("persist");
        let cp = store.begin("r", "x").unwrap();
        store.snapshot_before("r", &cp.id, &ws, "a.txt").unwrap();
        fs::write(proj.join("a.txt"), "edited").unwrap();
        let dir = store.dir.clone();
        drop(store);
        let reopened = CheckpointStore::new(dir);
        assert_eq!(reopened.list("r").len(), 1);
        reopened.restore("r", &cp.id, &ws).unwrap();
        assert_eq!(fs::read_to_string(proj.join("a.txt")).unwrap(), "original a");
    }

    #[test]
    fn refuses_paths_outside_project() {
        let (ws, _, store) = setup("outside");
        let cp = store.begin("r", "x").unwrap();
        assert!(store.snapshot_before("r", &cp.id, &ws, "../evil.txt").is_err());
    }
}
