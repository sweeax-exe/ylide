//! Agent runs in the app: wires the orchestrator to the UI (events over a
//! Tauri channel, approvals and questions answered from dialogs).

use crate::chat::{Mode, apply_mode};
use crate::error::{AppError, AppResult};
use crate::runtime::ChatHandle;
use crate::state::AppState;
use agent::llm::ChatModel;
use agent::permissions::{ApprovalBroker, ApprovalRequest, ApprovalResponse, UserReply};
use crate::last_run::{LastRun, record_change};
use agent::{AgentEvent, CheckpointStore, FileChange, PreviousRun, RunContext, RunOutcome, ScheduledModel, Team};
use async_trait::async_trait;
use inference::{ChatRequest, ChatResult, Delta, LlmError, Priority};
use registry::Model;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

type EventSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Answers approvals and agent questions from the UI.
#[derive(Default)]
pub struct UiBroker {
    approvals: Mutex<HashMap<String, oneshot::Sender<ApprovalResponse>>>,
    questions: Mutex<HashMap<String, oneshot::Sender<UserReply>>>,
    events: Mutex<Option<EventSink>>,
    run_id: Mutex<String>,
    counter: Mutex<u64>,
}

impl UiBroker {
    pub fn resolve_approval(&self, request_id: &str, response: ApprovalResponse) -> bool {
        self.approvals.lock().unwrap().remove(request_id).map(|tx| tx.send(response).is_ok()).unwrap_or(false)
    }

    pub fn resolve_question(&self, question_id: &str, answer: UserReply) -> bool {
        self.questions.lock().unwrap().remove(question_id).map(|tx| tx.send(answer).is_ok()).unwrap_or(false)
    }
}

#[async_trait]
impl ApprovalBroker for UiBroker {
    async fn request_approval(&self, request: ApprovalRequest) -> ApprovalResponse {
        let (tx, rx) = oneshot::channel();
        self.approvals.lock().unwrap().insert(request.id.clone(), tx);
        // The runner already emitted `ApprovalRequested`; wait for the click.
        rx.await.unwrap_or(ApprovalResponse::Reject {
            reason: Some("the run was closed".into()),
        })
    }

    async fn ask_user(&self, agent_id: &str, question: &str) -> UserReply {
        let id = {
            let mut c = self.counter.lock().unwrap();
            *c += 1;
            format!("question-{c}")
        };
        let (tx, rx) = oneshot::channel();
        self.questions.lock().unwrap().insert(id.clone(), tx);
        if let Some(emit) = self.events.lock().unwrap().clone() {
            emit(AgentEvent::QuestionForUser {
                run_id: self.run_id.lock().unwrap().clone(),
                question_id: id,
                agent_id: agent_id.to_string(),
                question: question.to_string(),
            });
        }
        rx.await.unwrap_or_else(|_| UserReply::text("(no answer)"))
    }
}

/// A scheduled model that applies the registry's agent-mode defaults.
pub(crate) struct AgentModel {
    pub(crate) inner: ScheduledModel,
    pub(crate) model: Option<Model>,
    /// Its vision projector is loaded.
    pub(crate) vision: bool,
}

/// The registry's agent defaults, or its chat defaults for a quick side answer
/// (summary, notes), which keep thinking off or low: reasoning would use up
/// the answer's token budget.
fn apply_agent_mode(req: &mut ChatRequest, model: Option<&Model>) {
    let mode = if req.quick { Mode::Chat } else { Mode::Agent };
    apply_mode(req, model, mode);
}

#[async_trait]
impl ChatModel for AgentModel {
    async fn chat(
        &self,
        mut req: ChatRequest,
        cancel: &CancellationToken,
        on_delta: &mut (dyn FnMut(Delta) + Send),
    ) -> Result<ChatResult, LlmError> {
        apply_agent_mode(&mut req, self.model.as_ref());
        self.inner.chat(req, cancel, on_delta).await
    }

    fn context_tokens(&self) -> u32 {
        self.inner.context_tokens
    }

    fn vision(&self) -> bool {
        self.vision
    }
}

pub struct RunEntry {
    pub ctx: Arc<RunContext>,
    pub broker: Arc<UiBroker>,
    pub goal: String,
    /// Requests of the runs this one continues, oldest first.
    pub earlier_goals: Vec<String>,
    /// Outcome and summary, recorded before the UI hears that the run ended.
    pub ended: Arc<Mutex<Option<Ended>>>,
    /// File changes so far, without diffs, for the stored record.
    pub changes: Arc<Mutex<Vec<FileChange>>>,
    /// The run's model sees: answers and messages of the user may carry images.
    pub vision: bool,
}

impl RunEntry {
    /// What a run that continues this one is told about it; `None` while it still runs.
    pub fn as_previous(&self) -> Option<PreviousRun> {
        let ended = self.ended.lock().unwrap().clone()?;
        let board = self.ctx.blackboard.lock().unwrap();
        let previous = PreviousRun::new(&self.goal, ended.outcome, &ended.summary, &board, self.earlier_goals.clone());
        Some(previous.with_recap(ended.recap))
    }
}

/// How a run ended, as its `RunFinished` event said.
#[derive(Debug, Clone)]
pub struct Ended {
    pub outcome: RunOutcome,
    pub summary: String,
    pub recap: Option<String>,
}

#[derive(Default)]
pub struct AgentRuns {
    runs: Mutex<HashMap<String, Arc<RunEntry>>>,
}

impl AgentRuns {
    pub fn get(&self, run_id: &str) -> AppResult<Arc<RunEntry>> {
        self.runs.lock().unwrap().get(run_id).cloned().ok_or_else(|| AppError::new("unknown_run", run_id))
    }
}

fn team_for(state: &AppState, handle: &ChatHandle) -> Team {
    let settings = state.settings();
    // All agents prefer slot 0: they run one after another and reuse the
    // cached prompt prefix; interactive chat keeps the last slot free.
    let model = |label: &str| -> Arc<dyn ChatModel> {
        Arc::new(AgentModel {
            inner: ScheduledModel {
                client: handle.client.clone(),
                scheduler: handle.scheduler.clone(),
                priority: Priority::Agent,
                preferred_slot: Some(0),
                label: label.to_string(),
                context_tokens: handle.context,
                pin_slot: handle.pin_slot,
            },
            model: handle.model.clone(),
            vision: handle.vision,
        })
    };
    let mut models: HashMap<String, Arc<dyn ChatModel>> = HashMap::new();
    for role in &settings.agent.roles {
        models.insert(role.id.clone(), model(&role.name));
    }
    Team {
        roles: settings.agent.roles.clone(),
        models,
        default_model: model("agent"),
        max_review_rounds: settings.agent.max_review_rounds,
        review_enabled: settings.agent.review_enabled,
        update_notes: settings.agent.update_project_notes,
        summarize: true,
    }
}

pub fn checkpoint_store(state: &AppState) -> AppResult<CheckpointStore> {
    let ws = state.workspace()?;
    Ok(CheckpointStore::new(state.paths.checkpoints_for(ws.root())))
}

/// Starts a run in the background and returns its id. Events stream over
/// `channel`. With `previous_run`, the new run continues that finished run.
/// `images` (data URLs) go with the request to the orchestrator and to the
/// agents working on its tasks; the model must see.
/// `language` is the app's UI language; the summary at the end is written in it.
pub async fn start(
    state: &AppState,
    goal: String,
    images: Vec<String>,
    previous_run: Option<String>,
    language: String,
    channel: Channel<AgentEvent>,
) -> AppResult<String> {
    let handle = state
        .runtime
        .chat_handle()
        .await
        .ok_or_else(|| AppError::new("no_model", "start a model first"))?;
    crate::chat::check_images(&images, handle.vision)?;
    let ws = state.workspace()?;
    let previous = match previous_run {
        Some(id) => Some(find_previous(state, ws.root(), &id)?),
        None => None,
    };
    let settings = state.settings();
    let millis = now_ms();
    let run_id = format!("run-{millis}");
    let broker = Arc::new(UiBroker::default());
    *broker.run_id.lock().unwrap() = run_id.clone();
    let ended = Arc::new(Mutex::new(None));
    let changes = Arc::new(Mutex::new(Vec::new()));
    let (record_end, record_changes) = (ended.clone(), changes.clone());
    let emit: EventSink = Arc::new(move |e| {
        match &e {
            AgentEvent::RunFinished { outcome, summary, recap, .. } => {
                *record_end.lock().unwrap() = Some(Ended { outcome: *outcome, summary: summary.clone(), recap: recap.clone() })
            }
            AgentEvent::ToolResult { change: Some(change), .. } => record_change(&mut record_changes.lock().unwrap(), change),
            _ => {}
        }
        let _ = channel.send(e);
    });
    let project = ws.root().to_path_buf();
    *broker.events.lock().unwrap() = Some(emit.clone());
    // The skills that are on when the run starts; they work with any model.
    let skills = crate::skill_service::enabled(&state.skills, Some(&ws));
    let ctx = Arc::new(
        RunContext::new(
            run_id.clone(),
            ws,
            Arc::new(checkpoint_store(state)?),
            settings.agent.permissions.clone(),
            settings.agent.shell.clone(),
            settings.agent.templates.clone(),
            broker.clone(),
            emit,
        )
        .with_skills(skills)
        .with_goal_images(images)
        .with_language(language),
    );
    let entry = Arc::new(RunEntry {
        ctx: ctx.clone(),
        broker,
        goal: goal.clone(),
        earlier_goals: previous.as_ref().map(PreviousRun::goal_chain).unwrap_or_default(),
        ended,
        changes,
        vision: handle.vision,
    });
    state.agents.runs.lock().unwrap().insert(run_id.clone(), entry.clone());
    let team = team_for(state, &handle);
    let last_runs = state.last_runs.clone();
    let id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let report = agent::run_with_previous(ctx, &team, &goal, previous.as_ref()).await;
        tracing::info!("agent run finished: {:?}", report.outcome);
        let record = LastRun {
            run_id: id,
            goal,
            started_at_unix_ms: millis,
            finished_at_unix_ms: now_ms(),
            outcome: report.outcome,
            summary: report.summary,
            recap: report.recap,
            plan: report.plan,
            changes: entry.changes.lock().unwrap().clone(),
            earlier_goals: entry.earlier_goals.clone(),
        };
        if let Err(e) = last_runs.save(&project, &record) {
            tracing::warn!("could not keep the agent run for later: {e}");
        }
    });
    Ok(run_id)
}

/// The finished run `id` of this project: still in memory, or the project's
/// stored last run after Ylide was restarted.
fn find_previous(state: &AppState, project: &Path, id: &str) -> AppResult<PreviousRun> {
    if let Ok(entry) = state.agents.get(id) {
        if entry.ctx.ws.root() != project {
            return Err(AppError::new("run_elsewhere", "the previous run belongs to another project"));
        }
        return entry.as_previous().ok_or_else(|| AppError::new("run_not_finished", id));
    }
    state
        .last_runs
        .load(project)
        .filter(|r| r.run_id == id)
        .map(|r| r.as_previous())
        .ok_or_else(|| AppError::new("unknown_run", id))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quick_side_answers_think_little() {
        let reg = registry::bundled();
        let qwen = reg.models.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap();
        let mut work = ChatRequest::new(vec![]);
        apply_agent_mode(&mut work, Some(qwen));
        assert_eq!(work.chat_template_kwargs, Some(serde_json::json!({"preserve_thinking": true})));
        let mut quick = ChatRequest::new(vec![]);
        quick.quick = true;
        apply_agent_mode(&mut quick, Some(qwen));
        assert_eq!(quick.chat_template_kwargs, Some(serde_json::json!({"enable_thinking": false})));
        let gpt = reg.models.iter().find(|m| m.id == "qwen3.8-27b").unwrap();
        let mut quick = ChatRequest::new(vec![]);
        quick.quick = true;
        apply_agent_mode(&mut quick, Some(gpt));
        assert_eq!(quick.chat_template_kwargs, Some(serde_json::json!({"reasoning_effort": "low"})));
    }
}
