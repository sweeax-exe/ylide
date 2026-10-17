//! The last agent run of each project, kept on this computer so "Continue"
//! still works after Ylide was closed: `<local data>/agent-runs/<project key>.json`.
//!
//! Only a short record is kept: the request, how the run ended, the tasks with
//! their status and result, and which files changed (without the diffs). The
//! agents' conversations with the model and the activity log are not stored.

use crate::chats::write_atomic;
use crate::error::AppResult;
use agent::{Blackboard, FileChange, Plan, PreviousRun, RunOutcome};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LastRun {
    pub run_id: String,
    pub goal: String,
    #[ts(type = "number")]
    pub started_at_unix_ms: u64,
    #[ts(type = "number")]
    pub finished_at_unix_ms: u64,
    pub outcome: RunOutcome,
    /// The plain task list (English).
    pub summary: String,
    /// The orchestrator's summary in the user's language (none in records
    /// written before it existed, for stopped runs, or when it failed).
    #[serde(default)]
    pub recap: Option<String>,
    pub plan: Option<Plan>,
    /// File changes in order, without their diffs.
    pub changes: Vec<FileChange>,
    /// Requests of the runs it continued, oldest first.
    pub earlier_goals: Vec<String>,
}

impl LastRun {
    /// What a run that continues this one is told about it.
    pub fn as_previous(&self) -> PreviousRun {
        let board = Blackboard {
            plan: self.plan.clone(),
            messages: vec![],
            changed_files: self.changes.iter().map(|c| c.path.clone()).collect(),
        };
        PreviousRun::new(&self.goal, self.outcome, &self.summary, &board, self.earlier_goals.clone()).with_recap(self.recap.clone())
    }
}

/// Adds `change` without its diff; a repeat of the file's last change adds nothing.
pub fn record_change(changes: &mut Vec<FileChange>, change: &FileChange) {
    if changes.iter().rev().find(|c| c.path == change.path).is_some_and(|c| c.kind == change.kind) {
        return;
    }
    changes.push(FileChange { diff: String::new(), ..change.clone() });
}

#[derive(Debug, Clone)]
pub struct LastRuns {
    root: PathBuf,
}

impl LastRuns {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn file(&self, project: &Path) -> PathBuf {
        self.root.join(format!("{}.json", crate::paths::project_key(project)))
    }

    /// The project's last run; none when there is no record or it cannot be read.
    pub fn load(&self, project: &Path) -> Option<LastRun> {
        let text = fs::read_to_string(self.file(project)).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Replaces the project's record.
    pub fn save(&self, project: &Path, run: &LastRun) -> AppResult<()> {
        fs::create_dir_all(&self.root)?;
        write_atomic(&self.file(project), &serde_json::to_vec_pretty(run)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent::{ChangeKind, Task, TaskStatus};

    fn record(run_id: &str) -> LastRun {
        let task = |id: &str, status| Task {
            id: id.into(),
            title: format!("task {id}"),
            description: String::new(),
            files: vec![],
            assignee: "coder".into(),
            status,
            attempts: 0,
            result: None,
            review: None,
        };
        LastRun {
            run_id: run_id.into(),
            goal: "Add a cart".into(),
            started_at_unix_ms: 1_000,
            finished_at_unix_ms: 9_000,
            outcome: RunOutcome::Cancelled,
            summary: "✔ T1 task T1".into(),
            recap: Some("Das Warenkorb-Modell steht, die Ansicht fehlt noch.".into()),
            plan: Some(Plan {
                goal: "Add a cart".into(),
                summary: "Model, then view.".into(),
                tasks: vec![task("T1", TaskStatus::Done), task("T2", TaskStatus::Skipped)],
            }),
            changes: vec![FileChange {
                path: "src/cart.ts".into(),
                kind: ChangeKind::Created,
                diff: String::new(),
                checkpoint_id: format!("{run_id}-1"),
            }],
            earlier_goals: vec!["Set up the shop".into()],
        }
    }

    fn store(name: &str) -> LastRuns {
        let dir = std::env::temp_dir().join(format!("last-run-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        LastRuns::new(dir)
    }

    #[test]
    fn keeps_one_run_per_project() {
        let runs = store("projects");
        let (shop, blog) = (Path::new("D:/projects/shop"), Path::new("D:/projects/blog"));
        assert_eq!(runs.load(shop), None);
        runs.save(shop, &record("run-1")).unwrap();
        runs.save(blog, &record("run-2")).unwrap();
        runs.save(shop, &record("run-3")).unwrap();
        assert_eq!(runs.load(shop).unwrap().run_id, "run-3");
        assert_eq!(runs.load(blog).unwrap().run_id, "run-2");
        // The key ignores letter case, like Windows paths.
        assert_eq!(runs.load(Path::new("d:/Projects/SHOP")).unwrap().run_id, "run-3");
    }

    #[test]
    fn records_from_before_the_summary_still_load() {
        let runs = store("old-record");
        let shop = Path::new("D:/projects/shop");
        let mut old = serde_json::to_value(record("run-1")).unwrap();
        old.as_object_mut().unwrap().remove("recap");
        fs::create_dir_all(&runs.root).unwrap();
        fs::write(runs.file(shop), serde_json::to_vec(&old).unwrap()).unwrap();
        let loaded = runs.load(shop).expect("old record loads");
        assert_eq!(loaded.recap, None);
        assert_eq!(loaded.run_id, "run-1");
    }

    #[test]
    fn a_broken_record_is_no_record() {
        let runs = store("broken");
        let shop = Path::new("D:/projects/shop");
        runs.save(shop, &record("run-1")).unwrap();
        fs::write(runs.file(shop), "{ not json").unwrap();
        assert_eq!(runs.load(shop), None);
    }

    #[test]
    fn a_stored_run_can_be_continued() {
        let previous = record("run-1").as_previous();
        assert_eq!(previous.goal, "Add a cart");
        assert_eq!(previous.changed_files, vec!["src/cart.ts"]);
        assert_eq!(previous.earlier_goals, vec!["Set up the shop"]);
        assert_eq!(previous.recap.as_deref(), Some("Das Warenkorb-Modell steht, die Ansicht fehlt noch."));
        let open: Vec<String> = previous.open_tasks().into_iter().map(|t| t.id).collect();
        assert_eq!(open, vec!["T2"]);
    }

    #[test]
    fn changes_are_kept_without_diffs_and_repeats() {
        let change = |path: &str, kind| FileChange { path: path.into(), kind, diff: "--- a\n+++ b".into(), checkpoint_id: "c".into() };
        let mut changes = vec![];
        for c in [
            change("a.ts", ChangeKind::Modified),
            change("a.ts", ChangeKind::Modified),
            change("b.ts", ChangeKind::Created),
            change("a.ts", ChangeKind::Modified),
            change("b.ts", ChangeKind::Deleted),
        ] {
            record_change(&mut changes, &c);
        }
        let kinds: Vec<(&str, ChangeKind)> = changes.iter().map(|c| (c.path.as_str(), c.kind)).collect();
        assert_eq!(kinds, vec![("a.ts", ChangeKind::Modified), ("b.ts", ChangeKind::Created), ("b.ts", ChangeKind::Deleted)]);
        assert!(changes.iter().all(|c| c.diff.is_empty()));
    }
}
