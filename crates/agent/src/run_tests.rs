//! End-to-end tests of multi-agent runs with scripted models.

use crate::llm::script::{call, text};
use crate::llm::{ChatModel, ScriptedModel};
use crate::permissions::{ApprovalBroker, AutoApprove, PermissionSettings};
use crate::protocol::*;
use crate::roles::{PromptTemplates, default_roles};
use crate::runner::RunContext;
use crate::tools::ShellConfig;
use crate::{ApprovalRequest, ApprovalResponse, CheckpointStore, Team, run};
use async_trait::async_trait;
use inference::{ChatResult, MessageRole};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use workspace::Workspace;

struct Harness {
    ws: Workspace,
    dir: PathBuf,
    store: Arc<CheckpointStore>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
}

fn harness(name: &str) -> Harness {
    let base = std::env::temp_dir().join(format!("run-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let dir = base.join("project");
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/lib.rs"), "pub fn add(a: i32, b: i32) -> i32 {\n    a - b\n}\n").unwrap();
    Harness {
        ws: Workspace::open(&dir).unwrap(),
        dir,
        store: Arc::new(CheckpointStore::new(base.join("checkpoints"))),
        events: Arc::default(),
    }
}

fn context(h: &Harness, permissions: PermissionSettings, broker: Arc<dyn ApprovalBroker>) -> Arc<RunContext> {
    let events = h.events.clone();
    Arc::new(RunContext::new(
        "run-1",
        h.ws.clone(),
        h.store.clone(),
        permissions,
        ShellConfig::default(),
        PromptTemplates::default(),
        broker,
        Arc::new(move |e| events.lock().unwrap().push(e)),
    ))
}

fn team(models: Vec<(&str, Arc<ScriptedModel>)>) -> Team {
    let mut map: HashMap<String, Arc<dyn ChatModel>> = HashMap::new();
    for (role, m) in models {
        map.insert(role.to_string(), m);
    }
    Team {
        roles: default_roles(),
        models: map,
        default_model: Arc::new(ScriptedModel::new(vec![])),
        max_review_rounds: 2,
        review_enabled: true,
    }
}

fn scripted(responses: Vec<ChatResult>) -> Arc<ScriptedModel> {
    Arc::new(ScriptedModel::new(responses))
}

fn plan_call(tasks: serde_json::Value) -> ChatResult {
    call("submit_plan", json!({ "summary": "Fix the add function.", "tasks": tasks }))
}

#[tokio::test]
async fn full_run_with_a_review_round() {
    let h = harness("full");
    let orchestrator = scripted(vec![
        call("list_dir", json!({"path": ""})),
        plan_call(json!([{ "title": "Fix add", "description": "add() subtracts; make it add. Verify by reading.", "files": ["src/lib.rs"] }])),
    ]);
    let coder = scripted(vec![
        call("read_file", json!({"path": "src/lib.rs"})),
        call("edit_file", json!({"path": "src/lib.rs", "old_text": "a - b", "new_text": "a + b"})),
        call("finish", json!({"summary": "add() now adds."})),
        // after review feedback:
        call("edit_file", json!({"path": "src/lib.rs", "old_text": "pub fn add", "new_text": "/// Adds two numbers.\npub fn add"})),
        call("finish", json!({"summary": "add() now adds and is documented."})),
    ]);
    let reviewer = scripted(vec![
        call("submit_review", json!({"verdict": "request_changes", "summary": "Missing docs.", "comments": [{"file": "src/lib.rs", "line": 1, "severity": "minor", "message": "Add a doc comment."}]})),
        call("submit_review", json!({"verdict": "approve", "summary": "Looks good."})),
    ]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder.clone()), ("reviewer", reviewer.clone())]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove("ok".into())));

    let report = run(ctx.clone(), &t, "Fix the add function").await;

    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    let content = std::fs::read_to_string(h.dir.join("src/lib.rs")).unwrap();
    assert_eq!(content, "/// Adds two numbers.\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n");
    let task = &report.plan.as_ref().unwrap().tasks[0];
    assert_eq!(task.status, TaskStatus::Done);
    assert_eq!(task.attempts, 1);
    assert_eq!(task.review.as_ref().unwrap().verdict, Verdict::Approve);
    assert_eq!(orchestrator.remaining() + coder.remaining() + reviewer.remaining(), 0);

    // The coder continued the same conversation after feedback (KV-cache friendly).
    let coder_requests = coder.requests.lock().unwrap();
    let last = coder_requests.last().unwrap();
    assert!(last.messages.iter().any(|m| m.role == MessageRole::User && m.content.as_deref().unwrap_or_default().contains("Add a doc comment")));
    assert_eq!(last.messages[0].role, MessageRole::System);
    drop(coder_requests);

    // The reviewer saw the diff.
    let reviewer_requests = reviewer.requests.lock().unwrap();
    assert!(reviewer_requests[0].messages[1].content.as_ref().unwrap().contains("+    a + b"));
    drop(reviewer_requests);

    let events = h.events.lock().unwrap();
    assert!(events.iter().any(|e| matches!(e, AgentEvent::PlanReady { .. })));
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Message { message, .. } if message.kind == MessageKind::Feedback)));
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolResult { change: Some(c), .. } if c.path == "src/lib.rs")));
    assert!(matches!(events.last(), Some(AgentEvent::RunFinished { outcome: RunOutcome::Completed, .. })));
    drop(events);

    // Undo the whole task.
    assert_eq!(report.checkpoints.len(), 1);
    h.store.restore("run-1", &report.checkpoints[0].id, &h.ws).unwrap();
    assert!(std::fs::read_to_string(h.dir.join("src/lib.rs")).unwrap().contains("a - b"));
}

struct Reject;

#[async_trait]
impl ApprovalBroker for Reject {
    async fn request_approval(&self, _request: ApprovalRequest) -> ApprovalResponse {
        ApprovalResponse::Reject {
            reason: Some("not now".into()),
        }
    }
    async fn ask_user(&self, _agent_id: &str, _question: &str) -> String {
        "no".into()
    }
}

#[tokio::test]
async fn commands_need_approval_by_default() {
    let h = harness("approval");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "Run tests", "description": "Run the tests." }]))]);
    let coder = scripted(vec![
        call("run_command", json!({"command": "echo should-not-run > marker.txt"})),
        call("finish", json!({"summary": "Could not run tests: rejected."})),
    ]);
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder.clone())]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(Reject));
    let report = run(ctx, &t, "run tests").await;
    assert_eq!(report.outcome, RunOutcome::Completed);
    assert!(!h.dir.join("marker.txt").exists(), "rejected command must not run");
    let requests = coder.requests.lock().unwrap();
    let tool_reply = requests[1].messages.iter().find(|m| m.role == MessageRole::Tool).unwrap();
    assert!(tool_reply.content.as_ref().unwrap().contains("rejected this action: not now"));
    drop(requests);
    let events = h.events.lock().unwrap();
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ApprovalRequested { request, .. } if request.tool == "run_command")));
    // Every call gets a result with the call's own id; the rejected one failed.
    let calls: Vec<(&str, &str)> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCall { call_id, tool, .. } => Some((call_id.as_str(), tool.as_str())),
            _ => None,
        })
        .collect();
    assert!(!calls.is_empty());
    for (id, tool) in calls {
        let result = events.iter().find_map(|e| match e {
            AgentEvent::ToolResult { call_id, ok, .. } if call_id == id => Some(*ok),
            _ => None,
        });
        assert!(result.is_some(), "{tool} ({id}) has no result");
        if tool == "run_command" {
            assert_eq!(result, Some(false), "a rejected command reports a failed result");
        }
    }
}

/// Never answers: the user walked away.
struct Silent;

#[async_trait]
impl ApprovalBroker for Silent {
    async fn request_approval(&self, _request: ApprovalRequest) -> ApprovalResponse {
        std::future::pending().await
    }
    async fn ask_user(&self, _agent_id: &str, _question: &str) -> String {
        std::future::pending().await
    }
}

#[tokio::test]
async fn stopping_while_a_question_is_open_ends_the_run() {
    let h = harness("cancel-question");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }]))]);
    let coder = scripted(vec![call("ask", json!({"to": "user", "question": "Tabs or spaces?"}))]);
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder)]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(Silent));
    let control = ctx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        control.control.cancel();
    });
    let report = tokio::time::timeout(std::time::Duration::from_secs(5), run(ctx, &t, "anything"))
        .await
        .expect("the run must not hang on the open question");
    assert_eq!(report.outcome, RunOutcome::Cancelled);
    assert!(h.events.lock().unwrap().iter().any(|e| matches!(e, AgentEvent::ToolResult { ok: false, summary, .. } if summary == "run cancelled")));
}

#[tokio::test]
async fn cancelled_run_stops_immediately() {
    let h = harness("cancel");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }]))]);
    let t = team(vec![("orchestrator", orchestrator)]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    ctx.control.cancel();
    let report = run(ctx, &t, "anything").await;
    assert_eq!(report.outcome, RunOutcome::Cancelled);
}

#[tokio::test]
async fn text_tool_calls_and_text_plans_are_understood() {
    let h = harness("textcalls");
    let orchestrator = scripted(vec![text(
        "Here is my plan:\n{\"summary\": \"One step\", \"tasks\": [{\"title\": \"Fix\", \"description\": \"Make add add.\"}]}",
    ), text("still no tool")]);
    let coder = scripted(vec![
        text("<tool_call>\n{\"name\": \"edit_file\", \"arguments\": {\"path\": \"src/lib.rs\", \"old_text\": \"a - b\", \"new_text\": \"a + b\"}}\n</tool_call>"),
        text("<tool_call>{\"name\": \"finish\", \"arguments\": {\"summary\": \"fixed\"}}</tool_call>"),
    ]);
    let reviewer = scripted(vec![call("submit_review", json!({"verdict": "approve", "summary": "ok"}))]);
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder), ("reviewer", reviewer)]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    let report = run(ctx, &t, "fix add").await;
    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    assert_eq!(report.plan.unwrap().tasks[0].title, "Fix");
    assert!(std::fs::read_to_string(h.dir.join("src/lib.rs")).unwrap().contains("a + b"));
}

#[tokio::test]
async fn agents_can_ask_each_other_and_the_user() {
    let h = harness("ask");
    let orchestrator = scripted(vec![
        plan_call(json!([{ "title": "Rename", "description": "Rename add." }])),
        text("Call it `sum`."),
    ]);
    let coder = scripted(vec![
        call("ask", json!({"to": "orchestrator", "question": "What should the new name be?"})),
        call("ask", json!({"to": "user", "question": "Keep the old name as alias?"})),
        call("finish", json!({"summary": "nothing changed"})),
    ]);
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder.clone())]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove("yes, keep it".into())));
    let report = run(ctx, &t, "rename").await;
    assert_eq!(report.outcome, RunOutcome::Completed);
    let requests = coder.requests.lock().unwrap();
    let all: Vec<String> = requests.last().unwrap().messages.iter().filter_map(|m| m.content.clone()).collect();
    assert!(all.iter().any(|c| c.contains("Answer from orchestrator:\nCall it `sum`.")));
    assert!(all.iter().any(|c| c.contains("Answer from user:\nyes, keep it")));
    drop(requests);
    let questions = h.events.lock().unwrap().iter().filter(|e| matches!(e, AgentEvent::Message { message, .. } if message.kind == MessageKind::Question)).count();
    assert_eq!(questions, 2);
}

#[tokio::test]
async fn step_limit_fails_the_task() {
    let h = harness("limit");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "Loop", "description": "never ends" }]))]);
    let coder = scripted((0..40).map(|_| call("read_file", json!({"path": "src/lib.rs"}))).collect());
    let mut t = team(vec![("orchestrator", orchestrator), ("coder", coder)]);
    t.roles.iter_mut().find(|r| r.id == "coder").unwrap().max_steps = 3;
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    let report = run(ctx, &t, "loop").await;
    assert_eq!(report.outcome, RunOutcome::Failed);
    assert_eq!(report.plan.unwrap().tasks[0].status, TaskStatus::Failed);
}

#[tokio::test]
async fn user_interventions_reach_the_agent() {
    let h = harness("intervene");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }]))]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder.clone())]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    ctx.control.intervene("coder", "Please use British spelling.");
    run(ctx, &t, "x").await;
    let requests = coder.requests.lock().unwrap();
    assert!(requests[0].messages.iter().any(|m| m.content.as_deref().unwrap_or_default().contains("British spelling")));
}

#[tokio::test]
async fn invalid_arguments_and_unknown_tools_are_reported_to_the_model() {
    let h = harness("invalid");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }]))]);
    let mut bad = call("read_file", json!({}));
    bad.message.tool_calls[0].function.arguments = "{not json".into();
    let coder = scripted(vec![
        bad,
        call("submit_plan", json!({"summary": "", "tasks": []})),
        call("finish", json!({"summary": "ok"})),
    ]);
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder.clone())]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    let report = run(ctx, &t, "x").await;
    assert_eq!(report.outcome, RunOutcome::Completed);
    let requests = coder.requests.lock().unwrap();
    let replies: Vec<String> = requests[2].messages.iter().filter(|m| m.role == MessageRole::Tool).filter_map(|m| m.content.clone()).collect();
    assert!(replies[0].contains("not valid JSON"));
    assert!(replies[1].contains("not available to you"));
}
