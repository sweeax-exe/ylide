//! End-to-end tests of multi-agent runs with scripted models.

use crate::llm::script::{call, text};
use crate::llm::{ChatModel, ScriptedModel};
use crate::permissions::{ApprovalBroker, AutoApprove, PermissionSettings, UserReply};
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
        summarize: false,
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
    async fn ask_user(&self, _agent_id: &str, _questions: &[crate::Question], _clarify: bool) -> UserReply {
        UserReply::text("no")
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
    async fn ask_user(&self, _agent_id: &str, _questions: &[crate::Question], _clarify: bool) -> UserReply {
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
async fn agents_that_see_get_the_request_images_and_image_view() {
    let h = harness("vision");
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    png.extend(640u32.to_be_bytes());
    png.extend(480u32.to_be_bytes());
    std::fs::write(h.dir.join("mockup.png"), &png).unwrap();
    let screenshot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==".to_string();
    let seeing = |responses| Arc::new(ScriptedModel::new(responses).with_vision());
    let orchestrator = seeing(vec![
        call("image_view", json!({"path": "mockup.png"})),
        plan_call(json!([{ "title": "Match the mockup", "description": "Make add add." }])),
    ]);
    let coder = seeing(vec![call("finish", json!({"summary": "nothing to change"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder.clone())]);
    let events = h.events.clone();
    let ctx = Arc::new(
        RunContext::new("run-1", h.ws.clone(), h.store.clone(), PermissionSettings::default(), ShellConfig::default(), PromptTemplates::default(), Arc::new(AutoApprove(String::new())), Arc::new(move |e| events.lock().unwrap().push(e)))
            .with_goal_images(vec![screenshot.clone()]),
    );
    let report = run(ctx, &t, "Make it look like the screenshot").await;
    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);

    let planning = orchestrator.requests.lock().unwrap().clone();
    assert_eq!(planning[0].messages[1].images, vec![screenshot.clone()], "the request's images go with the first message");
    assert!(planning[0].tools.iter().any(|t| t.function.name == "image_view"));
    let shown = planning[1].messages.last().unwrap();
    assert_eq!((shown.role, shown.content.as_deref()), (MessageRole::Tool, Some("Image mockup.png (640x480 PNG, 1 KB):")));
    assert_eq!(shown.images, vec![inference::image::data_url(inference::image::ImageFormat::Png, &png)]);
    assert!(planning[1].messages[2..].iter().all(|m| m.role == MessageRole::Tool || m.images.is_empty()), "sent once");
    let coding = coder.requests.lock().unwrap().clone();
    assert_eq!(coding[0].messages[1].images, vec![screenshot.clone()]);

    // The user answers a question with a screenshot: it reaches the asking agent.
    struct Screenshot(String);
    #[async_trait]
    impl ApprovalBroker for Screenshot {
        async fn request_approval(&self, _request: ApprovalRequest) -> ApprovalResponse {
            ApprovalResponse::Approve
        }
        async fn ask_user(&self, _agent_id: &str, _questions: &[crate::Question], _clarify: bool) -> UserReply {
            UserReply { text: "Like this.".into(), images: vec![self.0.clone()] }
        }
    }
    let h = harness("vision-answer");
    let orchestrator = seeing(vec![plan_call(json!([{ "title": "Match it", "description": "Make add add." }]))]);
    let coder = seeing(vec![
        call("ask", json!({"to": "user", "question": "How should the cart look?"})),
        call("finish", json!({"summary": "done"})),
    ]);
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder.clone())]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(Screenshot(screenshot.clone())));
    run(ctx, &t, "Fix the cart").await;
    let answered = coder.requests.lock().unwrap()[1].messages.last().cloned().unwrap();
    assert_eq!((answered.role, answered.content.as_deref()), (MessageRole::Tool, Some("Answer from user:\nLike this.")));
    assert_eq!(answered.images, vec![screenshot.clone()]);

    // A model that cannot see gets neither the images nor the tool.
    let h = harness("blind");
    std::fs::write(h.dir.join("mockup.png"), &png).unwrap();
    let orchestrator = scripted(vec![
        call("image_view", json!({"path": "mockup.png"})),
        plan_call(json!([{ "title": "Fix", "description": "Make add add." }])),
    ]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder)]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    run(ctx, &t, "Make it look like the screenshot").await;
    let planning = orchestrator.requests.lock().unwrap().clone();
    assert!(planning[0].messages[1].images.is_empty() && !planning[0].tools.iter().any(|t| t.function.name == "image_view"));
    let answer = planning[1].messages.last().unwrap();
    assert!(answer.content.as_deref().unwrap().contains("not available to you"), "{answer:?}");
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

#[tokio::test]
async fn enabled_skills_are_listed_for_every_role_and_read_on_demand() {
    let h = harness("skills");
    let skill_dir = h.dir.parent().unwrap().join("skills").join("fix-math");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(skill_dir.join("SKILL.md"), "---\nname: fix-math\ndescription: How this team fixes arithmetic bugs.\n---\n# Fix math\nAlways add a doc comment.\n").unwrap();
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "Fix add", "description": "Make add() add." }]))]);
    let coder = scripted(vec![
        call("skill_read", json!({"name": "fix-math"})),
        call("read_file", json!({"path": "src/lib.rs"})),
        call("edit_file", json!({"path": "src/lib.rs", "old_text": "a - b", "new_text": "a + b"})),
        call("finish", json!({"summary": "add() adds."})),
    ]);
    let reviewer = scripted(vec![call("submit_review", json!({"verdict": "approve", "summary": "ok"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder.clone()), ("reviewer", reviewer.clone())]);
    let events = h.events.clone();
    let skill = skills::EnabledSkill { name: "fix-math".into(), description: "How this team fixes arithmetic bugs.".into(), dir: skill_dir };
    let ctx = Arc::new(
        RunContext::new(
            "run-1",
            h.ws.clone(),
            h.store.clone(),
            PermissionSettings::default(),
            ShellConfig::default(),
            PromptTemplates::default(),
            Arc::new(AutoApprove(String::new())),
            Arc::new(move |e| events.lock().unwrap().push(e)),
        )
        .with_skills(vec![skill]),
    );

    let report = run(ctx, &t, "Fix add").await;

    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    for (role, model) in [("orchestrator", &orchestrator), ("coder", &coder), ("reviewer", &reviewer)] {
        let requests = model.requests.lock().unwrap();
        let first = requests[0].messages[1].content.clone().unwrap();
        assert!(first.starts_with("Skills the user enabled") && first.contains("- fix-math: How this team fixes arithmetic bugs.\n"), "{role}: {first}");
        assert!(requests[0].tools.iter().any(|t| t.function.name == "skill_read"), "{role} can read skills");
    }
    let coder_requests = coder.requests.lock().unwrap();
    let answer = coder_requests[1].messages.iter().find(|m| m.role == MessageRole::Tool).and_then(|m| m.content.clone()).unwrap();
    assert!(answer.starts_with("Skill fix-math, SKILL.md (lines 1-2 of 2):\n# Fix math\nAlways add a doc comment."), "{answer}");
    drop(coder_requests);
    let events = h.events.lock().unwrap();
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolResult { ok: true, summary, .. } if summary == "skill fix-math: SKILL.md")));
}

#[tokio::test]
async fn without_skills_there_is_no_skill_tool_and_no_list() {
    let h = harness("no-skills");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }]))]);
    let coder = scripted(vec![call("skill_read", json!({"name": "x"})), call("finish", json!({"summary": "done"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder.clone())]);
    run(context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new()))), &t, "x").await;
    let requests = coder.requests.lock().unwrap();
    assert!(requests[0].tools.iter().all(|t| t.function.name != "skill_read"));
    assert!(!requests[0].messages[1].content.as_deref().unwrap().contains("Skills the user enabled"));
    let refused = requests[1].messages.iter().find(|m| m.role == MessageRole::Tool).and_then(|m| m.content.clone()).unwrap();
    assert!(refused.starts_with("Error: tool 'skill_read' is not available to you."), "{refused}");
}

fn context_in(h: &Harness, language: &str, broker: Arc<dyn ApprovalBroker>) -> Arc<RunContext> {
    let events = h.events.clone();
    Arc::new(
        RunContext::new(
            "run-1",
            h.ws.clone(),
            h.store.clone(),
            PermissionSettings::default(),
            ShellConfig::default(),
            PromptTemplates::default(),
            broker,
            Arc::new(move |e| events.lock().unwrap().push(e)),
        )
        .with_language(language),
    )
}

#[tokio::test]
async fn a_run_ends_with_a_summary_in_the_users_language() {
    let h = harness("recap");
    let orchestrator = scripted(vec![
        plan_call(json!([{ "title": "Fix add", "description": "Make add() add." }])),
        text("```\n- `add()` in `src/lib.rs` addiert jetzt.\n- Prüfe es mit `cargo test`.\n```"),
    ]);
    let coder = scripted(vec![
        call("read_file", json!({"path": "src/lib.rs"})),
        call("edit_file", json!({"path": "src/lib.rs", "old_text": "a - b", "new_text": "a + b"})),
        call("finish", json!({"summary": "add() adds."})),
    ]);
    let reviewer = scripted(vec![call("submit_review", json!({"verdict": "approve", "summary": "Correct."}))]);
    let mut t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder), ("reviewer", reviewer)]);
    t.summarize = true;
    let ctx = context_in(&h, "de", Arc::new(AutoApprove(String::new())));

    let report = run(ctx, &t, "Fix add").await;

    let expected = "- `add()` in `src/lib.rs` addiert jetzt.\n- Prüfe es mit `cargo test`.";
    assert_eq!(report.outcome, RunOutcome::Completed);
    assert_eq!(report.recap.as_deref(), Some(expected));
    assert!(report.summary.starts_with("✔ T1 Fix add"), "the task list stays: {}", report.summary);
    let request = orchestrator.requests.lock().unwrap()[1].messages[1].content.clone().unwrap();
    assert!(request.contains("for the user, in German."), "{request}");
    assert!(request.contains("- T1 Fix add (done): add() adds. Review: approved (Correct.)."), "{request}");
    assert!(request.contains("Changed files:\n- src/lib.rs"), "{request}");
    let events = h.events.lock().unwrap();
    assert!(matches!(events.last(), Some(AgentEvent::RunFinished { recap: Some(r), .. }) if r == expected));
    // The summary streams into the orchestrator's row.
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Status { status, .. } if status.step == crate::orchestrator::RECAP_STEP)));
}

#[tokio::test]
async fn without_a_summary_the_run_keeps_its_task_list() {
    let h = harness("recap-fails");
    // No answer left for the summary: the model call fails.
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }]))]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let mut t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder)]);
    t.summarize = true;
    let ctx = context_in(&h, "ja", Arc::new(AutoApprove(String::new())));
    let report = run(ctx, &t, "x").await;
    assert_eq!(report.outcome, RunOutcome::Completed);
    assert_eq!(report.recap, None);
    assert!(report.summary.contains("✔ T1 x"), "{}", report.summary);
    assert_eq!(orchestrator.requests.lock().unwrap().len(), 2, "the summary was asked for");
    assert!(matches!(h.events.lock().unwrap().last(), Some(AgentEvent::RunFinished { recap: None, .. })));
}

#[tokio::test]
async fn a_stopped_run_gets_no_summary() {
    let h = harness("recap-stopped");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }])), text("never asked for")]);
    let coder = scripted(vec![call("ask", json!({"to": "user", "question": "Tabs or spaces?"}))]);
    let mut t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder)]);
    t.summarize = true;
    let ctx = context_in(&h, "de", Arc::new(Silent));
    let control = ctx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        control.control.cancel();
    });
    let report = tokio::time::timeout(std::time::Duration::from_secs(5), run(ctx, &t, "anything")).await.expect("ends");
    assert_eq!(report.outcome, RunOutcome::Cancelled);
    assert_eq!(report.recap, None);
    assert_eq!(orchestrator.remaining(), 1, "no model call for the summary");
}

#[tokio::test]
async fn the_summary_call_thinks_little_and_cut_off_answers_are_dropped() {
    let h = harness("recap-length");
    let mut cut = text("- `add()` addiert jetzt, und die Tes");
    cut.finish_reason = inference::FinishReason::Length;
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }])), cut]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let mut t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder)]);
    t.summarize = true;
    let report = run(context_in(&h, "de", Arc::new(AutoApprove(String::new()))), &t, "x").await;
    assert_eq!(report.recap, None, "a summary cut off by the token limit is not shown");
    let requests = orchestrator.requests.lock().unwrap();
    let req = &requests[1];
    assert!(req.quick, "chat defaults: thinking off or low");
    assert_eq!(req.max_tokens, Some(crate::recap::MAX_TOKENS));
    assert_eq!(req.messages[0].content.as_deref(), Some(crate::recap::SYSTEM), "not the orchestrator's planning prompt");
    assert!(req.tools.is_empty());
}

#[tokio::test]
async fn a_plan_instead_of_a_summary_is_dropped() {
    let h = harness("recap-plan");
    let orchestrator = scripted(vec![
        plan_call(json!([{ "title": "x", "description": "y" }])),
        text(r#"{"summary": "Do it again", "tasks": [{"title": "x", "description": "y"}]}"#),
    ]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let mut t = team(vec![("orchestrator", orchestrator), ("coder", coder)]);
    t.summarize = true;
    let report = run(context_in(&h, "en", Arc::new(AutoApprove(String::new()))), &t, "x").await;
    assert_eq!(report.recap, None);
}

#[tokio::test]
async fn the_summary_names_the_work_not_the_project_notes() {
    let h = harness("recap-notes");
    let orchestrator = scripted(vec![
        plan_call(json!([{ "title": "Fix add", "description": "Make add() add." }])),
        text("**Structure:** one crate."),
        text("Fixed add()."),
    ]);
    let coder = scripted(vec![
        call("read_file", json!({"path": "src/lib.rs"})),
        call("edit_file", json!({"path": "src/lib.rs", "old_text": "a - b", "new_text": "a + b"})),
        call("finish", json!({"summary": "add() adds."})),
    ]);
    // The reviewer answers in text and never gives a verdict.
    let reviewer = scripted(vec![text("Looks fine to me."), text("Still fine.")]);
    let mut t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder), ("reviewer", reviewer)]);
    t.summarize = true;
    t.update_notes = true;
    let report = run(context_in(&h, "en", Arc::new(AutoApprove(String::new()))), &t, "Fix add").await;
    assert_eq!(report.recap.as_deref(), Some("Fixed add()."));
    assert!(h.dir.join("AGENTS.md").exists(), "the notes were written");
    let request = orchestrator.requests.lock().unwrap()[2].messages[1].content.clone().unwrap();
    assert!(request.contains("Changed files:\n- src/lib.rs\n\n"), "{request}");
    assert!(!request.contains("AGENTS.md"), "{request}");
    assert!(request.contains("Review: not done ("), "{request}");
    assert!(!request.contains("Review: approved"), "{request}");
}

/// A user at the question card: records what was asked and answers with fixed answers.
#[derive(Default)]
struct Answering {
    answers: Vec<String>,
    asked: Mutex<Vec<(String, Vec<crate::Question>, bool)>>,
}

impl Answering {
    fn with(answers: &[&str]) -> Arc<Self> {
        Arc::new(Self { answers: answers.iter().map(|a| a.to_string()).collect(), ..Self::default() })
    }
}

#[async_trait]
impl ApprovalBroker for Answering {
    async fn request_approval(&self, _request: ApprovalRequest) -> ApprovalResponse {
        ApprovalResponse::Approve
    }
    async fn ask_user(&self, agent_id: &str, questions: &[crate::Question], clarify: bool) -> UserReply {
        self.asked.lock().unwrap().push((agent_id.to_string(), questions.to_vec(), clarify));
        UserReply::text(crate::questions::format_reply(questions, &self.answers))
    }
}

fn context_with(h: &Harness, permissions: PermissionSettings, broker: Arc<dyn ApprovalBroker>, setup: impl FnOnce(RunContext) -> RunContext) -> Arc<RunContext> {
    let events = h.events.clone();
    let ctx = RunContext::new("run-1", h.ws.clone(), h.store.clone(), permissions, ShellConfig::default(), PromptTemplates::default(), broker, Arc::new(move |e| events.lock().unwrap().push(e)));
    Arc::new(setup(ctx))
}

fn tool_names(request: &inference::ChatRequest) -> Vec<String> {
    request.tools.iter().map(|t| t.function.name.clone()).collect()
}

fn last_content(request: &inference::ChatRequest) -> String {
    request.messages.last().and_then(|m| m.content.clone()).unwrap_or_default()
}

#[tokio::test]
async fn an_ambiguous_request_gets_one_round_of_questions_before_the_plan() {
    let h = harness("clarify");
    let orchestrator = scripted(vec![
        call("list_dir", json!({"path": ""})),
        call("clarify", json!({"questions": [
            {"question": "Welcher Test-Runner?", "options": ["Vitest (empfohlen)", "Jest"]},
            "Soll die alte API bleiben?"
        ]})),
        // A second round is refused: the planner plans with what it has.
        call("clarify", json!({"questions": ["Noch etwas?"]})),
        plan_call(json!([{ "title": "Add tests", "description": "With Vitest." }])),
    ]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder.clone())]);
    let broker = Answering::with(&["Vitest", ""]);
    let ctx = context_with(&h, PermissionSettings::default(), broker.clone(), |c| c.with_language("de"));

    let report = run(ctx, &t, "Add tests").await;

    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    let asked = broker.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1, "one round only: {asked:?}");
    let (agent, questions, clarify) = &asked[0];
    assert_eq!((agent.as_str(), *clarify, questions.len()), ("orchestrator", true, 2));
    assert_eq!(questions[0].options.iter().map(|o| (o.label.as_str(), o.recommended)).collect::<Vec<_>>(), vec![("Vitest", true), ("Jest", false)]);
    assert!(questions[1].options.is_empty());

    let requests = orchestrator.requests.lock().unwrap().clone();
    let clarify_tool = requests[0].tools.iter().find(|t| t.function.name == "clarify").expect("the planner may ask");
    assert!(clarify_tool.function.description.contains("in German") && clarify_tool.function.description.contains("once per run"), "{}", clarify_tool.function.description);
    let answers = last_content(&requests[2]);
    assert!(answers.starts_with("Answers from the user:\n1. Welcher Test-Runner?\nAnswer: Vitest\n\n2. Soll die alte API bleiben?\nAnswer: (no answer"), "{answers}");
    assert!(last_content(&requests[3]).contains("You already asked the user once"), "{}", last_content(&requests[3]));
    assert!(!tool_names(&coder.requests.lock().unwrap()[0]).contains(&"clarify".to_string()), "only the planner asks before the plan");

    let events = h.events.lock().unwrap();
    let messages: Vec<(&str, MessageKind)> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Message { message, .. } => Some((message.from.as_str(), message.kind)),
            _ => None,
        })
        .collect();
    assert_eq!(messages, vec![("orchestrator", MessageKind::Question), ("user", MessageKind::Answer)]);
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Status { status, .. } if status.step == "asking the user" && status.state == AgentState::WaitingForAnswer)));
}

#[tokio::test]
async fn a_garbled_round_of_questions_plans_right_away() {
    let h = harness("clarify-garbage");
    let orchestrator = scripted(vec![
        call("clarify", json!({"questions": [1, {"options": ["a", "b"]}, ""]})),
        // Nor can it try again with good questions.
        call("clarify", json!({"questions": ["Which one?"]})),
        plan_call(json!([{ "title": "Fix add", "description": "Make add add." }])),
    ]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder)]);
    let broker = Answering::with(&["x"]);
    let report = run(context(&h, PermissionSettings::default(), broker.clone()), &t, "fix add").await;
    assert_eq!(report.outcome, RunOutcome::Completed);
    assert_eq!(report.plan.unwrap().tasks[0].title, "Fix add");
    assert!(broker.asked.lock().unwrap().is_empty(), "nothing usable was asked");
    let requests = orchestrator.requests.lock().unwrap();
    assert!(last_content(&requests[1]).contains("no usable question"), "{}", last_content(&requests[1]));
    assert!(last_content(&requests[2]).contains("already asked"));
}

#[tokio::test]
async fn questions_written_as_json_are_asked_too() {
    let h = harness("clarify-text");
    let orchestrator = scripted(vec![
        text("Before I plan:\n{\"questions\": [{\"question\": \"Which database?\", \"options\": [\"SQLite (recommended)\", \"Postgres\"]}]}"),
        plan_call(json!([{ "title": "Store carts", "description": "In SQLite." }])),
    ]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder)]);
    let broker = Answering::with(&["SQLite"]);
    let report = run(context(&h, PermissionSettings::default(), broker.clone()), &t, "store the carts").await;
    assert_eq!(report.outcome, RunOutcome::Completed);
    assert_eq!(broker.asked.lock().unwrap()[0].1[0].options[0].label, "SQLite");
    let answer = orchestrator.requests.lock().unwrap()[1].messages.last().cloned().unwrap();
    assert_eq!(answer.role, MessageRole::User);
    assert!(answer.content.unwrap().starts_with("Answers from the user:\nSQLite\n"));
}

#[tokio::test]
async fn with_questions_off_the_planner_cannot_ask() {
    let h = harness("clarify-never");
    let orchestrator = scripted(vec![
        call("clarify", json!({"questions": ["Which one?"]})),
        plan_call(json!([{ "title": "Fix add", "description": "Make add add." }])),
    ]);
    let coder = scripted(vec![call("finish", json!({"summary": "done"}))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", coder)]);
    let broker = Answering::with(&["x"]);
    let ctx = context_with(&h, PermissionSettings::default(), broker.clone(), |c| c.with_questions(crate::QuestionLevel::Never));
    let report = run(ctx, &t, "fix add").await;
    assert_eq!(report.outcome, RunOutcome::Completed);
    assert!(broker.asked.lock().unwrap().is_empty());
    {
        let requests = orchestrator.requests.lock().unwrap();
        assert!(!tool_names(&requests[0]).contains(&"clarify".to_string()));
        assert!(last_content(&requests[1]).contains("tool 'clarify' is not available to you"));
    }

    // "Often" words the tool for more questions.
    let h = harness("clarify-often");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "x", "description": "y" }]))]);
    let t = team(vec![("orchestrator", orchestrator.clone()), ("coder", scripted(vec![call("finish", json!({"summary": "done"}))]))]);
    run(context_with(&h, PermissionSettings::default(), Answering::with(&[]), |c| c.with_questions(crate::QuestionLevel::Often)), &t, "x").await;
    let tool = orchestrator.requests.lock().unwrap()[0].tools.iter().find(|t| t.function.name == "clarify").cloned().unwrap();
    assert!(tool.function.description.contains("choices open that change the result"));
}

#[tokio::test]
async fn asking_the_user_offers_answers_to_click() {
    let h = harness("ask-options");
    let orchestrator = scripted(vec![plan_call(json!([{ "title": "Test it", "description": "Add a test." }]))]);
    let coder = scripted(vec![
        call("ask", json!({"to": "user", "question": "Which runner?", "options": ["Vitest (recommended)", "Jest", "Mocha"], "multiple": false})),
        call("finish", json!({"summary": "done"})),
    ]);
    let t = team(vec![("orchestrator", orchestrator), ("coder", coder.clone())]);
    let broker = Answering::with(&["Jest"]);
    let ctx = context_with(&h, PermissionSettings::default(), broker.clone(), |c| c.with_language("fr"));
    run(ctx, &t, "test it").await;
    let asked = broker.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    let (agent, questions, clarify) = &asked[0];
    assert_eq!((agent.as_str(), *clarify), ("coder", false));
    assert_eq!(questions[0].options.len(), 3);
    assert!(questions[0].options[0].recommended);
    let requests = coder.requests.lock().unwrap();
    let ask = requests[0].tools.iter().find(|t| t.function.name == "ask").unwrap();
    assert!(ask.function.description.ends_with("Write questions for the user in French."));
    assert_eq!(last_content(&requests[1]), "Answer from user:\nJest");
    drop(requests);
    // The message log shows the options with the question.
    let events = h.events.lock().unwrap();
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Message { message, .. } if message.content == "Which runner?\nOptions: Vitest (recommended) / Jest / Mocha")));
}

/// Records approvals; in planning mode there must be none.
#[derive(Default)]
struct Watching {
    approvals: Mutex<Vec<String>>,
}

#[async_trait]
impl ApprovalBroker for Watching {
    async fn request_approval(&self, request: ApprovalRequest) -> ApprovalResponse {
        self.approvals.lock().unwrap().push(request.tool);
        ApprovalResponse::Approve
    }
    async fn ask_user(&self, _agent_id: &str, _questions: &[crate::Question], _clarify: bool) -> UserReply {
        UserReply::text("ok")
    }
}

fn plan_with(tasks: serde_json::Value) -> ChatResult {
    call(
        "submit_plan",
        json!({
            "summary": "Fix add(), then test it.",
            "tasks": tasks,
            "risks": ["Callers may rely on the bug"],
            "questions": [{ "question": "Add a test?", "options": ["Yes (recommended)", "No"] }]
        }),
    )
}

#[tokio::test]
async fn planning_only_reads_even_when_the_model_tries_to_change_things() {
    let h = harness("planning-read-only");
    let orchestrator = scripted(vec![
        call("write_file", json!({"path": "src/lib.rs", "content": "broken"})),
        call("edit_file", json!({"path": "src/lib.rs", "old_text": "a - b", "new_text": "a + b"})),
        call("delete_file", json!({"path": "src/lib.rs"})),
        call("run_command", json!({"command": "echo hacked > hacked.txt"})),
        call("read_file", json!({"path": "src/lib.rs"})),
        plan_with(json!([
            { "title": "Fix add", "description": "Make add() add.", "files": ["src/lib.rs"], "verify": "cargo test" },
            { "title": "Test add", "description": "Add a test." }
        ])),
    ]);
    let mut t = team(vec![("orchestrator", orchestrator.clone())]);
    // A user who gave the orchestrator role tools that change things.
    t.roles.iter_mut().find(|r| r.id == "orchestrator").unwrap().tools.extend(["write_file", "edit_file", "delete_file", "run_command"].map(String::from));
    let broker = Arc::new(Watching::default());
    let ctx = context_with(&h, PermissionSettings { mode: crate::ApprovalMode::Autonomous, confirm_commands: false, confirm_deletes: false, ..PermissionSettings::default() }, broker.clone(), |c| c.read_only().with_language("de"));
    let req = crate::PlanRequest { goal: "Fix the add function".into(), ..Default::default() };

    let doc = crate::draft_plan(ctx.clone(), &t, &req, None).await.expect("a plan");

    assert_eq!(std::fs::read_to_string(h.dir.join("src/lib.rs")).unwrap(), "pub fn add(a: i32, b: i32) -> i32 {\n    a - b\n}\n", "nothing changed");
    assert!(!h.dir.join("hacked.txt").exists(), "no command ran");
    assert!(broker.approvals.lock().unwrap().is_empty(), "nothing even asked for approval");
    let requests = orchestrator.requests.lock().unwrap().clone();
    let mut offered = tool_names(&requests[0]);
    offered.sort();
    assert_eq!(offered, vec!["find_files", "list_dir", "read_file", "search", "submit_plan"], "only reading tools and the plan");
    for (i, m) in requests[4].messages.iter().filter(|m| m.role == MessageRole::Tool).enumerate() {
        assert!(m.content.as_deref().unwrap().contains("not available to you"), "call {i}: {:?}", m.content);
    }
    let request = requests[0].messages[1].content.clone().unwrap();
    assert!(request.starts_with("Planning mode: you only read the project"), "{request}");
    assert!(request.contains("Write the plan in German") && request.contains("only for important choices"), "{request}");

    assert_eq!(doc.goal, "Fix the add function");
    assert_eq!(doc.steps.iter().map(|s| (s.id.as_str(), s.verify.as_str())).collect::<Vec<_>>(), vec![("T1", "cargo test"), ("T2", "")]);
    assert_eq!(doc.risks, vec!["Callers may rely on the bug"]);
    assert_eq!(doc.questions[0].options.len(), 2);
    {
        let events = h.events.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, AgentEvent::PlanDrafted { plan, .. } if plan == &doc)));
        assert!(matches!(events.last(), Some(AgentEvent::RunFinished { outcome: RunOutcome::Completed, .. })));
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::ToolResult { change: Some(_), .. })));
    }

    // The write path itself refuses too, whatever calls it.
    let role = t.role("orchestrator").unwrap();
    let spec = crate::runner::AgentSpec { id: "orchestrator".into(), role, model: orchestrator.clone(), extra_tools: vec![] };
    let outcome = crate::runner::call_tool(&ctx, &spec, "write_file", json!({"path": "x.txt", "content": "x"})).await;
    assert!(!outcome.ok && outcome.output.contains("planning mode"), "{}", outcome.output);
    assert!(!h.dir.join("x.txt").exists());
}

#[tokio::test]
async fn a_plan_changes_as_the_user_wishes_and_keeps_its_step_ids() {
    let h = harness("planning-change");
    let current = crate::PlanDoc {
        goal: "Fix the add function".into(),
        approach: "Fix, then test.".into(),
        steps: vec![
            crate::PlanStep { id: "T1".into(), title: "Fix add".into(), description: "Make add() add.".into(), files: vec!["src/lib.rs".into()], verify: "cargo test".into(), assignee: "coder".into() },
            // The user renamed this step by hand.
            crate::PlanStep { id: "T2".into(), title: "Test add with negatives".into(), description: String::new(), files: vec![], verify: String::new(), assignee: "coder".into() },
        ],
        risks: vec![],
        questions: vec![],
    };
    let orchestrator = scripted(vec![plan_with(json!([
        { "id": "T1", "title": "Fix add", "description": "Make add() add.", "files": ["src/lib.rs"] },
        { "title": "Document add", "description": "Add a doc comment." },
        { "id": "T2", "title": "Test add with negatives", "description": "Use cargo test." }
    ]))]);
    let t = team(vec![("orchestrator", orchestrator.clone())]);
    let ctx = context_with(&h, PermissionSettings::default(), Arc::new(Watching::default()), |c| c.read_only().with_questions(crate::QuestionLevel::Never));
    let req = crate::PlanRequest {
        goal: current.goal.clone(),
        current: Some(current),
        wish: Some("Füge vor den Tests einen Schritt für die Doku ein".into()),
        earlier_wishes: vec!["Erst den Fix".into()],
    };
    let doc = crate::draft_plan(ctx, &t, &req, None).await.expect("a changed plan");
    assert_eq!(doc.steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["T1", "T3", "T2"]);
    assert!(doc.questions.is_empty(), "the user wants no questions");
    let request = orchestrator.requests.lock().unwrap()[0].messages[1].content.clone().unwrap();
    assert!(request.contains("- [T2] Test add with negatives\n"), "the user's own edit is in the request: {request}");
    assert!(request.contains("The user's new wish:\nFüge vor den Tests einen Schritt für die Doku ein"), "{request}");
    assert!(request.contains("Earlier wishes of the user:\n- Erst den Fix"), "{request}");
    assert!(request.contains("Add no open questions"), "{request}");
}

#[tokio::test]
async fn a_planning_run_without_a_plan_fails_and_a_stopped_one_is_cancelled() {
    let h = harness("planning-none");
    let t = team(vec![("orchestrator", scripted(vec![text("I would rather not."), text("Still no.")]))]);
    let ctx = context_with(&h, PermissionSettings::default(), Arc::new(Watching::default()), |c| c.read_only());
    assert_eq!(crate::draft_plan(ctx, &t, &crate::PlanRequest { goal: "x".into(), ..Default::default() }, None).await, None);
    assert!(matches!(h.events.lock().unwrap().last(), Some(AgentEvent::RunFinished { outcome: RunOutcome::Failed, .. })));

    let h = harness("planning-stopped");
    let t = team(vec![("orchestrator", scripted(vec![plan_with(json!([{ "title": "x", "description": "y" }]))]))]);
    let ctx = context_with(&h, PermissionSettings::default(), Arc::new(Watching::default()), |c| c.read_only());
    ctx.control.cancel();
    assert_eq!(crate::draft_plan(ctx, &t, &crate::PlanRequest { goal: "x".into(), ..Default::default() }, None).await, None);
    assert!(matches!(h.events.lock().unwrap().last(), Some(AgentEvent::RunFinished { outcome: RunOutcome::Cancelled, .. })));
}

fn doc(steps: &[(&str, &str)]) -> crate::PlanDoc {
    crate::PlanDoc {
        goal: "Make add right".into(),
        approach: "Step by step.".into(),
        steps: steps
            .iter()
            .map(|(id, title)| crate::PlanStep { id: id.to_string(), title: title.to_string(), description: format!("Do {title}."), files: vec![], verify: "cargo test".into(), assignee: "coder".into() })
            .collect(),
        risks: vec![],
        questions: vec![],
    }
}

/// A run whose `control` asks to stop after the task that is in progress
/// once `task` starts.
fn stopping_at(h: &Harness, task: &'static str) -> Arc<RunContext> {
    let events = h.events.clone();
    let control: Arc<Mutex<Option<crate::RunControl>>> = Arc::default();
    let stop = control.clone();
    let ctx = Arc::new(RunContext::new(
        "run-1",
        h.ws.clone(),
        h.store.clone(),
        PermissionSettings::default(),
        ShellConfig::default(),
        PromptTemplates::default(),
        Arc::new(AutoApprove(String::new())),
        Arc::new(move |e: AgentEvent| {
            if let AgentEvent::TaskUpdated { task: t, .. } = &e
                && t.id == task
                && t.status == TaskStatus::InProgress
                && let Some(c) = stop.lock().unwrap().as_ref()
            {
                c.stop_after_task(true);
            }
            events.lock().unwrap().push(e);
        }),
    ));
    *control.lock().unwrap() = Some(ctx.control.clone());
    ctx
}

#[tokio::test]
async fn a_plan_runs_as_its_tasks_and_switching_to_planning_stops_after_the_current_one() {
    let h = harness("plan-run");
    let coder = scripted(vec![
        call("edit_file", json!({"path": "src/lib.rs", "old_text": "a - b", "new_text": "a + b"})),
        call("finish", json!({"summary": "add() adds."})),
    ]);
    let t = team(vec![("coder", coder.clone())]);
    let first = doc(&[("T1", "Fix add"), ("T2", "Test add"), ("T3", "Docs")]);

    // The user switches to planning while T1 runs: T1 finishes, nothing else starts.
    let report = crate::run_plan(stopping_at(&h, "T1"), &t, &first).await;
    assert_eq!(report.outcome, RunOutcome::Cancelled);
    let tasks = &report.plan.as_ref().unwrap().tasks;
    assert_eq!(tasks.iter().map(|t| (t.id.as_str(), t.status)).collect::<Vec<_>>(), vec![("T1", TaskStatus::Done), ("T2", TaskStatus::Pending), ("T3", TaskStatus::Pending)]);
    assert!(tasks[0].description.ends_with("How to verify: cargo test"), "{}", tasks[0].description);
    assert_eq!(coder.remaining(), 0, "no model call for T2");
    let coding = coder.requests.lock().unwrap()[0].messages[1].content.clone().unwrap();
    assert!(coding.contains("Your task T1: Fix add"), "{coding}");
    assert!(!h.events.lock().unwrap().iter().any(|e| matches!(e, AgentEvent::Status { status, .. } if status.task_id.as_deref() == Some("T2"))));

    // Its open tasks become the plan again; the user drops T3 and adds T4.
    let previous = crate::PreviousRun::new("Make add right", report.outcome, &report.summary, &crate::protocol::Blackboard { plan: report.plan.clone(), ..Default::default() }, vec![]);
    let open: Vec<String> = previous.open_tasks().into_iter().map(|t| t.id).collect();
    assert_eq!(open, vec!["T2", "T3"]);
    let second = doc(&[("T2", "Test add"), ("T4", "Changelog")]);
    let coder = scripted(vec![call("finish", json!({"summary": "tested"})), call("finish", json!({"summary": "noted"}))]);
    let t = team(vec![("coder", coder.clone())]);
    let h2 = harness("plan-run-2");
    let report = crate::run_plan(context(&h2, PermissionSettings::default(), Arc::new(AutoApprove(String::new()))), &t, &second).await;
    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    assert_eq!(report.plan.unwrap().tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["T2", "T4"], "same ids, T1 is not done again");
    assert_eq!(coder.remaining(), 0);
}

#[tokio::test]
async fn taking_the_switch_back_lets_the_run_go_on() {
    let h = harness("plan-run-back");
    let coder = scripted(vec![call("finish", json!({"summary": "one"})), call("finish", json!({"summary": "two"}))]);
    let t = team(vec![("coder", coder)]);
    let ctx = context(&h, PermissionSettings::default(), Arc::new(AutoApprove(String::new())));
    // To planning and back again before the next task starts.
    ctx.control.stop_after_task(true);
    assert!(ctx.control.stops_after_task());
    ctx.control.stop_after_task(false);
    let report = crate::run_plan(ctx, &t, &doc(&[("T1", "One"), ("T2", "Two")])).await;
    assert_eq!(report.outcome, RunOutcome::Completed, "{}", report.summary);
    assert!(report.plan.unwrap().tasks.iter().all(|t| t.status == TaskStatus::Done));
}
