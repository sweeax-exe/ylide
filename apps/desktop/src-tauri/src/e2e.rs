//! End-to-end test against a real llama-server and a real model. It is ignored
//! by default because it needs a downloaded runtime and model:
//!
//! ```text
//! node scripts/fetch-runtime.mjs
//! $env:YLIDE_E2E_MODEL = "C:\...\Qwen3.5-4B-Q4_K_M.gguf"
//! cargo test -p ylide-desktop --lib e2e -- --ignored --nocapture
//! ```
//!
//! `YLIDE_E2E_RUNTIME` selects another runtime folder (default: bundled Vulkan).

use crate::agents::AgentModel;
use crate::chat::{Mode, apply_mode};
use crate::runtime::{ChatHandle, LaunchOptions, SERVER_BINARY, ToolCallSupport, chat_args, parse_help_flags, tool_self_test};
use agent::llm::ChatModel;
use agent::permissions::{AutoApprove, PermissionSettings};
use agent::{AgentEvent, CheckpointStore, PromptTemplates, RunContext, ScheduledModel, ShellConfig, Team};
use hardware::Backend;
use inference::{ChatMessage, ChatRequest, LlamaServer, Priority, Scheduler, ServerConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

fn runtime_dir() -> PathBuf {
    std::env::var_os("YLIDE_E2E_RUNTIME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("runtime").join("vulkan"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a downloaded runtime and model (see module docs)"]
async fn real_model_end_to_end() {
    let Some(model_path) = std::env::var_os("YLIDE_E2E_MODEL").map(PathBuf::from) else {
        panic!("set YLIDE_E2E_MODEL to a GGUF file");
    };
    let binary = runtime_dir().join(SERVER_BINARY);
    assert!(binary.exists(), "runtime missing: {}", binary.display());
    let registry = registry::bundled();
    let file_name = model_path.file_name().unwrap().to_string_lossy().to_string();
    let model = registry.models.iter().find(|m| m.variants.iter().any(|v| v.files.iter().any(|f| f.path == file_name))).cloned();
    println!("model: {} ({:?})", file_name, model.as_ref().map(|m| &m.id));

    // --- 1. start llama-server with exactly the flags the app would use
    let help = tokio::process::Command::new(&binary).arg("--help").output().await.unwrap();
    let flags = parse_help_flags(&String::from_utf8_lossy(&help.stdout));
    let devices = inference::list_devices(&binary).await.unwrap();
    println!("devices: {devices:?}");
    let hw = hardware::probe(None);
    let gpu_name = hw.primary_gpu().map(|g| g.name.to_lowercase()).unwrap_or_default();
    let device = devices.iter().find(|d| d.description.to_lowercase().contains(&gpu_name)).or(devices.first()).map(|d| d.id.clone());
    let context = 16_384;
    let options = LaunchOptions {
        model_path: &model_path.display().to_string(),
        model: model.as_ref(),
        context,
        slots: 2,
        plan: None,
        threads: hw.cpu.physical_cores,
        ram_total: hw.memory.total_bytes,
        device,
        extra: &[],
        runtime_backend: Backend::Vulkan,
    };
    let args = chat_args(&options, &flags);
    println!("args: {}", args.join(" "));
    let run_dir = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let mut server = LlamaServer::start(
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
        model: model.clone(),
        context,
        pin_slot: true,
    };

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
    let agent_model = |label: &str| -> Arc<dyn ChatModel> {
        Arc::new(AgentModel {
            inner: ScheduledModel {
                client: handle.client.clone(),
                scheduler: handle.scheduler.clone(),
                priority: Priority::Agent,
                preferred_slot: Some(0),
                label: label.into(),
                context_tokens: context,
                pin_slot: true,
            },
            model: model.clone(),
        })
    };
    let roles = agent::default_roles();
    let mut models = HashMap::new();
    for r in &roles {
        models.insert(r.id.clone(), agent_model(&r.name));
    }
    let team = Team {
        roles,
        models,
        default_model: agent_model("agent"),
        max_review_rounds: 1,
        review_enabled: true,
    };
    let ctx = Arc::new(RunContext::new(
        "e2e-run",
        ws,
        Arc::new(CheckpointStore::new(store.path())),
        PermissionSettings::default(),
        ShellConfig::default(),
        PromptTemplates::default(),
        Arc::new(AutoApprove("Use your best judgement.".into())),
        Arc::new(|e| match &e {
            AgentEvent::ToolCall { agent_id, tool, arguments, .. } => println!("  [{agent_id}] {tool} {}", arguments.chars().take(160).collect::<String>()),
            AgentEvent::ToolResult { agent_id, ok, summary, .. } => println!("  [{agent_id}] -> {} {summary}", if *ok { "ok" } else { "error" }),
            AgentEvent::PlanReady { plan, .. } => println!("  plan: {} task(s): {}", plan.tasks.len(), plan.tasks.iter().map(|t| t.title.as_str()).collect::<Vec<_>>().join(" | ")),
            AgentEvent::TaskUpdated { task, .. } => println!("  task {} -> {:?}", task.id, task.status),
            AgentEvent::Message { message, .. } => println!("  message {} -> {}: {}", message.from, message.to, message.content.chars().take(160).collect::<String>()),
            _ => {}
        }),
    ));
    let t0 = Instant::now();
    let report = agent::run(ctx, &team, "In src/cart.ts, total() ignores the quantity. Fix it so it multiplies price by quantity.").await;
    println!("agent run: {:?} in {:.0}s\n{}", report.outcome, t0.elapsed().as_secs_f64(), report.summary);
    let fixed = std::fs::read_to_string(project.path().join("src/cart.ts")).unwrap();
    println!("src/cart.ts after the run:\n{fixed}");
    server.stop().await;
    assert!(fixed.contains("quantity") && fixed.contains("*"), "the agent did not fix the bug");
}
