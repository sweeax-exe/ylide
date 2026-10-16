//! Watches the open project and tells the UI which paths changed (debounced,
//! batched), so the file tree and open editors stay in sync with changes made
//! by agents, the terminal or other programs.

use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct ProjectWatcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

/// Directories whose churn is never interesting for the UI.
fn ignored(rel: &str) -> bool {
    rel.split('/').any(|c| matches!(c, ".git" | "node_modules" | "target" | ".venv" | "__pycache__" | "dist" | ".next"))
}

impl ProjectWatcher {
    pub fn start(app: AppHandle, root: PathBuf) -> notify::Result<Self> {
        let root_for_events = root.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(250), None, move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let mut paths: Vec<String> = events
                .iter()
                .flat_map(|e| e.paths.iter())
                .filter_map(|p| relative(&root_for_events, p))
                .filter(|rel| !ignored(rel))
                .collect();
            paths.sort();
            paths.dedup();
            if !paths.is_empty() {
                let _ = app.emit("fs://changed", &paths);
            }
        })?;
        debouncer.watch(&root, RecursiveMode::Recursive)?;
        Ok(Self { _debouncer: debouncer })
    }
}

fn relative(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    Some(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn ignores_build_and_vcs_folders() {
        assert!(super::ignored(".git/index"));
        assert!(super::ignored("web/node_modules/x/y.js"));
        assert!(super::ignored("target/debug/app"));
        assert!(!super::ignored("src/target.rs"));
    }
}
