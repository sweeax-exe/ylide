//! Shared application state, managed by Tauri.

use crate::agents::AgentRuns;
use crate::chats::ChatStore;
use crate::last_run::LastRuns;
use crate::models::ModelStore;
use crate::network::NetworkGate;
use crate::paths::AppPaths;
use crate::runtime::RuntimeManager;
use crate::settings::Settings;
use crate::watcher::ProjectWatcher;
use hardware::HardwareProfile;
use registry::store::{RegistryOrigin, RegistryStore};
use registry::Registry;
use crate::updates::{PendingUpdate, ReadyUpdate, UpdateOutcome};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use workspace::Workspace;

pub struct AppState {
    pub paths: AppPaths,
    pub settings: RwLock<Settings>,
    pub registry: RwLock<Registry>,
    pub registry_origin: RwLock<RegistryOrigin>,
    pub registry_store: RegistryStore,
    pub net: Arc<NetworkGate>,
    pub hardware: RwLock<Option<HardwareProfile>>,
    pub models: Arc<ModelStore>,
    pub runtime: Arc<RuntimeManager>,
    pub workspace: RwLock<Option<Workspace>>,
    pub watcher: Mutex<Option<ProjectWatcher>>,
    /// Held for the whole of a project open, so two opens never interleave.
    pub workspace_opening: tokio::sync::Mutex<()>,
    /// Cancel tokens of running chat / inline-edit requests, by request id.
    pub requests: Mutex<HashMap<String, CancellationToken>>,
    pub agents: AgentRuns,
    /// Saved chats, per project.
    pub chats: ChatStore,
    /// The last agent run of each project, for "Continue" after a restart.
    pub last_runs: LastRuns,
    /// The newer version found by the last update check.
    pub pending_update: Mutex<Option<PendingUpdate>>,
    /// The downloaded and verified installer, waiting for the user's go.
    pub ready_update: Mutex<Option<ReadyUpdate>>,
    /// Set while an update is downloaded.
    pub update_installing: AtomicBool,
    /// Result of this start's update check, reused when the window reloads.
    pub startup_update: tokio::sync::Mutex<Option<UpdateOutcome>>,
}

impl AppState {
    pub fn new(paths: AppPaths) -> Self {
        let mut settings = Settings::load(&paths.config);
        if settings.follow_default_registry()
            && let Err(e) = settings.save(&paths.config)
        {
            tracing::warn!("could not save the new model list address: {e}");
        }
        let registry_store = RegistryStore::new(paths.cache.join("registry"));
        let url = settings.network.registry_url.trim();
        let official = url == crate::settings::DEFAULT_REGISTRY_URL;
        // Until the first refresh, a signed list cached from the previous official
        // address (the same list without the uncensored models) still counts.
        let sources: &[&str] = if official { &[url, crate::settings::LEGACY_REGISTRY_URL] } else { &[url] };
        let (registry, origin) = registry_store.load_best_for_any(sources, official);
        let models = Arc::new(ModelStore::new(settings.models_dir(&paths.default_models)));
        let runtime = Arc::new(RuntimeManager::new(paths.runtimes.clone(), paths.bundled_runtimes.clone(), paths.run.clone()));
        Self {
            settings: RwLock::new(settings),
            registry: RwLock::new(registry),
            registry_origin: RwLock::new(origin),
            registry_store,
            net: Arc::new(NetworkGate::new()),
            hardware: RwLock::new(None),
            models,
            runtime,
            workspace: RwLock::new(None),
            watcher: Mutex::new(None),
            workspace_opening: tokio::sync::Mutex::new(()),
            requests: Mutex::new(HashMap::new()),
            agents: AgentRuns::default(),
            chats: ChatStore::new(paths.data.join("chats")),
            last_runs: LastRuns::new(paths.data.join("agent-runs")),
            pending_update: Mutex::new(None),
            ready_update: Mutex::new(None),
            update_installing: AtomicBool::new(false),
            startup_update: tokio::sync::Mutex::new(None),
            paths,
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }

    pub fn registry(&self) -> Registry {
        self.registry.read().unwrap().clone()
    }

    pub fn workspace(&self) -> crate::error::AppResult<Workspace> {
        self.workspace
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| crate::error::AppError::new("no_project", "open a folder first"))
    }

    /// Hardware profile, probing on first use.
    pub fn hardware(&self) -> HardwareProfile {
        if let Some(hw) = self.hardware.read().unwrap().clone() {
            return hw;
        }
        let hw = hardware::probe(Some(&self.models.dir()));
        *self.hardware.write().unwrap() = Some(hw.clone());
        hw
    }

    pub fn register_request(&self, id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.requests.lock().unwrap().insert(id.to_string(), token.clone());
        token
    }

    pub fn finish_request(&self, id: &str) {
        self.requests.lock().unwrap().remove(id);
    }
}
