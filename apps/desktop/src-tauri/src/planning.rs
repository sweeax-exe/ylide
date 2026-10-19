//! Planning mode in the app: the agents panel switches between planning
//! ("Planen": agents only read and write a plan) and carrying it out
//! ("Umsetzen"). The plan, the mode and the conversation about the plan are
//! kept per project on this computer (`<local data>/agent-plans/<project
//! key>.json`), so they survive a restart like the last run.

use crate::agents::{Work, checkpoint_store, launch};
use crate::chats::write_atomic;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use agent::tools::{ShellConfig, ToolEnv, execute};
use agent::{AgentEvent, FileChange, PlanDoc, PlanRequest};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

/// "Planen" or "Umsetzen".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WorkMode {
    Plan,
    #[default]
    Code,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PlanNoteKind {
    /// The user's wish for the plan.
    Wish,
    /// The user's answers to the plan's open questions.
    Answers,
    /// The orchestrator wrote or changed the plan.
    Updated,
    /// The orchestrator could not write a plan.
    Failed,
    /// A run stopped for planning; its open tasks are the plan now.
    TookOver,
}

/// One entry of the conversation about the plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanNote {
    pub kind: PlanNoteKind,
    #[serde(default)]
    pub text: String,
}

/// Planning mode of one project.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct PlanState {
    pub mode: WorkMode,
    pub plan: Option<PlanDoc>,
    /// The stopped run whose open tasks the plan holds; carrying the plan out continues it.
    pub continues: Option<String>,
    pub notes: Vec<PlanNote>,
}

/// Notes kept per plan; older ones fall away.
const MAX_NOTES: usize = 40;

#[derive(Debug, Clone)]
pub struct PlanStore {
    root: PathBuf,
}

impl PlanStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn file(&self, project: &Path) -> PathBuf {
        self.root.join(format!("{}.json", crate::paths::project_key(project)))
    }

    /// The project's planning mode; the default when there is none or it cannot be read.
    pub fn load(&self, project: &Path) -> PlanState {
        fs::read_to_string(self.file(project)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, project: &Path, state: &PlanState) -> AppResult<()> {
        let mut state = state.clone();
        let extra = state.notes.len().saturating_sub(MAX_NOTES);
        state.notes.drain(..extra);
        fs::create_dir_all(&self.root)?;
        write_atomic(&self.file(project), &serde_json::to_vec_pretty(&state)?)?;
        Ok(())
    }
}

/// Where a saved plan may go: a Markdown file under docs/plans/.
fn plan_file_path(path: &str) -> AppResult<String> {
    let path = path.trim().replace('\\', "/");
    let ok = path.starts_with("docs/plans/")
        && path.ends_with(".md")
        && !path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        && path.len() < 200;
    if ok { Ok(path) } else { Err(AppError::new("invalid_path", "a plan is saved as docs/plans/<name>.md")) }
}

/// Writes a plan into the project through the agents' write path: a
/// checkpoint first, so it can be undone, and a change record.
pub async fn write_plan_file(state: &AppState, path: &str, content: &str) -> AppResult<FileChange> {
    let path = plan_file_path(path)?;
    let ws = state.workspace()?;
    let store = checkpoint_store(state)?;
    let run_id = format!("plan-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let checkpoint = store.begin(&run_id, &format!("Plan saved as {path}"))?;
    // Saving again over the same file is what the user asked for.
    let read = Mutex::new(HashSet::from([path.clone()]));
    let cancel = CancellationToken::new();
    let shell = ShellConfig::default();
    let env = ToolEnv {
        ws: &ws,
        checkpoints: &store,
        run_id: &run_id,
        checkpoint_id: &checkpoint.id,
        shell: &shell,
        cancel: &cancel,
        read_files: &read,
        skills: &[],
        skill_chars: 0,
    };
    let outcome = execute("write_file", &serde_json::json!({ "path": path, "content": content }), &env).await;
    match outcome.change {
        Some(change) if outcome.ok => Ok(change),
        _ => Err(AppError::new("write_failed", outcome.summary)),
    }
}

// ---------------------------------------------------------------- commands

type Cmd<T> = Result<T, AppError>;

/// The open project's planning mode (the default without a project).
#[tauri::command]
pub fn plan_state(state: State<'_, AppState>) -> Cmd<PlanState> {
    Ok(state.workspace().map(|ws| state.plans.load(ws.root())).unwrap_or_default())
}

#[tauri::command]
pub fn plan_state_save(state: State<'_, AppState>, plan_state: PlanState) -> Cmd<()> {
    state.plans.save(state.workspace()?.root(), &plan_state)
}

/// Planning mode: the orchestrator reads the project and writes a plan for
/// `goal`, or changes `plan` as `wish` says. With `continues`, the plan holds
/// the open tasks of that stopped run. The plan comes as `planDrafted`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plan_draft(
    state: State<'_, AppState>,
    goal: String,
    plan: Option<PlanDoc>,
    wish: Option<String>,
    earlier_wishes: Option<Vec<String>>,
    continues: Option<String>,
    images: Option<Vec<String>>,
    language: Option<String>,
    on_event: Channel<AgentEvent>,
) -> Cmd<String> {
    let request = PlanRequest { goal, current: plan, wish, earlier_wishes: earlier_wishes.unwrap_or_default() };
    launch(&state, Work::Draft { request, continues }, images.unwrap_or_default(), language.unwrap_or_else(|| "en".into()), on_event).await
}

/// Carries out a plan: its steps become the tasks, with their ids.
#[tauri::command]
pub async fn plan_run(state: State<'_, AppState>, plan: PlanDoc, continues: Option<String>, language: Option<String>, on_event: Channel<AgentEvent>) -> Cmd<String> {
    if plan.steps.is_empty() {
        return Err(AppError::new("empty_plan", "the plan has no steps"));
    }
    launch(&state, Work::Plan { plan, continues }, vec![], language.unwrap_or_else(|| "en".into()), on_event).await
}

/// The user switched to planning during a run (`on`): the current task
/// finishes, then the run stops. `false` takes that back.
#[tauri::command]
pub fn agent_handover(state: State<'_, AppState>, run_id: String, on: bool) -> Cmd<()> {
    state.agents.get(&run_id)?.ctx.control.stop_after_task(on);
    Ok(())
}

/// Saves the plan (Markdown the UI wrote) as a file of the project.
#[tauri::command]
pub async fn plan_write_file(state: State<'_, AppState>, path: String, content: String) -> Cmd<FileChange> {
    write_plan_file(&state, &path, &content).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent::PlanStep;

    #[test]
    fn plan_files_go_to_docs_plans_only() {
        assert_eq!(plan_file_path("docs/plans/2026-10-17-rabatte.md").unwrap(), "docs/plans/2026-10-17-rabatte.md");
        assert_eq!(plan_file_path("docs\\plans\\a.md").unwrap(), "docs/plans/a.md");
        for bad in ["src/main.rs", "docs/plans/../../x.md", "docs/plans/a.txt", "/docs/plans/a.md", "docs/plans//a.md", "docs/plansx/a.md", "C:/docs/plans/a.md"] {
            assert!(plan_file_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_plan_of_a_project_survives_and_keeps_few_notes() {
        let dir = tempfile::tempdir().unwrap();
        let store = PlanStore::new(dir.path().join("agent-plans"));
        let project = Path::new("D:/shop");
        assert_eq!(store.load(project), PlanState::default(), "nothing kept yet: carrying out, no plan");
        let plan = PlanDoc {
            goal: "Rabatte".into(),
            approach: "Erst das Modell.".into(),
            steps: vec![PlanStep { id: "T1".into(), title: "Modell".into(), description: String::new(), files: vec![], verify: String::new(), assignee: "coder".into() }],
            risks: vec![],
            questions: vec![],
        };
        let state = PlanState {
            mode: WorkMode::Plan,
            plan: Some(plan),
            continues: Some("run-1".into()),
            notes: (0..50).map(|i| PlanNote { kind: PlanNoteKind::Wish, text: format!("wish {i}") }).collect(),
        };
        store.save(project, &state).unwrap();
        let back = store.load(project);
        assert_eq!((back.mode, back.plan, back.continues.as_deref()), (WorkMode::Plan, state.plan.clone(), Some("run-1")));
        assert_eq!(back.notes.len(), MAX_NOTES);
        assert_eq!(back.notes[0].text, "wish 10", "the oldest notes fall away");
        assert_eq!(store.load(Path::new("D:/other")), PlanState::default());
        // Files written by an older version, or broken ones, give the default.
        std::fs::write(store.file(project), r#"{"mode":"plan"}"#).unwrap();
        assert_eq!(store.load(project).mode, WorkMode::Plan);
        std::fs::write(store.file(project), "{ broken").unwrap();
        assert_eq!(store.load(project), PlanState::default());
    }

    #[tokio::test]
    async fn a_saved_plan_goes_through_the_write_path_with_a_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace::Workspace::open(dir.path()).unwrap();
        let store = agent::CheckpointStore::new(dir.path().join(".checkpoints-test"));
        let checkpoint = store.begin("plan-1", "Plan saved").unwrap();
        let read = Mutex::new(HashSet::from(["docs/plans/a.md".to_string()]));
        let (cancel, shell) = (CancellationToken::new(), ShellConfig::default());
        let env = ToolEnv { ws: &ws, checkpoints: &store, run_id: "plan-1", checkpoint_id: &checkpoint.id, shell: &shell, cancel: &cancel, read_files: &read, skills: &[], skill_chars: 0 };
        let first = execute("write_file", &serde_json::json!({ "path": "docs/plans/a.md", "content": "# Plan\n" }), &env).await;
        assert!(first.ok, "{}", first.output);
        let again = execute("write_file", &serde_json::json!({ "path": "docs/plans/a.md", "content": "# Plan 2\n" }), &env).await;
        assert!(again.ok, "saving again replaces the file: {}", again.output);
        assert_eq!(std::fs::read_to_string(dir.path().join("docs/plans/a.md")).unwrap(), "# Plan 2\n");
        let cps = store.list("plan-1");
        assert_eq!(cps[0].files.len(), 1, "the checkpoint knows the file");
        store.restore("plan-1", &cps[0].id, &ws).unwrap();
        assert!(!dir.path().join("docs/plans/a.md").exists(), "undoing removes the new file");
    }
}
