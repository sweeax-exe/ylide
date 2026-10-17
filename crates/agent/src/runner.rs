//! The loop that drives one agent: ask the model, execute its tool calls (with
//! permission checks and checkpoints), feed results back, until the agent
//! finishes, hands in a plan/review, hits its step limit or the run is stopped.

use crate::checkpoints::CheckpointStore;
use crate::llm::ChatModel;
use crate::permissions::{
    ApprovalBroker, ApprovalRequest, ApprovalResponse, Decision, PermissionSettings, ToolRisk, UserReply, decide,
};
use crate::protocol::{AgentEvent, AgentMessage, AgentState, AgentStatus, Blackboard, MessageKind, Review};
use crate::roles::{PromptTemplates, RoleDefinition};
use crate::textcalls::parse_text_tool_calls;
use crate::tools::{SKILL_READ, ShellConfig, ToolEnv, ToolOutcome, describe_call, execute, tool_spec};
use async_trait::async_trait;
use inference::{ChatMessage, ChatRequest, FinishReason, LlmError, MessageRole};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use workspace::Workspace;

/// Tool output beyond this is cut before it goes back into the conversation.
const MAX_TOOL_OUTPUT_CHARS: usize = 24_000;

/// Pause / cancel / intervene, shared by all agents of a run.
#[derive(Clone)]
pub struct RunControl {
    pub cancel: CancellationToken,
    paused: watch::Sender<bool>,
    interventions: Arc<Mutex<Vec<(String, UserReply)>>>,
}

impl Default for RunControl {
    fn default() -> Self {
        Self {
            cancel: CancellationToken::new(),
            paused: watch::channel(false).0,
            interventions: Arc::default(),
        }
    }
}

impl RunControl {
    pub fn pause(&self) {
        self.paused.send_replace(true);
    }
    pub fn resume(&self) {
        self.paused.send_replace(false);
    }
    pub fn is_paused(&self) -> bool {
        *self.paused.borrow()
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
        self.resume();
    }
    /// Queues a user message for `agent_id` (`"*"` = whichever agent runs next).
    pub fn intervene(&self, agent_id: &str, text: &str) {
        self.intervene_with(agent_id, UserReply::text(text));
    }
    /// Like [`Self::intervene`], with images for a model that sees.
    pub fn intervene_with(&self, agent_id: &str, message: UserReply) {
        self.interventions.lock().unwrap().push((agent_id.to_string(), message));
    }
    fn take_interventions(&self, agent_id: &str) -> Vec<UserReply> {
        let mut all = self.interventions.lock().unwrap();
        let (mine, rest): (Vec<_>, Vec<_>) = all.drain(..).partition(|(to, _)| to == agent_id || to == "*");
        *all = rest;
        mine.into_iter().map(|(_, t)| t).collect()
    }
    async fn wait_while_paused(&self) {
        let mut rx = self.paused.subscribe();
        while *rx.borrow() && !self.cancel.is_cancelled() {
            if rx.changed().await.is_err() {
                break;
            }
        }
    }
}

/// Everything shared by the agents of one run.
pub struct RunContext {
    pub run_id: String,
    pub ws: Workspace,
    pub checkpoints: Arc<CheckpointStore>,
    pub permissions: PermissionSettings,
    pub shell: ShellConfig,
    pub templates: PromptTemplates,
    pub broker: Arc<dyn ApprovalBroker>,
    pub events: Arc<dyn Fn(AgentEvent) + Send + Sync>,
    pub control: RunControl,
    pub blackboard: Mutex<Blackboard>,
    /// The skills the user enabled; every role that uses tools can read them.
    pub skills: Vec<skills::EnabledSkill>,
    /// Images that came with the request (data URLs); the orchestrator and
    /// the agent that works on a task see them with their first message.
    pub goal_images: Vec<String>,
    /// Tools the user approved "always" during this run.
    always_allowed: Mutex<HashSet<String>>,
    /// Files read by any agent in this run (guards blind overwrites).
    read_files: Mutex<HashSet<String>>,
    /// Commands that exited with 0, in order, for the project notes.
    worked_commands: Mutex<Vec<String>>,
    stats: Mutex<HashMap<String, (f64, u32)>>,
    counter: AtomicU64,
}

impl RunContext {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        run_id: impl Into<String>,
        ws: Workspace,
        checkpoints: Arc<CheckpointStore>,
        permissions: PermissionSettings,
        shell: ShellConfig,
        templates: PromptTemplates,
        broker: Arc<dyn ApprovalBroker>,
        events: Arc<dyn Fn(AgentEvent) + Send + Sync>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            ws,
            checkpoints,
            permissions,
            shell,
            templates,
            broker,
            events,
            control: RunControl::default(),
            blackboard: Mutex::new(Blackboard::default()),
            skills: Vec::new(),
            goal_images: Vec::new(),
            always_allowed: Mutex::default(),
            read_files: Mutex::default(),
            worked_commands: Mutex::default(),
            stats: Mutex::default(),
            counter: AtomicU64::new(0),
        }
    }

    /// The run with the user's enabled skills.
    pub fn with_skills(mut self, skills: Vec<skills::EnabledSkill>) -> Self {
        self.skills = skills;
        self
    }

    pub fn emit(&self, event: AgentEvent) {
        (self.events)(event);
    }

    /// The run with images of the request (for a model that sees).
    pub fn with_goal_images(mut self, images: Vec<String>) -> Self {
        self.goal_images = images;
        self
    }

    /// Commands that exited with 0 in this run, each once.
    pub fn commands_that_worked(&self) -> Vec<String> {
        self.worked_commands.lock().unwrap().clone()
    }

    /// Counts `path` as read, so a write of it is no blind overwrite.
    pub(crate) fn mark_read(&self, path: &str) {
        self.read_files.lock().unwrap().insert(path.to_string());
    }

    pub fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.counter.fetch_add(1, Ordering::Relaxed) + 1)
    }

    pub fn status(&self, agent_id: &str, role: &str, state: AgentState, step: &str, task_id: Option<&str>) {
        let (tps, total) = self.stats.lock().unwrap().get(agent_id).copied().unwrap_or((0.0, 0));
        self.emit(AgentEvent::Status {
            run_id: self.run_id.clone(),
            status: AgentStatus {
                agent_id: agent_id.to_string(),
                role: role.to_string(),
                state,
                step: step.to_string(),
                task_id: task_id.map(str::to_string),
                tokens_per_second: tps,
                total_tokens: total,
            },
        });
    }

    pub fn post_message(&self, from: &str, to: &str, kind: MessageKind, content: &str, task_id: Option<&str>) {
        let message = AgentMessage {
            id: self.next_id("msg"),
            from: from.to_string(),
            to: to.to_string(),
            kind,
            content: content.to_string(),
            task_id: task_id.map(str::to_string),
        };
        self.blackboard.lock().unwrap().messages.push(message.clone());
        self.emit(AgentEvent::Message {
            run_id: self.run_id.clone(),
            message,
        });
    }
}

/// Answers `ask` tool calls (implemented by the orchestrator).
#[async_trait]
pub trait AskRouter: Send + Sync {
    /// The answer, or `None` if the run was cancelled while waiting for it.
    async fn ask(&self, ctx: &RunContext, from: &str, to: &str, question: &str, task_id: Option<&str>) -> Option<UserReply>;
}

/// A message with the user's images, for a model that sees; another model
/// gets a note in their place.
fn with_user_images(message: ChatMessage, images: Vec<String>, vision: bool) -> ChatMessage {
    match images.len() {
        0 => message,
        _ if vision => message.with_images(images),
        n => {
            let text = message.content.clone().unwrap_or_default();
            ChatMessage { content: Some(format!("{text}\n\n[{n} image(s) from the user left out: this model cannot see images]")), ..message }
        }
    }
}

/// A plan as submitted by the orchestrator, before ids are assigned.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PlanDraft {
    pub summary: String,
    pub tasks: Vec<TaskDraft>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TaskDraft {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub assignee: Option<String>,
}

/// How an agent's turn ended.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEnd {
    Finished(String),
    Plan(PlanDraft),
    Review(Review),
    /// The model answered in plain text and stopped using tools.
    Text(String),
    StepLimit,
    Cancelled,
    Failed(String),
}

pub struct AgentSpec<'a> {
    /// Instance id shown in the UI, e.g. "coder".
    pub id: String,
    pub role: &'a RoleDefinition,
    pub model: Arc<dyn ChatModel>,
}

fn estimate_tokens(messages: &[ChatMessage]) -> u32 {
    let chars: usize = messages
        .iter()
        .map(|m| {
            m.content.as_ref().map_or(0, |c| c.len())
                + m.tool_calls.iter().map(|t| t.function.arguments.len() + t.function.name.len()).sum::<usize>()
        })
        .sum();
    let images: usize = messages.iter().map(|m| m.images.len()).sum();
    (chars as f64 / 3.5) as u32 + images as u32 * inference::image::ESTIMATED_TOKENS
}

/// Keeps the conversation inside the context window.
///
/// Hybrid models (Qwen3.5/3.6/3.8) cannot shift their KV cache, so every change
/// to the history forces a full re-read of the prompt. History therefore stays
/// append-only until it reaches 75 % of the window; then all older tool outputs
/// are condensed in one go, which costs one re-read instead of one per turn.
fn compact(messages: &mut [ChatMessage], context_tokens: u32) {
    let limit = (context_tokens as f64 * 0.75) as u32;
    if estimate_tokens(messages) <= limit {
        return;
    }
    let keep_tail = 6;
    let n = messages.len();
    for message in messages.iter_mut().take(n.saturating_sub(keep_tail)).skip(2) {
        if message.role == MessageRole::Tool && message.content.as_ref().is_some_and(|c| c.len() > 400) {
            message.content = Some("[older tool output removed to save context; call the tool again if you need it]".into());
        }
        // Images image_view returned; those of the request (a user message) stay.
        if message.role == MessageRole::Tool && !message.images.is_empty() {
            message.images.clear();
            message.content = Some("[older image removed to save context; call image_view again if you need it]".into());
        }
    }
}

/// Runs one agent on `conversation` until it ends. The conversation is kept by
/// the caller so the same agent can continue later (e.g. after review feedback).
pub async fn run_agent(
    ctx: &RunContext,
    agent: &AgentSpec<'_>,
    conversation: &mut Vec<ChatMessage>,
    task_id: Option<&str>,
    checkpoint_id: Option<&str>,
    router: &dyn AskRouter,
) -> AgentEnd {
    let role = agent.role;
    let mut tools = role.tools.clone();
    if !ctx.skills.is_empty() && !tools.is_empty() && !tools.iter().any(|t| t == SKILL_READ) {
        tools.push(SKILL_READ.to_string());
    }
    // A model that sees can look at the project's images, in every role that uses tools.
    let image_view = crate::tools::IMAGE_VIEW;
    if agent.model.vision() && !tools.is_empty() && !tools.iter().any(|t| t == image_view) {
        tools.push(image_view.to_string());
    }
    let tool_defs: Vec<_> = tools.iter().filter_map(|t| tool_spec(t)).map(|s| s.definition()).collect();
    let tool_names: Vec<&str> = tools.iter().map(String::as_str).collect();
    let mut text_only_turns = 0;
    let mut failures: HashMap<String, u32> = HashMap::new();
    let mut transient_errors = 0;

    let mut step = 0;
    while step < role.max_steps {
        if ctx.control.is_paused() {
            ctx.status(&agent.id, &role.id, AgentState::Paused, "paused", task_id);
            ctx.control.wait_while_paused().await;
        }
        if ctx.control.cancel.is_cancelled() {
            return AgentEnd::Cancelled;
        }
        for UserReply { text, images } in ctx.control.take_interventions(&agent.id) {
            ctx.post_message("user", &agent.id, MessageKind::Intervention, &text, task_id);
            let message = ChatMessage::user(format!("Message from the user (takes priority over earlier instructions):\n{text}"));
            conversation.push(with_user_images(message, images, agent.model.vision()));
        }
        compact(conversation, agent.model.context_tokens());

        ctx.status(&agent.id, &role.id, AgentState::Thinking, "thinking", task_id);
        let mut req = ChatRequest::new(conversation.clone());
        req.tools = tool_defs.clone();
        req.temperature = role.temperature;
        let run_id = ctx.run_id.clone();
        let agent_id = agent.id.clone();
        let events = ctx.events.clone();
        let mut on_delta = move |delta| {
            events(AgentEvent::Delta {
                run_id: run_id.clone(),
                agent_id: agent_id.clone(),
                delta,
            })
        };
        let result = match agent.model.chat(req, &ctx.control.cancel, &mut on_delta).await {
            Ok(r) => r,
            Err(e @ (LlmError::Connection(_) | LlmError::Loading)) if transient_errors < 3 => {
                transient_errors += 1;
                tracing::warn!("model call failed ({e}), retrying");
                tokio::time::sleep(std::time::Duration::from_millis(1500 * transient_errors)).await;
                continue;
            }
            Err(e) => {
                ctx.status(&agent.id, &role.id, AgentState::Failed, &e.to_string(), task_id);
                return AgentEnd::Failed(e.to_string());
            }
        };
        step += 1;
        if result.finish_reason == FinishReason::Cancelled {
            return AgentEnd::Cancelled;
        }
        if let Some(t) = result.timings {
            let mut stats = ctx.stats.lock().unwrap();
            let entry = stats.entry(agent.id.clone()).or_insert((0.0, 0));
            entry.0 = t.generation_tokens_per_second;
        }
        if let Some(u) = result.usage {
            let mut stats = ctx.stats.lock().unwrap();
            stats.entry(agent.id.clone()).or_insert((0.0, 0)).1 += u.completion_tokens;
        }

        let mut message = result.message;
        message.reasoning_content = None;
        if message.tool_calls.is_empty()
            && let Some(content) = message.content.clone()
        {
            let (calls, rest) = parse_text_tool_calls(&content, &tool_names);
            if !calls.is_empty() {
                message.tool_calls = calls;
                message.content = (!rest.is_empty()).then_some(rest);
            }
        }
        conversation.push(message.clone());

        if message.tool_calls.is_empty() {
            let text = message.content.unwrap_or_default();
            // Planners/reviewers that answer with the JSON instead of calling the tool.
            if tool_names.contains(&"submit_plan")
                && let Some(plan) = parse_json_object::<PlanDraft>(&text).filter(|p| !p.tasks.is_empty())
            {
                return AgentEnd::Plan(plan);
            }
            if tool_names.contains(&"submit_review")
                && let Some(review) = parse_json_object::<Review>(&text)
            {
                return AgentEnd::Review(review);
            }
            text_only_turns += 1;
            if result.finish_reason == FinishReason::Length {
                conversation.push(ChatMessage::user("Your answer was cut off. Continue, and prefer smaller tool calls."));
                continue;
            }
            if text_only_turns >= 2 || role.tools.is_empty() {
                return AgentEnd::Text(text);
            }
            conversation.push(ChatMessage::user(ctx.templates.continue_.clone()));
            continue;
        }
        text_only_turns = 0;

        for call in &message.tool_calls {
            let name = call.function.name.as_str();
            let mut args: Value = match serde_json::from_str(&call.function.arguments) {
                Ok(v) => v,
                Err(e) => {
                    conversation.push(ChatMessage::tool_result(
                        &call.id,
                        format!("Error: the arguments are not valid JSON ({e}). Send a JSON object matching the tool schema."),
                    ));
                    continue;
                }
            };
            if !tool_names.contains(&name) {
                conversation.push(ChatMessage::tool_result(&call.id, format!("Error: tool '{name}' is not available to you. Available: {}", tool_names.join(", "))));
                continue;
            }
            if let Some(spec) = tool_spec(name) {
                crate::tools::normalize_arguments(&spec, &mut args);
            }
            let description = describe_call(name, &args);
            ctx.emit(AgentEvent::ToolCall {
                run_id: ctx.run_id.clone(),
                agent_id: agent.id.clone(),
                call_id: call.id.clone(),
                tool: name.to_string(),
                arguments: call.function.arguments.clone(),
            });

            let tool_result = |ok: bool, summary: &str, change: Option<crate::protocol::FileChange>| {
                ctx.emit(AgentEvent::ToolResult {
                    run_id: ctx.run_id.clone(),
                    agent_id: agent.id.clone(),
                    call_id: call.id.clone(),
                    ok,
                    summary: summary.to_string(),
                    change,
                });
            };
            match name {
                "finish" => {
                    let summary = args["summary"].as_str().unwrap_or("Done.").to_string();
                    tool_result(true, "Task marked as finished.", None);
                    conversation.push(ChatMessage::tool_result(&call.id, "Task marked as finished."));
                    ctx.status(&agent.id, &role.id, AgentState::Done, "finished", task_id);
                    return AgentEnd::Finished(summary);
                }
                "submit_plan" => match serde_json::from_value::<PlanDraft>(args.clone()) {
                    // A run that carries over open tasks may get nothing new.
                    Ok(plan) if !plan.tasks.is_empty() || has_tasks(ctx) => {
                        tool_result(true, "Plan received.", None);
                        conversation.push(ChatMessage::tool_result(&call.id, "Plan received."));
                        return AgentEnd::Plan(plan);
                    }
                    Ok(_) => {
                        tool_result(false, "The plan needs at least one task.", None);
                        conversation.push(ChatMessage::tool_result(&call.id, "Error: the plan needs at least one task."));
                    }
                    Err(e) => {
                        let msg = format!("invalid plan ({e})");
                        tool_result(false, &msg, None);
                        conversation.push(ChatMessage::tool_result(&call.id, format!("Error: {msg}.")));
                    }
                },
                "submit_review" => match serde_json::from_value::<Review>(args.clone()) {
                    Ok(review) => {
                        tool_result(true, "Review received.", None);
                        conversation.push(ChatMessage::tool_result(&call.id, "Review received."));
                        return AgentEnd::Review(review);
                    }
                    Err(e) => {
                        let msg = format!("invalid review ({e})");
                        tool_result(false, &msg, None);
                        conversation.push(ChatMessage::tool_result(
                            &call.id,
                            format!("Error: {msg}. verdict must be 'approve' or 'request_changes'."),
                        ));
                    }
                },
                "ask" => {
                    let to = args["to"].as_str().unwrap_or("orchestrator");
                    let question = args["question"].as_str().unwrap_or_default();
                    ctx.status(&agent.id, &role.id, AgentState::WaitingForAnswer, &description, task_id);
                    ctx.post_message(&agent.id, to, MessageKind::Question, question, task_id);
                    let Some(answer) = router.ask(ctx, &agent.id, to, question, task_id).await else {
                        tool_result(false, "run cancelled", None);
                        conversation.push(ChatMessage::tool_result(&call.id, "Error: run cancelled"));
                        continue;
                    };
                    ctx.post_message(to, &agent.id, MessageKind::Answer, &answer.text, task_id);
                    tool_result(true, &format!("Answer from {to}"), None);
                    let result = ChatMessage::tool_result(&call.id, format!("Answer from {to}:\n{}", answer.text));
                    conversation.push(with_user_images(result, answer.images, agent.model.vision()));
                }
                _ => {
                    let outcome = execute_with_permission(ctx, agent, name, &args, &description, task_id, checkpoint_id).await;
                    // Rejected, blocked and failed calls get a result too, so the UI can close every call.
                    tool_result(outcome.ok, &outcome.summary, outcome.change.clone());
                    let key = format!("{name}:{}", call.function.arguments);
                    let mut output = crate::tools::truncate_middle(&outcome.output, MAX_TOOL_OUTPUT_CHARS);
                    if outcome.ok {
                        failures.remove(&key);
                    } else {
                        let n = failures.entry(key).or_insert(0);
                        *n += 1;
                        if *n >= 3 {
                            output.push_str("\n\n");
                            output.push_str(&ctx.templates.repeated_failure);
                        }
                    }
                    conversation.push(ChatMessage::tool_result(&call.id, output).with_images(outcome.images));
                }
            }
        }
    }
    ctx.status(&agent.id, &role.id, AgentState::Failed, "step limit reached", task_id);
    AgentEnd::StepLimit
}

async fn execute_with_permission(
    ctx: &RunContext,
    agent: &AgentSpec<'_>,
    name: &str,
    args: &Value,
    description: &str,
    task_id: Option<&str>,
    checkpoint_id: Option<&str>,
) -> ToolOutcome {
    let Some(spec) = tool_spec(name) else {
        return error_outcome(format!("unknown tool '{name}'"));
    };
    // Only offered to a model that sees, but a role may list it by hand.
    if name == crate::tools::IMAGE_VIEW && !agent.model.vision() {
        return error_outcome(crate::tools::NO_VISION.into());
    }
    let command = args["command"].as_str();
    if let Some(reason) = command.and_then(crate::permissions::hard_denied) {
        let msg = format!("Blocked by Ylide's safety rules: this command {reason}. Agents can never run it; ask the user to run it themselves if it is really needed.");
        return ToolOutcome {
            output: msg.clone(),
            ok: false,
            summary: msg,
            change: None,
            images: Vec::new(),
        };
    }
    let pre_approved = ctx.always_allowed.lock().unwrap().contains(name);
    if !pre_approved && decide(&ctx.permissions, spec.risk, command) == Decision::Ask {
        let request = ApprovalRequest {
            id: ctx.next_id("approval"),
            agent_id: agent.id.clone(),
            tool: name.to_string(),
            risk: spec.risk,
            title: description.to_string(),
            detail: approval_detail(ctx, name, args),
        };
        ctx.status(&agent.id, &agent.role.id, AgentState::WaitingForApproval, description, task_id);
        ctx.emit(AgentEvent::ApprovalRequested {
            run_id: ctx.run_id.clone(),
            request: request.clone(),
        });
        let response = tokio::select! {
            r = ctx.broker.request_approval(request) => r,
            _ = ctx.control.cancel.cancelled() => return error_outcome("run cancelled".into()),
        };
        match response {
            ApprovalResponse::Approve => {}
            ApprovalResponse::ApproveAlways => {
                ctx.always_allowed.lock().unwrap().insert(name.to_string());
            }
            ApprovalResponse::Reject { reason } => {
                let msg = match reason {
                    Some(r) if !r.trim().is_empty() => format!("The user rejected this action: {r}"),
                    _ => "The user rejected this action. Do not retry it; choose another approach or finish.".to_string(),
                };
                return ToolOutcome {
                    output: msg.clone(),
                    ok: false,
                    summary: msg,
                    change: None,
                    images: Vec::new(),
                };
            }
        }
    }

    ctx.status(&agent.id, &agent.role.id, AgentState::CallingTool, description, task_id);
    // Only file changes are checkpointed; outside a task they get their own checkpoint.
    let checkpoint_id = match (checkpoint_id, spec.risk) {
        (Some(c), _) => c.to_string(),
        (None, ToolRisk::Write | ToolRisk::Delete) => match ctx.checkpoints.begin(&ctx.run_id, &format!("{description} ({})", agent.id)) {
            Ok(cp) => {
                ctx.emit(AgentEvent::CheckpointCreated {
                    run_id: ctx.run_id.clone(),
                    checkpoint: cp.clone(),
                });
                cp.id
            }
            Err(e) => return error_outcome(format!("could not create checkpoint: {e}")),
        },
        (None, _) => String::new(),
    };
    let env = ToolEnv {
        ws: &ctx.ws,
        checkpoints: &ctx.checkpoints,
        run_id: &ctx.run_id,
        checkpoint_id: &checkpoint_id,
        shell: &ctx.shell,
        cancel: &ctx.control.cancel,
        read_files: &ctx.read_files,
        skills: &ctx.skills,
        skill_chars: skills::prompt::read_budget(agent.model.context_tokens()),
    };
    let outcome = execute(name, args, &env).await;
    if let Some(change) = &outcome.change {
        ctx.blackboard.lock().unwrap().changed_files.insert(change.path.clone());
    }
    if let Some(command) = command.filter(|_| outcome.ok && name == "run_command") {
        let mut worked = ctx.worked_commands.lock().unwrap();
        if !worked.iter().any(|c| c == command) && worked.len() < MAX_WORKED_COMMANDS {
            worked.push(command.to_string());
        }
    }
    outcome
}

/// Commands kept for the project notes.
const MAX_WORKED_COMMANDS: usize = 20;

/// One tool call outside an agent's loop (the orchestrator writing the
/// project notes): the same events, approval and checkpoint as a model's call.
pub(crate) async fn call_tool(ctx: &RunContext, agent: &AgentSpec<'_>, name: &str, args: Value) -> ToolOutcome {
    let call_id = ctx.next_id("call");
    let description = describe_call(name, &args);
    ctx.emit(AgentEvent::ToolCall {
        run_id: ctx.run_id.clone(),
        agent_id: agent.id.clone(),
        call_id: call_id.clone(),
        tool: name.to_string(),
        arguments: args.to_string(),
    });
    let outcome = execute_with_permission(ctx, agent, name, &args, &description, None, None).await;
    ctx.emit(AgentEvent::ToolResult {
        run_id: ctx.run_id.clone(),
        agent_id: agent.id.clone(),
        call_id,
        ok: outcome.ok,
        summary: outcome.summary.clone(),
        change: outcome.change.clone(),
    });
    outcome
}

/// True when the run already has tasks before planning (carried over from the run it continues).
fn has_tasks(ctx: &RunContext) -> bool {
    ctx.blackboard.lock().unwrap().plan.as_ref().is_some_and(|p| !p.tasks.is_empty())
}

/// What the approval dialog shows: the diff of an edit, the full command, or the path.
fn approval_detail(ctx: &RunContext, name: &str, args: &Value) -> String {
    let path = args["path"].as_str().unwrap_or_default();
    match name {
        "edit_file" => {
            let before = ctx.ws.read_text(path).map(|f| f.content).unwrap_or_default();
            match crate::edit::apply_edit(
                &before,
                args["old_text"].as_str().unwrap_or_default(),
                args["new_text"].as_str().unwrap_or_default(),
                args["replace_all"].as_bool().unwrap_or(false),
            ) {
                Ok(after) => crate::edit::unified_diff(path, &before, &after),
                Err(e) => format!("(edit will fail: {e})"),
            }
        }
        "write_file" => {
            let before = ctx.ws.read_text(path).map(|f| f.content).unwrap_or_default();
            crate::edit::unified_diff(path, &before, args["content"].as_str().unwrap_or_default())
        }
        "run_command" => args["command"].as_str().unwrap_or_default().to_string(),
        _ => path.to_string(),
    }
}

/// Parses the outermost `{...}` in `text` as `T`.
pub(crate) fn parse_json_object<T: serde::de::DeserializeOwned>(text: &str) -> Option<T> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (start < end).then(|| serde_json::from_str(&text[start..=end]).ok()).flatten()
}

fn error_outcome(message: String) -> ToolOutcome {
    ToolOutcome {
        output: format!("Error: {message}"),
        ok: false,
        summary: message,
        change: None,
        images: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_blanks_old_tool_output_first() {
        let mut msgs = vec![ChatMessage::system("s"), ChatMessage::user("task")];
        for i in 0..20 {
            msgs.push(ChatMessage::assistant(format!("step {i}")));
            msgs.push(ChatMessage::tool_result(format!("c{i}"), "x".repeat(2000)));
        }
        let before = estimate_tokens(&msgs);
        compact(&mut msgs, 8000);
        assert!(estimate_tokens(&msgs) < before);
        assert!(estimate_tokens(&msgs) <= 6000);
        // Below the threshold nothing changes (append-only for prompt caching).
        let snapshot = msgs.clone();
        compact(&mut msgs, 8000);
        assert_eq!(msgs, snapshot);
        assert_eq!(msgs[1].content.as_deref(), Some("task"), "task description is kept");
        assert_eq!(msgs.last().unwrap().content.as_ref().unwrap().len(), 2000, "recent output is kept");
    }

    #[test]
    fn interventions_are_routed_per_agent() {
        let c = RunControl::default();
        c.intervene("coder", "use tabs");
        c.intervene("*", "hurry");
        c.intervene("reviewer", "be strict");
        c.intervene_with("reviewer", UserReply { text: "like this".into(), images: vec!["data:image/png;base64,iVBORw0KGgo=".into()] });
        let texts = |list: Vec<UserReply>| list.into_iter().map(|r| r.text).collect::<Vec<_>>();
        assert_eq!(texts(c.take_interventions("coder")), vec!["use tabs", "hurry"]);
        assert_eq!(texts(c.take_interventions("coder")), Vec::<String>::new());
        let reviewer = c.take_interventions("reviewer");
        assert_eq!(texts(reviewer.clone()), vec!["be strict", "like this"]);
        assert_eq!(reviewer[1].images.len(), 1, "images stay with their message");
    }

    #[test]
    fn user_images_reach_only_a_model_that_sees() {
        let png = "data:image/png;base64,iVBORw0KGgo=".to_string();
        let seen = with_user_images(ChatMessage::user("Make it look like this"), vec![png.clone()], true);
        assert_eq!((seen.images, seen.content.as_deref()), (vec![png.clone()], Some("Make it look like this")));
        let blind = with_user_images(ChatMessage::tool_result("c1", "Answer from user:\nlike this"), vec![png.clone(), png], false);
        assert!(blind.images.is_empty());
        assert_eq!(blind.content.as_deref(), Some("Answer from user:\nlike this\n\n[2 image(s) from the user left out: this model cannot see images]"));
        assert_eq!(blind.tool_call_id.as_deref(), Some("c1"));
        assert_eq!(with_user_images(ChatMessage::user("plain"), vec![], false), ChatMessage::user("plain"));
    }
}
