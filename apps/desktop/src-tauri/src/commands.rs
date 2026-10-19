//! Tauri commands: the complete interface between the web view and the core.
//! Every command returns `Result<T, AppError>`; the UI translates `code`.

use crate::agents;
use crate::chat::{self, ChatEvent, ChatSendRequest, InlineEditRequest, InlineEvent};
use crate::chats::{ChatSummary, StoredChat};
use crate::error::{AppError, AppResult};
use crate::last_run::LastRun;
use crate::models::{DownloadJob, InstalledModel};
use crate::network::NetworkLogEntry;
use crate::registry_service::{self, RefreshOutcome};
use crate::runtime::{RuntimeStatus, ServerInfo};
use crate::settings::{ModelSelection, Settings};
use crate::skill_service;
use crate::state::AppState;
use crate::updates::{self, UpdateOutcome, UpdateProgress};
use crate::watcher::ProjectWatcher;
use agent::{AgentEvent, ApprovalResponse, Checkpoint};
use hardware::HardwareProfile;
use registry::estimate::{ComputeBudget, Plan};
use registry::store::RegistryOrigin;
use registry::{Recommendation, Registry};
use serde::Serialize;
use skills::github::RepoListing;
use skills::{RecommendedInfo, SkillContent, SkillInfo, SkillUpdate};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;
use workspace::{ContextItem, FileNode, Mention, SearchQuery, SearchResults, Symbol, TextFile};

type Cmd<T> = Result<T, AppError>;

// ---------------------------------------------------------------- app & settings

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfo {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub config_dir: String,
    pub data_dir: String,
    pub models_dir: String,
    /// The log of this run, to attach to bug reports.
    pub log_file: String,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> Cmd<AppInfo> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        config_dir: state.paths.config.display().to_string(),
        data_dir: state.paths.data.display().to_string(),
        models_dir: state.models.dir().display().to_string(),
        log_file: state.paths.logs.join(crate::logging::LOG_FILE).display().to_string(),
    })
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Cmd<Settings> {
    Ok(state.settings())
}

#[tauri::command]
pub fn settings_defaults() -> Cmd<Settings> {
    Ok(Settings::default())
}

#[tauri::command]
pub fn settings_set(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Cmd<Settings> {
    let old = state.settings();
    let old_dir = old.models_dir(&state.paths.default_models);
    let new_dir = settings.models_dir(&state.paths.default_models);
    settings.save(&state.paths.config)?;
    *state.settings.write().unwrap() = settings.clone();
    if old_dir != new_dir {
        state.models.set_dir(new_dir);
    }
    // A new model list address: the list in use must come from there (or be
    // the bundled one), never stay the one fetched from the old address.
    let url = settings.network.registry_url.trim();
    if old.network.registry_url.trim() != url {
        let (registry, origin) = state.registry_store.load_best_for(url, url == crate::settings::DEFAULT_REGISTRY_URL);
        let version = registry.registry_version.clone();
        *state.registry.write().unwrap() = registry;
        *state.registry_origin.write().unwrap() = origin;
        let _ = app.emit("registry://updated", &version);
    }
    Ok(settings)
}

#[tauri::command]
pub fn network_log(state: State<'_, AppState>) -> Cmd<Vec<NetworkLogEntry>> {
    Ok(state.net.entries())
}

// ---------------------------------------------------------------- hardware & registry

#[tauri::command]
pub async fn hardware_probe(state: State<'_, AppState>, force: bool) -> Cmd<HardwareProfile> {
    if !force && let Some(hw) = state.hardware.read().unwrap().clone() {
        return Ok(hw);
    }
    let dir = state.models.dir();
    let hw = tokio::task::spawn_blocking(move || hardware::probe(Some(&dir))).await.map_err(|e| AppError::new("internal", e))?;
    *state.hardware.write().unwrap() = Some(hw.clone());
    Ok(hw)
}

/// Hardware settings outside Ylide that would make models faster.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HardwareTips {
    /// RAM runs below the speed the kit is rated for (EXPO/XMP off).
    pub ram_speed: Option<hardware::RamSpeedTip>,
    pub memory_modules: Vec<hardware::MemoryModule>,
}

#[tauri::command]
pub async fn hardware_tips() -> Cmd<HardwareTips> {
    let memory_modules = tokio::task::spawn_blocking(hardware::memory_modules).await.map_err(|e| AppError::new("internal", e))?;
    Ok(HardwareTips {
        ram_speed: hardware::ram_speed_tip(&memory_modules),
        memory_modules,
    })
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegistryInfo {
    pub registry: Registry,
    pub origin: RegistryOrigin,
}

#[tauri::command]
pub fn registry_info(state: State<'_, AppState>) -> Cmd<RegistryInfo> {
    Ok(RegistryInfo {
        registry: state.registry(),
        origin: *state.registry_origin.read().unwrap(),
    })
}

#[tauri::command]
pub async fn registry_refresh(app: AppHandle) -> Cmd<RefreshOutcome> {
    Ok(registry_service::refresh(&app).await)
}

/// Asks ylide.app whether a newer version exists (see `updates`). The startup
/// check is made once per start; a check by hand always asks.
#[tauri::command]
pub async fn update_check(app: AppHandle, startup: bool) -> Cmd<UpdateOutcome> {
    Ok(if startup { updates::check_at_startup(&app).await } else { updates::check(&app).await })
}

/// Downloads and verifies the update found by the last check.
#[tauri::command]
pub async fn update_download(app: AppHandle, on_progress: Channel<UpdateProgress>) -> Cmd<()> {
    updates::download(&app, on_progress).await
}

/// Hands over to the downloaded installer, which closes and restarts Ylide.
#[tauri::command]
pub async fn update_launch(app: AppHandle) -> Cmd<()> {
    updates::launch(&app).await
}

#[tauri::command]
pub async fn recommend(state: State<'_, AppState>) -> Cmd<Recommendation> {
    let hw = state.hardware();
    let reg = state.registry();
    tokio::task::spawn_blocking(move || registry::recommend(&reg, &hw)).await.map_err(|e| AppError::new("internal", e))
}

// ---------------------------------------------------------------- models

#[tauri::command]
pub fn models_installed(state: State<'_, AppState>) -> Cmd<Vec<InstalledModel>> {
    Ok(state.models.installed())
}

#[tauri::command]
pub fn downloads(state: State<'_, AppState>) -> Cmd<Vec<DownloadJob>> {
    Ok(state.models.jobs())
}

#[tauri::command]
pub fn model_download(app: AppHandle, state: State<'_, AppState>, model_id: String, quant: String) -> Cmd<DownloadJob> {
    let settings = state.settings();
    state.net.check(&settings.network, crate::network::NetPurpose::ModelDownload)?;
    let registry = state.registry();
    state.models.start_download(&app, state.net.clone(), &registry, &model_id, &quant)
}

#[tauri::command]
pub fn model_pause(state: State<'_, AppState>, job_id: String) -> Cmd<()> {
    state.models.pause(&job_id);
    Ok(())
}

#[tauri::command]
pub async fn model_cancel(state: State<'_, AppState>, job_id: String) -> Cmd<()> {
    let registry = state.registry();
    state.models.cancel(&registry, &job_id).await
}

#[tauri::command]
pub async fn model_delete(app: AppHandle, state: State<'_, AppState>, model_id: String, quant: String) -> Cmd<()> {
    if state.runtime.info().is_some_and(|i| i.model_id == model_id && i.quant == quant) {
        state.runtime.stop(&app).await;
    }
    state.models.delete(&model_id, &quant)
}

#[tauri::command]
pub fn model_import(state: State<'_, AppState>, path: String) -> Cmd<InstalledModel> {
    state.models.import_custom(std::path::Path::new(&path), &state.registry())
}

/// Switches image input on for a registry model: downloads its vision
/// projector (checksum verified); every installed variant loads it from the
/// next start on.
#[tauri::command]
pub fn model_projector_download(app: AppHandle, state: State<'_, AppState>, model_id: String) -> Cmd<DownloadJob> {
    let settings = state.settings();
    state.net.check(&settings.network, crate::network::NetPurpose::ModelDownload)?;
    let registry = state.registry();
    state.models.start_projector_download(&app, state.net.clone(), &registry, &model_id)
}

/// Sets the projector of an installed model: a file the user picked (`path`),
/// or none, which switches image input off and deletes a downloaded projector.
#[tauri::command]
pub fn model_projector_set(state: State<'_, AppState>, model_id: String, path: Option<String>) -> Cmd<Vec<InstalledModel>> {
    match path {
        Some(path) => {
            state.models.use_projector_file(&model_id, std::path::Path::new(path.trim()))?;
        }
        None => state.models.disable_projector(&model_id)?,
    }
    Ok(state.models.installed())
}

// ---------------------------------------------------------------- runtime & server

#[tauri::command]
pub fn runtime_status(state: State<'_, AppState>) -> Cmd<RuntimeStatus> {
    let hw = state.hardware.read().unwrap().clone();
    Ok(state.runtime.status(hw.as_ref(), &state.registry(), &state.settings()))
}

#[tauri::command]
pub fn runtime_install(app: AppHandle, state: State<'_, AppState>, variant: String) -> Cmd<()> {
    let settings = state.settings();
    state.net.check(&settings.network, crate::network::NetPurpose::RuntimeDownload)?;
    state.runtime.start_install(&app, state.net.clone(), &state.registry(), &variant)
}

/// An image file the user picked for the chat or an agent request, as a data
/// URL. The web view has no file access of its own; it scales the image down.
#[tauri::command]
pub async fn image_load(path: String) -> Cmd<String> {
    use inference::image::{MAX_IMAGE_BYTES, data_url, image_info};
    blocking(move || {
        let path = std::path::PathBuf::from(path.trim());
        let size = std::fs::metadata(&path).map_err(|_| AppError::new("not_found", path.display()))?.len();
        if size > MAX_IMAGE_BYTES as u64 {
            return Err(AppError::new("bad_image", format!("{}: larger than {} MB", path.display(), MAX_IMAGE_BYTES >> 20)));
        }
        let bytes = std::fs::read(&path)?;
        let info = image_info(&bytes).map_err(|e| AppError::new("bad_image", format!("{}: {e}", path.display())))?;
        Ok(data_url(info.format, &bytes))
    })
    .await
}

/// Memory plan for a registry model on this machine (largest context that
/// fits), with its vision projector when image input is on. The KV cache is
/// F16, or q8_0 where only that keeps the model on the GPU, and always q8_0
/// when the user asked for it (`estimate::plan_at`).
pub(crate) fn plan_for(state: &AppState, model_id: &str, quant: &str) -> Option<Plan> {
    let reg = state.registry();
    let model = reg.models.iter().find(|m| m.id == model_id)?;
    let variant = model.variants.iter().find(|v| v.quant == quant)?;
    let projector = state.models.find(model_id, quant).and_then(|m| m.projector).map_or(0, |p| p.size_bytes);
    let hw = state.hardware();
    let budget = ComputeBudget::from_profile(&hw, &reg.gpu_hints);
    let settings = state.settings();
    let mut contexts = vec![settings.models.context.unwrap_or(model.context.recommended), 65_536, 32_768, 16_384, 8_192];
    contexts.retain(|c| *c <= model.context.max);
    contexts.dedup();
    contexts
        .into_iter()
        .find_map(|context| registry::estimate::plan_at(model, variant, projector, context, &budget, settings.models.quantize_kv))
}

#[tauri::command]
pub async fn server_start(app: AppHandle, state: State<'_, AppState>, selection: Option<ModelSelection>) -> Cmd<ServerInfo> {
    if state.runtime.is_calibrating() {
        return Err(AppError::new("calibrating", "the model is being calibrated for this PC"));
    }
    let settings = state.settings();
    if settings.endpoint.enabled {
        return state.runtime.use_external(&app, &settings).await;
    }
    let selection = selection
        .or(settings.models.chat.clone())
        .ok_or_else(|| AppError::new("no_model_selected", "choose a model first"))?;
    let installed = state
        .models
        .find(&selection.model_id, &selection.quant)
        .ok_or_else(|| AppError::new("model_not_installed", format!("{} {}", selection.model_id, selection.quant)))?;
    let plan = plan_for(&state, &selection.model_id, &selection.quant);
    let hw = state.hardware();
    let reg = state.registry();
    let launch = crate::calibrate::start_tuning(&state, &installed, plan.as_ref());
    state.runtime.start(&app, &hw, &reg, &settings, &installed, plan, launch).await
}

#[tauri::command]
pub async fn server_stop(app: AppHandle, state: State<'_, AppState>) -> Cmd<()> {
    state.runtime.stop(&app).await;
    Ok(())
}

#[tauri::command]
pub fn server_info(state: State<'_, AppState>) -> Cmd<Option<ServerInfo>> {
    Ok(state.runtime.info())
}

#[tauri::command]
pub async fn server_logs(state: State<'_, AppState>) -> Cmd<Vec<String>> {
    Ok(state.runtime.logs().await)
}

// ---------------------------------------------------------------- workspace & files

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: String,
}

#[tauri::command]
pub async fn workspace_open(app: AppHandle, state: State<'_, AppState>, path: String) -> Cmd<WorkspaceInfo> {
    // The watcher walks the whole tree, which can take seconds. Opens run one
    // after another, so a slower earlier open never overwrites a later one.
    let _opening = state.workspace_opening.lock().await;
    // Opening the folder that is already open (a "reopen" click while the
    // startup reopen ran, a web view reload) keeps the running watcher.
    if let Some(info) = already_open(&state, &path) {
        return Ok(info);
    }
    let (ws, watcher) = blocking(move || {
        let ws = workspace::Workspace::open(&path)?;
        let watcher = ProjectWatcher::start(app, ws.root().to_path_buf()).map_err(|e| AppError::new("watcher", e))?;
        Ok((ws, watcher))
    })
    .await?;
    let info = WorkspaceInfo {
        root: ws.root().display().to_string(),
        name: ws.name(),
    };
    *state.watcher.lock().unwrap() = Some(watcher);
    *state.workspace.write().unwrap() = Some(ws);
    let settings = {
        let mut settings = state.settings.write().unwrap();
        settings.last_project = Some(info.root.clone());
        settings.clone()
    };
    // The project is open either way; the next settings save records it.
    if let Err(e) = settings.save(&state.paths.config) {
        tracing::warn!("could not record {} as the last project: {}", info.root, e.message);
    }
    Ok(info)
}

/// The open workspace, if `path` names the same folder.
fn already_open(state: &AppState, path: &str) -> Option<WorkspaceInfo> {
    let guard = state.workspace.read().unwrap();
    let ws = guard.as_ref()?;
    let same = match (std::fs::canonicalize(path), std::fs::canonicalize(ws.root())) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    same.then(|| WorkspaceInfo {
        root: ws.root().display().to_string(),
        name: ws.name(),
    })
}

#[tauri::command]
pub fn workspace_current(state: State<'_, AppState>) -> Cmd<Option<WorkspaceInfo>> {
    Ok(state.workspace.read().unwrap().as_ref().map(|ws| WorkspaceInfo {
        root: ws.root().display().to_string(),
        name: ws.name(),
    }))
}

#[tauri::command]
pub async fn workspace_close(state: State<'_, AppState>) -> Cmd<()> {
    // Waits for an open in flight, which would otherwise reopen the project.
    let _opening = state.workspace_opening.lock().await;
    *state.watcher.lock().unwrap() = None;
    *state.workspace.write().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn fs_list_dir(state: State<'_, AppState>, path: String) -> Cmd<Vec<FileNode>> {
    let ws = state.workspace()?;
    blocking(move || Ok(ws.list_dir(&path)?)).await
}

#[tauri::command]
pub async fn fs_read_file(state: State<'_, AppState>, path: String) -> Cmd<TextFile> {
    let ws = state.workspace()?;
    blocking(move || Ok(ws.read_text(&path)?)).await
}

#[tauri::command]
pub async fn fs_write_file(state: State<'_, AppState>, path: String, content: String) -> Cmd<()> {
    let ws = state.workspace()?;
    blocking(move || Ok(ws.write_text(&path, &content)?)).await
}

#[tauri::command]
pub async fn fs_create(state: State<'_, AppState>, path: String, directory: bool) -> Cmd<()> {
    let ws = state.workspace()?;
    blocking(move || {
        if ws.exists(&path) {
            return Err(AppError::new("exists", &path));
        }
        if directory { ws.create_dir(&path)? } else { ws.write_text(&path, "")? }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn fs_rename(state: State<'_, AppState>, from: String, to: String) -> Cmd<()> {
    let ws = state.workspace()?;
    blocking(move || Ok(ws.rename(&from, &to)?)).await
}

#[tauri::command]
pub async fn fs_delete(state: State<'_, AppState>, path: String) -> Cmd<()> {
    let ws = state.workspace()?;
    blocking(move || Ok(ws.delete(&path)?)).await
}

#[tauri::command]
pub async fn fs_search(state: State<'_, AppState>, query: SearchQuery) -> Cmd<SearchResults> {
    let ws = state.workspace()?;
    blocking(move || Ok(ws.search(&query)?)).await
}

#[tauri::command]
pub async fn fs_find_files(state: State<'_, AppState>, query: String, limit: u32) -> Cmd<Vec<String>> {
    let ws = state.workspace()?;
    blocking(move || Ok(ws.find_files(&query, limit as usize))).await
}

/// The given paths that name existing project files (cheap; no directory walk).
#[tauri::command]
pub async fn fs_exists(state: State<'_, AppState>, paths: Vec<String>) -> Cmd<Vec<String>> {
    let ws = state.workspace()?;
    blocking(move || Ok(ws.existing_files(&paths))).await
}

#[tauri::command]
pub async fn fs_find_symbols(state: State<'_, AppState>, query: String, limit: u32) -> Cmd<Vec<Symbol>> {
    let ws = state.workspace()?;
    blocking(move || Ok(ws.find_symbols(&query, limit as usize, 20_000)?)).await
}

#[tauri::command]
pub async fn context_preview(state: State<'_, AppState>, mentions: Vec<Mention>) -> Cmd<Vec<ContextItem>> {
    let ws = state.workspace()?;
    let model_context = state.runtime.chat_handle().await.map(|h| h.context);
    let budget = crate::chat::context_budget(state.settings().chat.context_budget_tokens, model_context);
    blocking(move || Ok(workspace::resolve_mentions(&ws, &mentions, budget))).await
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| AppError::new("internal", e))?
}

// ---------------------------------------------------------------- chat & inline edit

#[tauri::command]
pub async fn chat_send(state: State<'_, AppState>, request: ChatSendRequest, on_event: Channel<ChatEvent>) -> Cmd<()> {
    chat::send(&state, request, on_event).await
}

// ---------------------------------------------------------------- saved chats

// Each command names the project (its root as WorkspaceInfo.root has it, or
// none) instead of using the one open right now: an answer that ends while
// another project opens still belongs to the project it was asked in. The
// root only selects a hashed folder under the chats folder.

/// Saved chats of a project, newest first (none while saving is off).
#[tauri::command]
pub fn chats_list(state: State<'_, AppState>, project: Option<String>) -> Cmd<Vec<ChatSummary>> {
    if !state.settings().chat.save_history {
        return Ok(vec![]);
    }
    Ok(state.chats.list(project.as_deref().map(std::path::Path::new)))
}

#[tauri::command]
pub fn chat_load(state: State<'_, AppState>, project: Option<String>, id: String) -> Cmd<StoredChat> {
    state.chats.load(project.as_deref().map(std::path::Path::new), &id)
}

/// Saves a chat of a project; does nothing while saving is off.
#[tauri::command]
pub fn chat_save(state: State<'_, AppState>, project: Option<String>, chat: StoredChat) -> Cmd<Option<ChatSummary>> {
    if !state.settings().chat.save_history {
        return Ok(None);
    }
    state.chats.save(project.as_deref().map(std::path::Path::new), &chat).map(Some)
}

#[tauri::command]
pub fn chat_delete(state: State<'_, AppState>, project: Option<String>, id: String) -> Cmd<()> {
    state.chats.delete(project.as_deref().map(std::path::Path::new), &id)
}

/// Deletes the saved chats of every project.
#[tauri::command]
pub fn chats_delete_all(state: State<'_, AppState>) -> Cmd<()> {
    state.chats.delete_all()
}

#[tauri::command]
pub fn request_cancel(state: State<'_, AppState>, id: String) -> Cmd<()> {
    if let Some(token) = state.requests.lock().unwrap().get(&id) {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn inline_edit(state: State<'_, AppState>, request: InlineEditRequest, on_event: Channel<InlineEvent>) -> Cmd<()> {
    chat::inline(&state, request, on_event).await
}

// ---------------------------------------------------------------- agents

#[tauri::command]
pub async fn agent_start(
    state: State<'_, AppState>,
    goal: String,
    images: Option<Vec<String>>,
    previous_run: Option<String>,
    language: Option<String>,
    on_event: Channel<AgentEvent>,
) -> Cmd<String> {
    let language = language.unwrap_or_else(|| "en".into());
    agents::start(&state, goal, images.unwrap_or_default(), previous_run, language, on_event).await
}

/// The open project's last agent run, kept across restarts; none without a project.
#[tauri::command]
pub fn agent_last_run(state: State<'_, AppState>) -> Cmd<Option<LastRun>> {
    Ok(state.workspace().ok().and_then(|ws| state.last_runs.load(ws.root())))
}

#[tauri::command]
pub fn agent_approve(state: State<'_, AppState>, run_id: String, request_id: String, response: ApprovalResponse) -> Cmd<bool> {
    Ok(state.agents.get(&run_id)?.broker.resolve_approval(&request_id, response))
}

/// Answers a question card: `answers` has one answer per question (empty:
/// left open); without it, `answer` answers the only question.
#[tauri::command]
pub fn agent_answer(
    state: State<'_, AppState>,
    run_id: String,
    question_id: String,
    answer: String,
    answers: Option<Vec<String>>,
    images: Option<Vec<String>>,
) -> Cmd<bool> {
    let run = state.agents.get(&run_id)?;
    let images = images.unwrap_or_default();
    crate::chat::check_images(&images, run.vision)?;
    let answers = answers.unwrap_or_else(|| vec![answer]);
    Ok(run.broker.resolve_question(&question_id, &answers, images))
}

#[tauri::command]
pub fn agent_control(state: State<'_, AppState>, run_id: String, action: String) -> Cmd<()> {
    let run = state.agents.get(&run_id)?;
    match action.as_str() {
        "pause" => run.ctx.control.pause(),
        "resume" => run.ctx.control.resume(),
        "cancel" => run.ctx.control.cancel(),
        other => return Err(AppError::new("invalid", other)),
    }
    Ok(())
}

#[tauri::command]
pub fn agent_intervene(state: State<'_, AppState>, run_id: String, agent_id: String, text: String, images: Option<Vec<String>>) -> Cmd<()> {
    let run = state.agents.get(&run_id)?;
    let images = images.unwrap_or_default();
    crate::chat::check_images(&images, run.vision)?;
    run.ctx.control.intervene_with(&agent_id, agent::UserReply { text, images });
    Ok(())
}

// ---------------------------------------------------------------- skills

// Installed skills work with every model; the open project's own skills
// (.agents/skills) are listed too and switched per project.

#[tauri::command]
pub async fn skills_list(state: State<'_, AppState>) -> Cmd<Vec<SkillInfo>> {
    let (store, ws) = (state.skills.clone(), state.workspace.read().unwrap().clone());
    blocking(move || Ok(skill_service::list(&store, ws.as_ref()))).await
}

/// Switches a skill on or off (`id` from `SkillInfo`); returns the new list.
#[tauri::command]
pub async fn skills_set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> Cmd<Vec<SkillInfo>> {
    let (store, ws) = (state.skills.clone(), state.workspace.read().unwrap().clone());
    blocking(move || {
        skill_service::set_enabled(&store, ws.as_ref(), &id, enabled)?;
        Ok(skill_service::list(&store, ws.as_ref()))
    })
    .await
}

#[tauri::command]
pub async fn skills_remove(state: State<'_, AppState>, name: String) -> Cmd<Vec<SkillInfo>> {
    let (store, ws) = (state.skills.clone(), state.workspace.read().unwrap().clone());
    blocking(move || {
        store.remove(&name)?;
        Ok(skill_service::list(&store, ws.as_ref()))
    })
    .await
}

/// SKILL.md in full and the skill's files.
#[tauri::command]
pub async fn skills_content(state: State<'_, AppState>, id: String) -> Cmd<SkillContent> {
    let (store, ws) = (state.skills.clone(), state.workspace.read().unwrap().clone());
    blocking(move || skill_service::content(&store, ws.as_ref(), &id)).await
}

/// The recommended skills bundled with Ylide (REA is the first), each marked
/// whether it is installed already.
#[tauri::command]
pub async fn skills_recommended(state: State<'_, AppState>) -> Cmd<Vec<RecommendedInfo>> {
    let store = state.skills.clone();
    blocking(move || Ok(skill_service::recommended(&store))).await
}

/// SKILL.md and files of a recommended skill, from the bundle (no network).
#[tauri::command]
pub async fn skills_recommended_content(state: State<'_, AppState>, name: String) -> Cmd<SkillContent> {
    let store = state.skills.clone();
    blocking(move || skill_service::recommended_content(&store, &name)).await
}

/// Adds a recommended skill from the bundle and switches it on (the user saw
/// its content first); returns the new installed list.
#[tauri::command]
pub async fn skills_install_recommended(state: State<'_, AppState>, name: String) -> Cmd<Vec<SkillInfo>> {
    let (store, ws) = (state.skills.clone(), state.workspace.read().unwrap().clone());
    blocking(move || {
        skill_service::install_recommended(&store, &name)?;
        Ok(skill_service::list(&store, ws.as_ref()))
    })
    .await
}

/// Lists the skills in a GitHub repository (needs the skill-download permission).
#[tauri::command]
pub async fn skills_browse(state: State<'_, AppState>, address: String) -> Cmd<RepoListing> {
    skill_service::browse(&state, &address).await
}

/// Installs the chosen folders of the repository listed by `skills_browse`, switched off.
#[tauri::command]
pub async fn skills_install_github(state: State<'_, AppState>, repo: String, git_ref: Option<String>, commit: String, paths: Vec<String>) -> Cmd<Vec<SkillInfo>> {
    skill_service::install_github(&state, &repo, git_ref, &commit, &paths).await
}

/// Installs the skills of a folder on this computer (copied), switched off.
#[tauri::command]
pub async fn skills_install_folder(state: State<'_, AppState>, path: String) -> Cmd<Vec<SkillInfo>> {
    let store = state.skills.clone();
    blocking(move || skill_service::install_folder(&store, std::path::Path::new(path.trim()))).await
}

/// What a newer version of an installed skill would change.
#[tauri::command]
pub async fn skills_check_update(state: State<'_, AppState>, name: String) -> Cmd<SkillUpdate> {
    skill_service::check_update(&state, &name).await
}

/// Installs the version `skills_check_update` showed.
#[tauri::command]
pub async fn skills_update(state: State<'_, AppState>, name: String, commit: String) -> Cmd<SkillInfo> {
    skill_service::update(&state, &name, &commit).await
}

#[tauri::command]
pub fn checkpoints_list(state: State<'_, AppState>, run_id: String) -> Cmd<Vec<Checkpoint>> {
    Ok(agents::checkpoint_store(&state)?.list(&run_id))
}

#[tauri::command]
pub async fn checkpoint_restore(state: State<'_, AppState>, run_id: String, checkpoint_id: String) -> Cmd<Vec<String>> {
    let store = agents::checkpoint_store(&state)?;
    let ws = state.workspace()?;
    blocking(move || Ok(store.restore(&run_id, &checkpoint_id, &ws)?)).await
}
