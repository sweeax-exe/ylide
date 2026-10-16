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
        update_notes: false,
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

#[tokio::test]
async fn a_continued_run_plans_with_the_previous_run_in_view() {
    let h = harness("continue");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "Test add", "description": "Add a test for add()." }]))]);
    let coder = scripted(vec![call("finish", json!({"summary": "Test added."}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder)]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    let fixed = Task {
        id: "T1".into(),
        title: "Fix add".into(),
        description: String::new(),
        files: vec![],
        assignee: "coder".into(),
        status: TaskStatus::Done,
        attempts: 0,
        result: Some("add() now adds.".into()),
        review: None,
    };
    let board = Blackboard {
        plan: Some(Plan { goal: "Fix the add function".into(), summary: "One edit.".into(), tasks: vec![fixed] }),
        messages: vec![],
        changed_files: ["src/lib.rs".to_string()].into(),
    };
    let previous = crate::PreviousRun::new("Fix the add function", RunOutcome::Completed, "", &board, vec![]);

    let report = crate::run_with_previous(ctx, &t, "Now add a test", Some(&previous)).await;

    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    assert_eq!(report.plan.unwrap().goal, "Now add a test");
    let requests = orchestrator.requests.lock().unwrap();
    let planning = requests[0].messages[1].content.clone().unwrap();
    assert!(planning.starts_with("Previous run"), "{planning}");
    assert!(planning.contains("- [T1] Fix add (done) -> add() now adds."), "{planning}");
    assert!(planning.contains("Changed files: src/lib.rs"), "{planning}");
    assert!(planning.contains("Request from the user:\nNow add a test"), "{planning}");
}

fn stopped_run() -> crate::PreviousRun {
    let task = |id: &str, title: &str, status: TaskStatus, result: Option<&str>| Task {
        id: id.into(),
        title: title.into(),
        description: format!("Do {title}."),
        files: vec![],
        assignee: "coder".into(),
        status,
        attempts: 0,
        result: result.map(Into::into),
        review: None,
    };
    let board = Blackboard {
        plan: Some(Plan {
            goal: "Three steps".into(),
            summary: "One after another.".into(),
            tasks: vec![
                task("T1", "first", TaskStatus::Done, Some("first done")),
                task("T2", "second", TaskStatus::Failed, Some("Stopped: step limit reached.")),
                task("T3", "third", TaskStatus::Pending, None),
            ],
        }),
        messages: vec![],
        changed_files: Default::default(),
    };
    crate::PreviousRun::new("Three steps", RunOutcome::Failed, "", &board, vec![])
}

#[tokio::test]
async fn going_on_after_a_failed_run_does_the_open_tasks() {
    let h = harness("go-on");
    // "Go on" adds nothing: the orchestrator submits an empty task list.
    let orchestrator = scripted(vec![call("submit_plan", json!({ "summary": "Finish the open tasks.", "tasks": [] }))]);
    let coder = scripted(vec![call("finish", json!({"summary": "second done"})), call("finish", json!({"summary": "third done"}))]);
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder.clone())]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));

    let report = crate::run_with_previous(ctx, &t, "Go on", Some(&stopped_run())).await;

    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    let plan = report.plan.unwrap();
    let tasks: Vec<(&str, &str, TaskStatus)> = plan.tasks.iter().map(|t| (t.id.as_str(), t.title.as_str(), t.status)).collect();
    assert_eq!(tasks, vec![("T2", "second", TaskStatus::Done), ("T3", "third", TaskStatus::Done)]);
    // The coder knows how the last attempt ended.
    let requests = coder.requests.lock().unwrap();
    let first = requests[0].messages[1].content.clone().unwrap();
    assert!(first.contains("Your task T2: second\nDo second.\n\nEarlier attempt: failed (Stopped: step limit reached.)."), "{first}");
}

#[tokio::test]
async fn a_new_request_is_planned_after_the_open_tasks() {
    let h = harness("go-on-more");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "fourth", "description": "Do fourth." }]))]);
    let coder = scripted((0..3).map(|i| call("finish", json!({ "summary": format!("done {i}") }))).collect());
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder)]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));

    let report = crate::run_with_previous(ctx, &t, "Also do a fourth step", Some(&stopped_run())).await;

    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    let ids: Vec<String> = report.plan.unwrap().tasks.iter().map(|t| format!("{} {}", t.id, t.title)).collect();
    assert_eq!(ids, vec!["T2 second", "T3 third", "T4 fourth"]);
}

#[tokio::test]
async fn a_fresh_plan_still_needs_a_task() {
    let h = harness("empty-plan");
    let orchestrator = scripted(vec![
        call("submit_plan", json!({ "summary": "nothing", "tasks": [] })),
        plan_call(json!([{ "title": "x", "description": "y" }])),
    ]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder)]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    let report = run(ctx, &t, "x").await;
    assert_eq!(report.plan.unwrap().tasks.len(), 1);
    let requests = orchestrator.requests.lock().unwrap();
    let reply = requests[1].messages.iter().rev().find(|m| m.role == MessageRole::Tool).unwrap();
    assert!(reply.content.as_deref().unwrap().contains("at least one task"));
}

const USER_RULES: &str = "# Rules\n\nAlways use pnpm.\n";

fn with_notes(t: &mut Team) {
    t.update_notes = true;
}

#[tokio::test]
async fn project_notes_reach_every_role_and_are_updated_after_the_run() {
    let h = harness("notes");
    std::fs::write(h.dir.join("AGENTS.md"), USER_RULES).unwrap();
    let orchestrator = scripted(vec![
        plan_call(json!([{ "title": "Fix add", "description": "Make add() add." }])),
        // The notes after the run:
        text("```\n**Tests:** `echo ok` works.\n**Structure:** the code lives in src/lib.rs.\n```"),
    ]);
    let coder = scripted(vec![
        call("run_command", json!({"command": "echo ok"})),
        call("read_file", json!({"path": "src/lib.rs"})),
        call("edit_file", json!({"path": "src/lib.rs", "old_text": "a - b", "new_text": "a + b"})),
        call("finish", json!({"summary": "add() adds."})),
    ]);
    let reviewer = scripted(vec![call("submit_review", json!({"verdict": "approve", "summary": "ok"}))]);
    let mut t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder.clone()), ("reviewer", reviewer.clone())]);
    with_notes(&mut t);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));

    let report = run(ctx, &t, "Fix add").await;

    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    let first = |m: &Arc<ScriptedModel>| m.requests.lock().unwrap()[0].messages[1].content.clone().unwrap();
    for (role, model) in [("orchestrator", &orchestrator), ("coder", &coder), ("reviewer", &reviewer)] {
        let message = first(model);
        assert!(message.starts_with("Project notes from AGENTS.md") && message.contains("Always use pnpm."), "{role}: {message}");
    }
    let notes_request = orchestrator.requests.lock().unwrap()[1].messages[1].content.clone().unwrap();
    assert!(notes_request.contains("Current notes:\n(none yet)"), "{notes_request}");
    assert!(notes_request.contains("Commands that worked in this run:\n- echo ok"), "{notes_request}");

    let file = std::fs::read_to_string(h.dir.join("AGENTS.md")).unwrap().replace("\r\n", "\n");
    assert!(file.starts_with(USER_RULES), "the user's text stays: {file}");
    assert_eq!(
        crate::knowledge::notes(&file).as_deref(),
        Some("**Tests:** `echo ok` works.\n**Structure:** the code lives in src/lib.rs.")
    );
    assert!(report.summary.contains("AGENTS.md"), "{}", report.summary);
    // Written like any change: own checkpoint, so it can be undone.
    let notes_checkpoint = report.checkpoints.iter().find(|c| c.files.iter().any(|f| f.path == "AGENTS.md")).expect("checkpoint");
    h.store.restore("run-1", &notes_checkpoint.id, &h.ws).unwrap();
    assert_eq!(std::fs::read_to_string(h.dir.join("AGENTS.md")).unwrap(), USER_RULES);
}

#[tokio::test]
async fn the_first_run_creates_the_notes_file() {
    let h = harness("notes-new");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }])), text("**Structure:** one crate.")]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let mut t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder.clone())]);
    with_notes(&mut t);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    run(ctx, &t, "x").await;
    // Without a file, no notes go into the prompts.
    assert!(coder.requests.lock().unwrap()[0].messages[1].content.as_deref().unwrap().starts_with("Team progress:"));
    let file = std::fs::read_to_string(h.dir.join("AGENTS.md")).unwrap();
    assert!(file.starts_with("# AGENTS.md"), "{file}");
    assert_eq!(crate::knowledge::notes(&file).as_deref(), Some("**Structure:** one crate."));
    let events = h.events.lock().unwrap();
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolResult { change: Some(c), .. } if c.path == "AGENTS.md" && c.kind == ChangeKind::Created)));
}

#[tokio::test]
async fn notes_are_read_but_not_written_when_switched_off() {
    let h = harness("notes-off");
    std::fs::write(h.dir.join("AGENTS.md"), USER_RULES).unwrap();
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }]))]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder.clone())]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    run(ctx, &t, "x").await;
    assert!(coder.requests.lock().unwrap()[0].messages[1].content.as_deref().unwrap().contains("Always use pnpm."));
    assert_eq!(orchestrator.requests.lock().unwrap().len(), 1, "no notes request");
    assert_eq!(std::fs::read_to_string(h.dir.join("AGENTS.md")).unwrap(), USER_RULES);
}

#[tokio::test]
async fn writing_the_notes_asks_first_in_ask_mode() {
    let h = harness("notes-ask");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }])), text("**Structure:** one crate.")]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let mut t = team(vec![("orchestrator", orchestrator), ("coder", coder)]);
    with_notes(&mut t);
    let ask = PermissionSettings { mode: crate::ApprovalMode::Ask, ..PermissionSettings::default() };
    let ctx = context(&h, ask, Arc::new(Reject));
    run(ctx, &t, "x").await;
    assert!(!h.dir.join("AGENTS.md").exists(), "rejected, so not written");
    let events = h.events.lock().unwrap();
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ApprovalRequested { request, .. } if request.tool == "write_file" && request.title.contains("AGENTS.md"))));
}
