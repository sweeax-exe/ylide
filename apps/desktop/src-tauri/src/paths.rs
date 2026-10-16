//! Where Ylide keeps its files. Everything is per user and local:
//!
//! * config (`settings.json`): roaming config dir
//! * cache (registry copy): cache dir
//! * models, runtimes, checkpoints, run files: local data dir (large, never roams)
//!
//! The folders are named after the app identifier (`app.ylide`). Before Tauri
//! starts, `migration` moves the folders of the old identifier there.

use crate::error::AppResult;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub config: PathBuf,
    pub cache: PathBuf,
    pub data: PathBuf,
    pub default_models: PathBuf,
    pub runtimes: PathBuf,
    pub checkpoints: PathBuf,
    /// Key and pid files of running servers.
    pub run: PathBuf,
    pub logs: PathBuf,
    /// Folders that may contain runtimes shipped with the app.
    pub bundled_runtimes: Vec<PathBuf>,
}

impl AppPaths {
    pub fn resolve(app: &AppHandle) -> AppResult<Self> {
        let p = app.path();
        let config = p.app_config_dir()?;
        let cache = p.app_cache_dir()?;
        let data = p.app_local_data_dir()?;
        let mut bundled_runtimes = Vec::new();
        if let Ok(resources) = p.resource_dir() {
            bundled_runtimes.push(resources.join("runtime"));
        }
        // `tauri dev` runs from the source tree.
        if cfg!(debug_assertions) {
            bundled_runtimes.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("runtime"));
        }
        let paths = Self {
            default_models: data.join("models"),
            runtimes: data.join("runtimes"),
            checkpoints: data.join("checkpoints"),
            run: data.join("run"),
            logs: data.join("logs"),
            config,
            cache,
            data,
            bundled_runtimes,
        };
        for dir in [&paths.config, &paths.cache, &paths.data, &paths.run, &paths.logs] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(paths)
    }

    /// Per-project checkpoint folder (hash of the project path).
    pub fn checkpoints_for(&self, project_root: &std::path::Path) -> PathBuf {
        use sha2::{Digest, Sha256};
        let key = project_root.display().to_string().to_lowercase();
        let hash = hex::encode(Sha256::digest(key.as_bytes()));
        self.checkpoints.join(&hash[..16])
    }
}
