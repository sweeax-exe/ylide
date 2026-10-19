//! User settings: one JSON file, every option visible and editable in the UI.
//! Unknown or missing fields fall back to defaults, so old files keep working.

use crate::error::AppResult;
use agent::{PermissionSettings, PromptTemplates, QuestionLevel, RoleDefinition, ShellConfig};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// Where the app fetches newer registry versions: the signed list on the
/// project's own domain (schema 2). Users can change or clear it.
pub const DEFAULT_REGISTRY_URL: &str = "https://ylide.app/registry/v2/models.json";

/// The official list before schema 2. It still serves a schema 1 list, without
/// the uncensored models, for Ylide 0.1.3 and older (scripts/publish-registry.mjs).
pub const LEGACY_REGISTRY_URL: &str = "https://ylide.app/registry/models.json";

/// Earlier defaults. A settings file that still holds one of them was never
/// changed by the user, so it follows the current default.
const PREVIOUS_REGISTRY_URLS: &[&str] = &[
    LEGACY_REGISTRY_URL,
    "https://raw.githubusercontent.com/sweeax-exe/ylide/main/registry/models.json",
    "https://raw.githubusercontent.com/sweeax-exe/anyon/main/registry/models.json",
];

pub const DEFAULT_CHAT_PROMPT: &str = include_str!("../prompts/chat.md");
pub const DEFAULT_INLINE_PROMPT: &str = include_str!("../prompts/inline.md");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ThemeChoice {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct NetworkSettings {
    /// Fetch newer model registry versions at startup.
    pub allow_registry_updates: bool,
    /// Allow downloading models from Hugging Face.
    pub allow_model_downloads: bool,
    /// Allow downloading inference runtimes (e.g. the CUDA pack) from GitHub.
    pub allow_runtime_downloads: bool,
    /// Ask ylide.app for a newer version at startup (and when the user checks).
    pub allow_update_checks: bool,
    /// Let the Skills page list and download skills from GitHub. Off until the
    /// user switches it on (the Skills page asks on first use).
    pub allow_skill_downloads: bool,
    pub registry_url: String,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            allow_registry_updates: true,
            allow_model_downloads: true,
            allow_runtime_downloads: true,
            allow_update_checks: true,
            allow_skill_downloads: false,
            registry_url: DEFAULT_REGISTRY_URL.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModelSelection {
    pub model_id: String,
    pub quant: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ModelSettings {
    /// Download folder; `None` = app data folder.
    pub dir: Option<String>,
    /// Main model for chat, inline edit and agents.
    pub chat: Option<ModelSelection>,
    pub autocomplete: Option<ModelSelection>,
    pub embedding: Option<ModelSelection>,
    /// Context window override (tokens); `None` = recommended value.
    pub context: Option<u32>,
    /// Runtime variant override ("cuda-13.4", "vulkan", "cpu"); `None` = automatic.
    pub runtime_variant: Option<String>,
    /// Parallel requests on the main model (agent + interactive).
    pub slots: u32,
    /// Extra llama-server arguments appended last (advanced).
    pub extra_args: Vec<String>,
    /// Start the main model automatically when the app opens.
    pub autostart: bool,
    /// Always use a q8_0 KV cache (`-ctk/-ctv q8_0`): half the memory for the
    /// context, so more of the model fits on the GPU; very slightly lossy.
    /// Off: q8_0 only where an F16 cache does not fit.
    pub quantize_kv: bool,
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            dir: None,
            chat: None,
            autocomplete: None,
            embedding: None,
            context: None,
            runtime_variant: None,
            slots: 2,
            extra_args: vec![],
            autostart: true,
            quantize_kv: false,
        }
    }
}

/// An external OpenAI-compatible server (Ollama, LM Studio, another llama-server).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct CustomEndpoint {
    pub enabled: bool,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub context: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AgentSettings {
    pub permissions: PermissionSettings,
    pub roles: Vec<RoleDefinition>,
    pub templates: PromptTemplates,
    pub review_enabled: bool,
    pub max_review_rounds: u32,
    pub shell: ShellConfig,
    /// After a run, the orchestrator writes what it learned into Ylide's
    /// section of the project's AGENTS.md. The file is read either way.
    pub update_project_notes: bool,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            permissions: PermissionSettings::default(),
            roles: agent::default_roles(),
            templates: PromptTemplates::default(),
            review_enabled: true,
            max_review_rounds: 2,
            shell: ShellConfig::default(),
            update_project_notes: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ChatSettings {
    pub system_prompt: String,
    pub inline_prompt: String,
    /// Upper bound for attached context (@file, @folder, ...), in tokens.
    pub context_budget_tokens: u32,
    /// Keep chats per project on this computer, to reopen them later.
    pub save_history: bool,
}

impl Default for ChatSettings {
    fn default() -> Self {
        Self {
            system_prompt: DEFAULT_CHAT_PROMPT.trim().into(),
            inline_prompt: DEFAULT_INLINE_PROMPT.trim().into(),
            context_budget_tokens: 24_000,
            save_history: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct EditorSettings {
    pub font_size: u32,
    pub font_family: String,
    pub tab_size: u32,
    pub word_wrap: bool,
    pub minimap: bool,
    pub line_height: f64,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_size: 13,
            font_family: "\"JetBrains Mono Variable\", \"JetBrains Mono\", Consolas, monospace".into(),
            tab_size: 4,
            word_wrap: false,
            minimap: false,
            line_height: 1.55,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Settings {
    pub version: u32,
    /// UI language ("de", "en"); `None` follows the system.
    pub language: Option<String>,
    pub theme: ThemeChoice,
    pub onboarding_done: bool,
    pub last_project: Option<String>,
    pub network: NetworkSettings,
    pub models: ModelSettings,
    pub endpoint: CustomEndpoint,
    pub agent: AgentSettings,
    pub chat: ChatSettings,
    pub editor: EditorSettings,
    /// How readily the agents (before they plan) and the chat ask back.
    pub questions: QuestionLevel,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            language: None,
            theme: ThemeChoice::Dark,
            onboarding_done: false,
            last_project: None,
            network: NetworkSettings::default(),
            models: ModelSettings::default(),
            endpoint: CustomEndpoint::default(),
            agent: AgentSettings::default(),
            chat: ChatSettings::default(),
            editor: EditorSettings::default(),
            questions: QuestionLevel::IfNeeded,
        }
    }
}

impl Settings {
    pub fn file(config_dir: &Path) -> PathBuf {
        config_dir.join("settings.json")
    }

    /// Loads settings; a missing or unreadable file yields defaults (a broken
    /// file is kept as `settings.json.broken` for the user to inspect).
    pub fn load(config_dir: &Path) -> Self {
        let path = Self::file(config_dir);
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Settings>(&text) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("settings.json is invalid ({e}); using defaults");
                    let _ = std::fs::rename(&path, path.with_extension("json.broken"));
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, config_dir: &Path) -> AppResult<()> {
        std::fs::create_dir_all(config_dir)?;
        let path = Self::file(config_dir);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// Replaces an earlier default registry address with the current one.
    /// Returns whether anything changed.
    pub fn follow_default_registry(&mut self) -> bool {
        let url = self.network.registry_url.trim();
        if PREVIOUS_REGISTRY_URLS.contains(&url) {
            self.network.registry_url = DEFAULT_REGISTRY_URL.into();
            return true;
        }
        false
    }

    pub fn models_dir(&self, default: &Path) -> PathBuf {
        self.models.dir.as_ref().map(PathBuf::from).unwrap_or_else(|| default.to_path_buf())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_follow_the_safety_brief() {
        let s = Settings::default();
        assert!(s.agent.permissions.confirm_commands, "commands need confirmation by default");
        assert!(s.agent.permissions.confirm_deletes, "deletions need confirmation by default");
        assert_eq!(s.agent.roles.len(), 3);
        assert!(!s.chat.system_prompt.is_empty());
        assert!(s.network.registry_url.starts_with("https://"));
    }

    #[test]
    fn earlier_default_registry_addresses_follow_the_new_one() {
        let mut s = Settings::default();
        for old in PREVIOUS_REGISTRY_URLS {
            s.network.registry_url = (*old).into();
            assert!(s.follow_default_registry());
            assert_eq!(s.network.registry_url, DEFAULT_REGISTRY_URL);
        }
        // An address the user chose stays.
        s.network.registry_url = "https://example.org/models.json".into();
        assert!(!s.follow_default_registry());
        assert_eq!(s.network.registry_url, "https://example.org/models.json");
        assert!(DEFAULT_REGISTRY_URL.starts_with("https://ylide.app/"));
        assert!(!PREVIOUS_REGISTRY_URLS.contains(&DEFAULT_REGISTRY_URL));
    }

    #[test]
    fn partial_files_fill_in_defaults() {
        let s: Settings = serde_json::from_str(r#"{"language":"de","models":{"slots":3}}"#).unwrap();
        assert_eq!(s.language.as_deref(), Some("de"));
        assert_eq!(s.models.slots, 3);
        assert!(s.models.autostart);
        assert!(!s.models.quantize_kv, "the lossy KV cache stays opt-in");
        assert_eq!(s.editor.tab_size, 4);
        // Files written before update checks existed keep them on.
        let s: Settings = serde_json::from_str(r#"{"network":{"allowModelDownloads":false}}"#).unwrap();
        assert!(!s.network.allow_model_downloads);
        assert!(s.network.allow_update_checks);
        assert!(!s.network.allow_skill_downloads, "skill downloads wait for the user's go");
        // Files written before questions could be set ask when needed.
        assert_eq!(s.questions, QuestionLevel::IfNeeded);
        let s: Settings = serde_json::from_str(r#"{"questions":"never"}"#).unwrap();
        assert_eq!(s.questions, QuestionLevel::Never);
    }

    #[test]
    fn save_and_load_roundtrip_and_broken_file_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings {
            language: Some("en".into()),
            ..Settings::default()
        };
        s.save(dir.path()).unwrap();
        assert_eq!(Settings::load(dir.path()), s);
        std::fs::write(Settings::file(dir.path()), "{ broken").unwrap();
        assert_eq!(Settings::load(dir.path()), Settings::default());
        assert!(dir.path().join("settings.json.broken").exists());
    }
}
