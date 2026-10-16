//! Agent runs in the app: wires the orchestrator to the UI (events over a
//! Tauri channel, approvals and questions answered from dialogs).

use crate::chat::{Mode, apply_mode};
use crate::error::{AppError, AppResult};
use crate::runtime::ChatHandle;
use crate::state::AppState;
use agent::llm::ChatModel;
use agent::permissions::{ApprovalBroker, ApprovalRequest, ApprovalResponse};
use agent::{AgentEvent, CheckpointStore, RunContext, ScheduledModel, Team};
use async_trait::async_trait;
use inference::{ChatRequest, ChatResult, Delta, LlmError, Priority};
use registry::Model;
use std::collections::HashMap;
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
    questions: Mutex<HashMap<String, oneshot::Sender<String>>>,
    events: Mutex<Option<EventSink>>,
    run_id: Mutex<String>,
    counter: Mutex<u64>,
}

impl UiBroker {
    pub fn resolve_approval(&self, request_id: &str, response: ApprovalResponse) -> bool {
        self.approvals.lock().unwrap().remove(request_id).map(|tx| tx.send(response).is_ok()).unwrap_or(false)
    }

    pub fn resolve_question(&self, question_id: &str, answer: String) -> bool {
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

    async fn ask_user(&self, agent_id: &str, question: &str) -> String {
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
        rx.await.unwrap_or_else(|_| "(no answer)".into())
    }
}

/// A scheduled model that applies the registry's agent-mode defaults.
pub(crate) struct AgentModel {
    pub(crate) inner: ScheduledModel,
    pub(crate) model: Option<Model>,
}

#[async_trait]
impl ChatModel for AgentModel {
    async fn chat(
        &self,
        mut req: ChatRequest,
        cancel: &CancellationToken,
        on_delta: &mut (dyn FnMut(Delta) + Send),
    ) -> Result<ChatResult, LlmError> {
        apply_mode(&mut req, self.model.as_ref(), Mode::Agent);
        self.inner.chat(req, cancel, on_delta).await
    }

    fn context_tokens(&self) -> u32 {
        self.inner.context_tokens
    }
}

pub struct RunEntry {
    pub ctx: Arc<RunContext>,
    pub broker: Arc<UiBroker>,
    pub finished: Mutex<bool>,
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
    }
}

pub fn checkpoint_store(state: &AppState) -> AppResult<CheckpointStore> {
    let ws = state.workspace()?;
    Ok(CheckpointStore::new(state.paths.checkpoints_for(ws.root())))
}

/// Starts a run in the background and returns its id. Events stream over `channel`.
pub async fn start(state: &AppState, goal: String, channel: Channel<AgentEvent>) -> AppResult<String> {
    let handle = state
        .runtime
        .chat_handle()
        .await
        .ok_or_else(|| AppError::new("no_model", "start a model first"))?;
    let ws = state.workspace()?;
    let settings = state.settings();
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let run_id = format!("run-{millis}");
    let broker = Arc::new(UiBroker::default());
    *broker.run_id.lock().unwrap() = run_id.clone();
    let emit: EventSink = Arc::new(move |e| {
        let _ = channel.send(e);
    });
    *broker.events.lock().unwrap() = Some(emit.clone());
    let ctx = Arc::new(RunContext::new(
        run_id.clone(),
        ws,
        Arc::new(checkpoint_store(state)?),
        settings.agent.permissions.clone(),
        settings.agent.shell.clone(),
        settings.agent.templates.clone(),
        broker.clone(),
        emit,
    ));
    let entry = Arc::new(RunEntry {
        ctx: ctx.clone(),
        broker,
        finished: Mutex::new(false),
    });
    state.agents.runs.lock().unwrap().insert(run_id.clone(), entry.clone());
    let team = team_for(state, &handle);
    tauri::async_runtime::spawn(async move {
        let report = agent::run(ctx, &team, &goal).await;
        tracing::info!("agent run finished: {:?}", report.outcome);
        *entry.finished.lock().unwrap() = true;
    });
    Ok(run_id)
}
