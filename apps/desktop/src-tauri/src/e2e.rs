//! End-to-end test against a real llama-server and a real model. It is ignored
//! by default because it needs a downloaded runtime and model:
//!
//! ```text
//! node scripts/fetch-runtime.mjs
//! $env:YLIDE_E2E_MODEL = "C:\...\Qwen3.5-4B-Q4_K_M.gguf"
//! cargo test -p ylide-desktop --lib e2e -- --ignored --nocapture
//! ```
//!
//! `YLIDE_E2E_RUNTIME` selects another runtime folder (default: bundled Vulkan),
//! e.g. `<local data>\runtimes\b11669\cuda-13.4`. `real_model_sees_images`
//! below tests image input with a model that sees.

use crate::agents::AgentModel;
use crate::chat::{Mode, apply_mode};
use crate::runtime::{ChatHandle, LaunchOptions, SERVER_BINARY, ToolCallSupport, backend_of, chat_args, parse_help_flags, tool_self_test};
use agent::llm::ChatModel;
use agent::permissions::{AutoApprove, PermissionSettings};
use agent::{AgentEvent, CheckpointStore, PromptTemplates, RunContext, ScheduledModel, ShellConfig, Team};
use inference::{ChatMessage, ChatRequest, LlamaServer, Priority, Scheduler, ServerConfig};
use registry::Model;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

fn runtime_dir() -> PathBuf {
    std::env::var_os("YLIDE_E2E_RUNTIME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("runtime").join("vulkan"))
}

fn model_from_env() -> PathBuf {
    std::env::var_os("YLIDE_E2E_MODEL").map(PathBuf::from).unwrap_or_else(|| panic!("set YLIDE_E2E_MODEL to a GGUF file"))
}

/// The registry entry of a downloaded model file, by its file name.
fn registry_model(model_path: &Path) -> Option<Model> {
    let file_name = model_path.file_name().unwrap().to_string_lossy().to_string();
    let model = registry::bundled().models.into_iter().find(|m| m.variants.iter().any(|v| v.files.iter().any(|f| f.path == file_name)));
    println!("model: {} ({:?})", file_name, model.as_ref().map(|m| &m.id));
    model
}

/// Starts llama-server with exactly the flags the app would use. The run
/// folder (pid and key files) lives as long as the returned guard.
async fn launch(model_path: &Path, model: Option<&Model>, projector: Option<&str>, context: u32) -> (LlamaServer, ChatHandle, tempfile::TempDir) {
    let runtime = runtime_dir();
    let binary = runtime.join(SERVER_BINARY);
    assert!(binary.exists(), "runtime missing: {}", binary.display());
    let help = tokio::process::Command::new(&binary).arg("--help").output().await.unwrap();
    let flags = parse_help_flags(&String::from_utf8_lossy(&help.stdout));
    let devices = inference::list_devices(&binary).await.unwrap();
    println!("devices: {devices:?}");
    let hw = hardware::probe(None);
    let gpu_name = hw.primary_gpu().map(|g| g.name.to_lowercase()).unwrap_or_default();
    let device = devices.iter().find(|d| d.description.to_lowercase().contains(&gpu_name)).or(devices.first()).map(|d| d.id.clone());
    let options = LaunchOptions {
        model_path: &model_path.display().to_string(),
        model,
        context,
        slots: 2,
        plan: None,
        threads: hw.cpu.physical_cores,
        ram_total: hw.memory.total_bytes,
        ram_available: hw.memory.available_bytes,
        device,
        extra: &[],
        runtime_backend: backend_of(&runtime.file_name().unwrap_or_default().to_string_lossy()),
        projector,
        tuning: None,
    };
    let args = chat_args(&options, &flags);
    println!("args: {}", args.join(" "));
    let run_dir = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let server = LlamaServer::start(
        ServerConfig {
            binary: binary.clone(),
            args,
            env: vec![],
            ready_timeout: Duration::from_secs(300),
            pid_file: Some(run_dir.path().join("chat.pid")),
            key_dir: Some(run_dir.path().to_path_buf()),
        },
        |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("server did not start: {e}"));
    println!("server ready after {:.1}s at {}", started.elapsed().as_secs_f64(), server.endpoint().base_url);
    let handle = ChatHandle {
        client: server.client(),
        scheduler: Scheduler::new(2),
        model: model.cloned(),
        context,
        pin_slot: true,
        vision: projector.is_some(),
    };
    (server, handle, run_dir)
}

fn agent_team(handle: &ChatHandle) -> Team {
    let agent_model = |label: &str| -> Arc<dyn ChatModel> {
        Arc::new(AgentModel {
            inner: ScheduledModel {
                client: handle.client.clone(),
                scheduler: handle.scheduler.clone(),
                priority: Priority::Agent,
                preferred_slot: Some(0),
                label: label.into(),
                context_tokens: handle.context,
                pin_slot: true,
            },
            model: handle.model.clone(),
            vision: handle.vision,
        })
    };
    let roles = agent::default_roles();
    let mut models = HashMap::new();
    for r in &roles {
        models.insert(r.id.clone(), agent_model(&r.name));
    }
    Team {
        roles,
        models,
        default_model: agent_model("agent"),
        max_review_rounds: 1,
        review_enabled: true,
        update_notes: false,
        summarize: false,
    }
}

fn print_event(e: &AgentEvent) {
    match e {
        AgentEvent::ToolCall { agent_id, tool, arguments, .. } => println!("  [{agent_id}] {tool} {}", arguments.chars().take(160).collect::<String>()),
        AgentEvent::ToolResult { agent_id, ok, summary, .. } => println!("  [{agent_id}] -> {} {summary}", if *ok { "ok" } else { "error" }),
        AgentEvent::PlanReady { plan, .. } => println!("  plan: {} task(s): {}", plan.tasks.len(), plan.tasks.iter().map(|t| t.title.as_str()).collect::<Vec<_>>().join(" | ")),
        AgentEvent::TaskUpdated { task, .. } => println!("  task {} -> {:?}", task.id, task.status),
        AgentEvent::Message { message, .. } => println!("  message {} -> {}: {}", message.from, message.to, message.content.chars().take(160).collect::<String>()),
        _ => {}
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a downloaded runtime and model (see module docs)"]
async fn real_model_end_to_end() {
    let model_path = model_from_env();
    let model = registry_model(&model_path);
    let context = 16_384;
    let (mut server, handle, _run_dir) = launch(&model_path, model.as_ref(), None, context).await;

    // --- 2. tool-call self-test (as run after every start in the app)
    let tools = tool_self_test(&handle).await;
    println!("tool calls: {tools:?}");
    assert_ne!(tools, ToolCallSupport::Failed, "the model could not call a tool");

    // --- 3. plain chat with the chat-mode defaults from the registry
    let mut req = ChatRequest::new(vec![ChatMessage::user("Reply with exactly one word: pong")]);
    apply_mode(&mut req, model.as_ref(), Mode::Chat);
    let t0 = Instant::now();
    let r = handle.client.chat(req, &CancellationToken::new(), |_| {}).await.unwrap();
    let text = r.message.content.clone().unwrap_or_default();
    println!(
        "chat: {text:?} in {:.1}s, {:.0} tok/s",
        t0.elapsed().as_secs_f64(),
        r.timings.map(|t| t.generation_tokens_per_second).unwrap_or_default()
    );
    assert!(text.to_lowercase().contains("pong"), "unexpected chat answer: {text}");

    // --- 4. a full orchestrated agent run on a small buggy project
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(project.path().join("src")).unwrap();
    std::fs::write(
        project.path().join("src/cart.ts"),
        "export interface Item {\n  id: string;\n  price: number;\n  quantity: number;\n}\n\nexport function total(items: Item[]): number {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n",
    )
    .unwrap();
    let ws = workspace::Workspace::open(project.path()).unwrap();
    let store = tempfile::tempdir().unwrap();
    let team = agent_team(&handle);
    let ctx = Arc::new(RunContext::new(
        "e2e-run",
        ws,
        Arc::new(CheckpointStore::new(store.path())),
        PermissionSettings::default(),
        ShellConfig::default(),
        PromptTemplates::default(),
        Arc::new(AutoApprove("Use your best judgement.".into())),
        Arc::new(|e| print_event(&e)),
    ));
    let t0 = Instant::now();
    let report = agent::run(ctx, &team, "In src/cart.ts, total() ignores the quantity. Fix it so it multiplies price by quantity.").await;
    println!("agent run: {:?} in {:.0}s\n{}", report.outcome, t0.elapsed().as_secs_f64(), report.summary);
    let fixed = std::fs::read_to_string(project.path().join("src/cart.ts")).unwrap();
    println!("src/cart.ts after the run:\n{fixed}");
    server.stop().await;
    assert!(fixed.contains("quantity") && fixed.contains("*"), "the agent did not fix the bug");
}

/// Image input with a real model that sees (its registry entry has a
/// projector), with `YLIDE_E2E_MODEL` and `YLIDE_E2E_RUNTIME` as above:
///
/// ```text
/// cargo test -p ylide-desktop --lib e2e::real_model_sees_images -- --ignored --nocapture
/// ```
///
/// The projector is taken from next to the model, where the "Understand
/// images" switch downloads it; if it is not there yet, it is downloaded the
/// same way (pinned revision, checksum verified). The test image is the chat
/// screenshot in docs/images.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a downloaded runtime, model and projector (see module docs)"]
async fn real_model_sees_images() {
    use agent::tools::{IMAGE_VIEW, tool_spec};
    use inference::image::{ImageFormat, data_url, image_info};
    use inference::{FunctionCall, ToolCall};

    let model_path = model_from_env();
    let model = registry_model(&model_path).expect("the model must be in the registry");
    // `<models>/<publisher>__<repo>/<file>`: the store's folder is two levels up.
    let store = crate::models::ModelStore::new(model_path.parent().unwrap().parent().unwrap().to_path_buf());
    let spec = store.projector_spec(&model).expect("the registry model has a projector");
    if !spec.dest.is_file() {
        println!("downloading {} ({} MB)", spec.url, spec.size_bytes >> 20);
        let started = Instant::now();
        let mut shown = 0;
        downloader::Downloader::new(reqwest::Client::new())
            .download("e2e-projector", std::slice::from_ref(&spec), &CancellationToken::new(), |p| {
                let percent = p.downloaded_bytes * 100 / p.total_bytes.max(1);
                if percent >= shown + 10 {
                    shown = percent;
                    println!("  {percent} %");
                }
            })
            .await
            .unwrap_or_else(|e| panic!("projector download failed: {e}"));
        println!("downloaded and verified in {:.0}s", started.elapsed().as_secs_f64());
    }
    let projector = spec.dest.display().to_string();

    let context = 16_384;
    let (mut server, handle, _run_dir) = launch(&model_path, Some(&model), Some(&projector), context).await;
    // What the projector costs: its buffers next to the model's, and the fit.
    let wanted = ["mtmd", "clip", "fit", "multimodal", "buffer size", "projected to use", "vision"];
    for line in server.logs().lines().iter().filter(|l| wanted.iter().any(|w| l.to_lowercase().contains(w))) {
        println!("  log: {}", line.chars().take(200).collect::<String>());
    }

    let screenshot = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../docs/images/screenshot-chat.png");
    let bytes = std::fs::read(&screenshot).unwrap();
    let info = image_info(&bytes).unwrap();
    assert_eq!(info.format, ImageFormat::Png);
    let image = data_url(info.format, &bytes);
    println!("image: {}x{} {}, {} KB", info.width, info.height, info.format.name(), bytes.len() / 1024);

    // --- 1. chat: a question about a pasted screenshot
    let question = "Which file is open in the editor in this screenshot, and what is the open project called? Answer in one sentence.";
    let mut req = ChatRequest::new(vec![ChatMessage::user(question).with_images(vec![image.clone()])]);
    apply_mode(&mut req, Some(&model), Mode::Chat);
    let t0 = Instant::now();
    let r = handle.client.chat(req, &CancellationToken::new(), |_| {}).await.unwrap();
    let answer = r.message.content.clone().unwrap_or_default();
    println!(
        "chat: {answer:?}\n  {:.1}s, {} prompt tokens, {:.0} tok/s prompt, {:.0} tok/s generation",
        t0.elapsed().as_secs_f64(),
        r.usage.map(|u| u.prompt_tokens).unwrap_or_default(),
        r.timings.map(|t| t.prompt_tokens_per_second).unwrap_or_default(),
        r.timings.map(|t| t.generation_tokens_per_second).unwrap_or_default()
    );
    let lower = answer.to_lowercase();
    assert!(lower.contains("cart.ts") && lower.contains("demo-shop"), "the model did not read the screenshot: {answer}");

    // --- 2. an image as a tool result (what image_view returns to an agent)
    let mut asked = ChatMessage::assistant("");
    asked.content = None;
    asked.tool_calls = vec![ToolCall {
        id: "call_0".into(),
        kind: "function".into(),
        function: FunctionCall { name: IMAGE_VIEW.into(), arguments: r#"{"path":"docs/ui.png"}"#.into() },
    }];
    let mut req = ChatRequest::new(vec![
        ChatMessage::system("You are a coding agent working on the project of the user."),
        ChatMessage::user("Look at docs/ui.png and tell me, word for word, the question the user typed into the chat panel."),
        asked,
        ChatMessage::tool_result("call_0", format!("Image docs/ui.png ({}x{} PNG, {} KB):", info.width, info.height, bytes.len() / 1024)).with_images(vec![image.clone()]),
    ]);
    req.tools = vec![tool_spec(IMAGE_VIEW).unwrap().definition()];
    apply_mode(&mut req, Some(&model), Mode::Agent);
    let t0 = Instant::now();
    let r = handle.client.chat(req, &CancellationToken::new(), |_| {}).await.unwrap();
    let answer = r.message.content.clone().unwrap_or_default();
    println!("tool result: {answer:?} in {:.1}s", t0.elapsed().as_secs_f64());
    assert!(answer.to_lowercase().contains("two teas"), "the model did not read the image in the tool result: {answer}");

    // --- 3. an agent run that has to look at a project image with image_view
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(project.path().join("docs")).unwrap();
    std::fs::write(project.path().join("docs/ui.png"), &bytes).unwrap();
    std::fs::write(project.path().join("README.md"), "# demo-shop\n").unwrap();
    let ws = workspace::Workspace::open(project.path()).unwrap();
    let checkpoints = tempfile::tempdir().unwrap();
    let team = agent_team(&handle);
    let ctx = Arc::new(RunContext::new(
        "e2e-vision",
        ws,
        Arc::new(CheckpointStore::new(checkpoints.path())),
        PermissionSettings::default(),
        ShellConfig::default(),
        PromptTemplates::default(),
        Arc::new(AutoApprove("Use your best judgement.".into())),
        Arc::new(|e| print_event(&e)),
    ));
    let t0 = Instant::now();
    let goal = "docs/ui.png is a screenshot of our IDE. Create QUESTION.md containing, word for word, the question the user typed into the chat panel on the right of that screenshot. Change nothing else.";
    let report = agent::run(ctx, &team, goal).await;
    println!("agent run: {:?} in {:.0}s\n{}", report.outcome, t0.elapsed().as_secs_f64(), report.summary);
    // The agents may put it at the root or next to the image.
    let written = ["QUESTION.md", "docs/QUESTION.md"].iter().find_map(|p| std::fs::read_to_string(project.path().join(p)).ok()).unwrap_or_default();
    println!("QUESTION.md:\n{written}");
    server.stop().await;
    assert!(written.to_lowercase().contains("two teas"), "the agents did not read the image");
}

/// Questions before the plan and next steps in the chat, with a real model on
/// a llama-server that already runs (the app's own, for example):
///
/// ```text
/// $env:YLIDE_E2E_URL = "http://127.0.0.1:65044"
/// $env:YLIDE_E2E_KEY_FILE = "<local data>\run\llama-65044.key"
/// $env:YLIDE_E2E_MODEL = "<the model's .gguf>"   # only its file name is used, for the registry defaults
/// cargo test -p ylide-desktop --lib e2e::real_model_asks_back -- --ignored --nocapture
/// ```
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a running llama-server (see the doc comment)"]
async fn real_model_asks_back() {
    use agent::permissions::{ApprovalBroker, ApprovalRequest, ApprovalResponse, UserReply};
    use agent::{Question, QuestionLevel};
    use async_trait::async_trait;
    use std::sync::Mutex;

    let base_url = std::env::var("YLIDE_E2E_URL").expect("set YLIDE_E2E_URL");
    let key = std::env::var_os("YLIDE_E2E_KEY_FILE").map(|p| std::fs::read_to_string(p).unwrap().trim().to_string());
    let model = registry_model(&model_from_env());
    let handle = ChatHandle {
        client: inference::LlmClient::new(inference::Endpoint { base_url, api_key: key, model: None }),
        scheduler: Scheduler::new(1),
        model: model.clone(),
        context: 32_768,
        // The app may use the server too: let it pick a free slot.
        pin_slot: false,
        vision: false,
    };

    /// Answers like a user who clicks the recommended answer (else the first).
    #[derive(Default)]
    struct Clicking {
        asked: Mutex<Vec<Vec<Question>>>,
    }
    #[async_trait]
    impl ApprovalBroker for Clicking {
        async fn request_approval(&self, _request: ApprovalRequest) -> ApprovalResponse {
            ApprovalResponse::Reject { reason: Some("not in this test".into()) }
        }
        async fn ask_user(&self, _agent_id: &str, questions: &[Question], _clarify: bool) -> UserReply {
            self.asked.lock().unwrap().push(questions.to_vec());
            let answers: Vec<String> = questions
                .iter()
                .map(|q| q.options.iter().find(|o| o.recommended).or(q.options.first()).map(|o| o.label.clone()).unwrap_or_else(|| "Entscheide du.".into()))
                .collect();
            UserReply::text(agent::questions::format_reply(questions, &answers))
        }
    }

    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(project.path().join("src")).unwrap();
    std::fs::write(project.path().join("package.json"), "{\n  \"name\": \"demo-shop\",\n  \"scripts\": { \"test\": \"vitest run\" },\n  \"devDependencies\": { \"vitest\": \"^2.0.0\" }\n}\n").unwrap();
    std::fs::write(
        project.path().join("src/cart.ts"),
        "export interface Item {\n  id: string;\n  price: number;\n  quantity: number;\n}\n\nexport function total(items: Item[]): number {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n",
    )
    .unwrap();
    let store = tempfile::tempdir().unwrap();

    // Plans `goal` and stops once the plan stands; returns the questions asked before it.
    let plan_only = |goal: &'static str| {
        let handle = &handle;
        let project = project.path().to_path_buf();
        let store = store.path().to_path_buf();
        async move {
            let broker = Arc::new(Clicking::default());
            let control: Arc<Mutex<Option<agent::RunControl>>> = Arc::default();
            let stop = control.clone();
            let ctx = Arc::new(
                RunContext::new(
                    "e2e-ask",
                    workspace::Workspace::open(&project).unwrap(),
                    Arc::new(CheckpointStore::new(&store)),
                    PermissionSettings::default(),
                    ShellConfig::default(),
                    PromptTemplates::default(),
                    broker.clone(),
                    Arc::new(move |e| {
                        print_event(&e);
                        if matches!(e, AgentEvent::PlanReady { .. })
                            && let Some(c) = stop.lock().unwrap().as_ref()
                        {
                            c.cancel();
                        }
                    }),
                )
                .with_language("de")
                .with_questions(QuestionLevel::IfNeeded),
            );
            *control.lock().unwrap() = Some(ctx.control.clone());
            let t0 = Instant::now();
            println!("--- {goal}");
            agent::run(ctx, &agent_team(handle), goal).await;
            println!("    planned in {:.0}s", t0.elapsed().as_secs_f64());
            let asked = broker.asked.lock().unwrap().clone();
            for q in asked.iter().flatten() {
                println!("    asked: {}", agent::questions::as_text(q).replace('\n', " | "));
            }
            asked
        }
    };

    let clear = plan_only("In src/cart.ts, total() ignores the quantity. Fix it so it multiplies price by quantity.").await;
    let vague = plan_only("Füge Rabatte hinzu.").await;

    // --- the chat: next steps, and a question back on a vague request
    let file = std::fs::read_to_string(project.path().join("src/cart.ts")).unwrap();
    // With the file attached, or (None) without any context.
    let chat = |question: &'static str, attached: Option<&str>| {
        let handle = &handle;
        let model = model.clone();
        let message = match attached {
            Some(file) => format!("File src/cart.ts:\n```ts\n{file}```\n\n{question}"),
            None => question.to_string(),
        };
        async move {
            let system = format!("{}\n\n{}", crate::settings::DEFAULT_CHAT_PROMPT.trim(), crate::chat::interaction_section(QuestionLevel::IfNeeded));
            let mut req = ChatRequest::new(vec![ChatMessage::system(system), ChatMessage::user(message)]);
            apply_mode(&mut req, model.as_ref(), Mode::Chat);
            let t0 = Instant::now();
            let r = handle.client.chat(req, &CancellationToken::new(), |_| {}).await.unwrap();
            let answer = r.message.content.unwrap_or_default();
            println!("--- chat: {question} ({:.1}s)\n{answer}\n", t0.elapsed().as_secs_f64());
            answer
        }
    };
    let explained = chat("Warum stimmt die Summe im Warenkorb nicht?", Some(&file)).await;
    let unclear = chat("Kannst du das schneller machen?", None).await;

    assert!(clear.is_empty(), "a clear request was planned right away: {clear:?}");
    assert!(!vague.is_empty() && vague[0].len() <= 3, "a vague request got questions first");
    assert!(vague[0].iter().any(|q| q.options.len() >= 2), "with answers to click: {vague:?}");
    assert!(explained.contains("```suggestions"), "the chat suggests next steps");
    assert!(unclear.contains('?'), "the chat asks back on a vague request");
}

/// Planning mode with a real model on a running llama-server (same
/// variables as `real_model_asks_back`): a read-only plan, then a change to it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a running llama-server (see real_model_asks_back)"]
async fn real_model_plans_read_only() {
    use agent::permissions::AutoApprove;
    use agent::{PlanRequest, QuestionLevel};

    let base_url = std::env::var("YLIDE_E2E_URL").expect("set YLIDE_E2E_URL");
    let key = std::env::var_os("YLIDE_E2E_KEY_FILE").map(|p| std::fs::read_to_string(p).unwrap().trim().to_string());
    let model = registry_model(&model_from_env());
    let handle = ChatHandle {
        client: inference::LlmClient::new(inference::Endpoint { base_url, api_key: key, model: None }),
        scheduler: Scheduler::new(1),
        model,
        context: 32_768,
        pin_slot: false,
        vision: false,
    };
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(project.path().join("src")).unwrap();
    std::fs::write(project.path().join("package.json"), "{\n  \"name\": \"demo-shop\",\n  \"scripts\": { \"test\": \"vitest run\" },\n  \"devDependencies\": { \"vitest\": \"^2.0.0\" }\n}\n").unwrap();
    let cart = "export interface Item {\n  id: string;\n  price: number;\n  quantity: number;\n}\n\nexport function total(items: Item[]): number {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n";
    std::fs::write(project.path().join("src/cart.ts"), cart).unwrap();
    let store = tempfile::tempdir().unwrap();
    let draft = |req: PlanRequest| {
        let handle = &handle;
        let project = project.path().to_path_buf();
        let store = store.path().to_path_buf();
        async move {
            let ctx = Arc::new(
                RunContext::new(
                    "e2e-plan",
                    workspace::Workspace::open(&project).unwrap(),
                    Arc::new(CheckpointStore::new(&store)),
                    PermissionSettings { mode: agent::ApprovalMode::Autonomous, confirm_commands: false, confirm_deletes: false, ..PermissionSettings::default() },
                    ShellConfig::default(),
                    PromptTemplates::default(),
                    Arc::new(AutoApprove(String::new())),
                    Arc::new(|e| print_event(&e)),
                )
                .with_language("de")
                .with_questions(QuestionLevel::IfNeeded)
                .read_only(),
            );
            let t0 = Instant::now();
            let doc = agent::draft_plan(ctx, &agent_team(handle), &req, None).await;
            println!("    planned in {:.0}s", t0.elapsed().as_secs_f64());
            if let Some(doc) = &doc {
                println!("    approach: {}", doc.approach);
                for s in &doc.steps {
                    println!("    [{}] {} | files: {:?} | verify: {}", s.id, s.title, s.files, s.verify);
                    println!("         {}", s.description.chars().take(240).collect::<String>().replace('\n', " "));
                }
                println!("    risks: {:?}", doc.risks);
                for q in &doc.questions {
                    println!("    question: {}", agent::questions::as_text(q).replace('\n', " | "));
                }
            }
            doc
        }
    };

    println!("--- Füge Rabattcodes für den Warenkorb hinzu.");
    let first = draft(PlanRequest { goal: "Füge Rabattcodes für den Warenkorb hinzu.".into(), ..Default::default() }).await.expect("a plan");
    assert_eq!(std::fs::read_to_string(project.path().join("src/cart.ts")).unwrap(), cart, "planning changes nothing");
    assert!(!first.steps.is_empty() && first.steps.iter().any(|s| !s.verify.is_empty()), "steps with how to verify");

    let wish = "Die Tests sollen mit Vitest laufen und auch einen leeren Warenkorb prüfen.";
    println!("--- {wish}");
    let second = draft(PlanRequest { goal: first.goal.clone(), current: Some(first.clone()), wish: Some(wish.into()), earlier_wishes: vec![] }).await.expect("a changed plan");
    let kept = second.steps.iter().filter(|s| first.steps.iter().any(|f| f.id == s.id)).count();
    println!("    kept {kept} of {} step ids", first.steps.len());
    assert!(kept > 0, "the changed plan keeps step ids");
    let text = |s: &agent::PlanStep| format!("{} {} {}", s.title, s.description, s.verify).to_lowercase();
    assert!(second.steps.iter().any(|s| text(s).contains("leer")), "the wish is in the plan");
    assert_eq!(std::fs::read_to_string(project.path().join("src/cart.ts")).unwrap(), cart);
}
