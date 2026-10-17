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
        device,
        extra: &[],
        runtime_backend: backend_of(&runtime.file_name().unwrap_or_default().to_string_lossy()),
        projector,
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
