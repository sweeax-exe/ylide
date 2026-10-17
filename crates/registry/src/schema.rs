//! Serde types mirroring `registry/schema/registry.schema.json`.
//! Keep both in sync; `tests::bundled_registry_matches_json_schema` enforces it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// Current schema major version. Registries with a higher version are rejected
/// (the app keeps using its cached/bundled copy and tells the user to update).
///
/// Version 2 added [`Model::uncensored`]. An app that ignores that flag could
/// recommend such a model, so version 1 lists (still published for Ylide 0.1.3
/// and older) never contain one; see [`crate::validate`].
pub const SCHEMA_VERSION: u32 = 2;

/// Text in several UI languages, keyed by BCP-47 language code ("en", "de").
pub type LocalizedText = BTreeMap<String, String>;

/// Language fallback for [`LocalizedText`]: requested language, then English, then any.
pub trait Localized {
    fn localized(&self, lang: &str) -> &str;
}

impl Localized for LocalizedText {
    fn localized(&self, lang: &str) -> &str {
        self.get(lang)
            .or_else(|| self.get("en"))
            .or_else(|| self.values().next())
            .map(String::as_str)
            .unwrap_or("")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Registry {
    pub schema_version: u32,
    /// Calendar version of the data, e.g. "2026.10.15". Newer wins.
    pub registry_version: String,
    pub updated_at: String,
    #[serde(default)]
    pub runtimes: Vec<Runtime>,
    #[serde(default)]
    pub gpu_hints: Vec<GpuHint>,
    pub models: Vec<Model>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Runtime {
    /// e.g. "llama.cpp"
    pub id: String,
    /// Upstream release tag, e.g. "b6990".
    pub version: String,
    pub license: License,
    pub assets: Vec<RuntimeAsset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuntimeAsset {
    /// `windows`, `macos`, `linux`
    pub os: String,
    /// `x86_64`, `aarch64`
    pub arch: String,
    pub backend: hardware::Backend,
    /// Free-form flavour, e.g. "cuda-12.4" or "vulkan".
    pub variant: String,
    /// Zip archives; extracted in order into the same directory.
    pub files: Vec<RemoteFile>,
    /// Shipped inside the installer (no download needed).
    #[serde(default)]
    pub bundled: bool,
    /// Minimum CUDA driver API version for CUDA assets, e.g. "12.4".
    #[serde(default)]
    pub min_cuda_driver: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteFile {
    pub url: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// Lower-case hex SHA-256. Downloads are rejected on mismatch.
    pub sha256: String,
}

/// Memory bandwidth hint used to estimate generation speed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GpuHint {
    /// Case-insensitive substring of the adapter / chip name.
    pub name_contains: String,
    pub bandwidth_gbps: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Role {
    /// Conversational coding assistant.
    Chat,
    /// Tool-calling agent (Coder, Reviewer, Orchestrator).
    Agent,
    /// Fill-in-the-middle tab completion.
    Fim,
    /// Text embeddings for semantic search.
    Embedding,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Model {
    /// Stable, unique slug.
    pub id: String,
    pub name: String,
    pub family: String,
    pub publisher: String,
    pub release_date: String,
    pub roles: Vec<Role>,
    pub description: LocalizedText,
    #[serde(default)]
    pub strengths: Vec<LocalizedText>,
    pub license: License,
    pub architecture: Architecture,
    pub context: ContextInfo,
    pub capabilities: Capabilities,
    pub quality: Quality,
    /// Per-request parameters the IDE sends for each kind of work.
    #[serde(default)]
    pub request_defaults: Option<RequestDefaults>,
    pub source: Source,
    pub variants: Vec<Variant>,
    /// Vision projector (llama.cpp `--mmproj`) from the same repository, for
    /// image input. Present exactly when `capabilities.vision` is set. Apps
    /// before 0.1.6 ignore it (unknown fields are skipped).
    #[serde(default)]
    pub projector: Option<ModelFile>,
    #[serde(default)]
    pub fim: Option<FimFormat>,
    #[serde(default)]
    pub embedding: Option<EmbeddingInfo>,
    #[serde(default)]
    pub benchmarks: Vec<Benchmark>,
    /// Extra llama-server arguments this model needs (e.g. `--jinja`).
    #[serde(default)]
    pub llama_args: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// A variant with the refusal training removed. Never recommended
    /// automatically; the user picks it in the catalog, where it is marked.
    #[serde(default)]
    pub uncensored: bool,
}

impl Model {
    pub fn has_role(&self, role: Role) -> bool {
        self.roles.contains(&role)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct License {
    /// SPDX identifier, or `LicenseRef-<name>` for custom licenses.
    pub id: String,
    pub name: String,
    pub url: String,
    pub commercial_use: bool,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ArchitectureKind {
    Dense,
    Moe,
}

/// What the memory estimator needs. All values are taken from the GGUF metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Architecture {
    #[serde(rename = "type")]
    pub kind: ArchitectureKind,
    pub params_total_b: f64,
    pub params_active_b: f64,
    /// `block_count`
    pub layers: u32,
    /// Layers that keep a KV cache (hybrid SSM models have fewer). Defaults to `layers`.
    #[serde(default)]
    pub attention_layers: Option<u32>,
    /// `attention.head_count_kv`
    pub kv_heads: u32,
    /// `attention.key_length`
    pub head_dim_k: u32,
    /// `attention.value_length`
    pub head_dim_v: u32,
    /// Sliding-window size for SWA layers, if the model interleaves them.
    #[serde(default)]
    pub sliding_window: Option<u32>,
    /// How many of the attention layers use the sliding window.
    #[serde(default)]
    pub sliding_window_layers: Option<u32>,
    /// Overrides the computed f16 KV bytes per token (MLA and other exotic layouts).
    #[serde(default)]
    #[ts(type = "number | null")]
    pub kv_bytes_per_token_f16: Option<u64>,
    /// Share of the weights stored in expert tensors (MoE only, 0..1).
    #[serde(default)]
    pub expert_fraction: Option<f64>,
    /// Constant per-sequence state of recurrent/hybrid layers (Gated DeltaNet, Mamba), MiB.
    #[serde(default)]
    pub recurrent_state_mib: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContextInfo {
    pub max: u32,
    pub recommended: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ToolCalling {
    None,
    Basic,
    Good,
    Excellent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Reasoning {
    /// Never emits thinking tokens.
    None,
    /// Thinking can be toggled (chat template flag).
    Optional,
    /// Always thinks.
    Always,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Capabilities {
    pub tool_calling: ToolCalling,
    pub reasoning: Reasoning,
    /// Understands images with its [`Model::projector`].
    #[serde(default)]
    pub vision: bool,
}

/// Curated 0-100 scores derived from the benchmarks; used for ranking only.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Quality {
    pub coding: f64,
    pub agentic: f64,
}

/// Sampling and chat-template switches for one kind of request.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModeDefaults {
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub top_p: Option<f64>,
    #[serde(default)]
    pub top_k: Option<u32>,
    #[serde(default)]
    pub min_p: Option<f64>,
    #[serde(default)]
    pub presence_penalty: Option<f64>,
    #[serde(default)]
    pub repeat_penalty: Option<f64>,
    /// Passed as `chat_template_kwargs`, e.g. `{"enable_thinking": false}`.
    #[serde(default)]
    #[ts(type = "Record<string, unknown> | null")]
    pub template_kwargs: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RequestDefaults {
    /// Agent mode (tool loops, thinking usually on).
    #[serde(default)]
    pub agent: Option<ModeDefaults>,
    /// Chat panel.
    #[serde(default)]
    pub chat: Option<ModeDefaults>,
    /// Inline edit (fast, usually without thinking).
    #[serde(default)]
    pub inline: Option<ModeDefaults>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Source {
    pub hf_repo: String,
    /// Commit hash or branch. Pinning a commit makes `sha256` values stable.
    pub revision: String,
    #[serde(default)]
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Variant {
    /// e.g. "Q4_K_M", "UD-Q4_K_XL", "Q8_0"
    pub quant: String,
    /// Effective bits per weight, used to estimate per-token bandwidth.
    pub bits_per_weight: f64,
    /// One file, or several for split GGUFs (`-00001-of-00003.gguf`).
    pub files: Vec<ModelFile>,
    /// Points subtracted from `quality` for quantisation loss (0 = lossless).
    pub quality_penalty: f64,
}

impl Variant {
    pub fn size_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size_bytes).sum()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModelFile {
    /// Path inside the Hugging Face repo.
    pub path: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the file (the Git LFS oid).
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FimFormat {
    pub prefix: String,
    pub suffix: String,
    pub middle: String,
    /// Separator for extra repository files (e.g. `<|file_sep|>`), if supported.
    #[serde(default)]
    pub file_separator: Option<String>,
    /// Stop sequences that end a completion.
    #[serde(default)]
    pub stop: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EmbeddingInfo {
    pub dimensions: u32,
    /// `mean`, `cls`, `last`
    pub pooling: String,
    pub max_tokens: u32,
    #[serde(default)]
    pub query_prefix: String,
    #[serde(default)]
    pub document_prefix: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Benchmark {
    pub name: String,
    pub score: f64,
    /// "%" or "pass@1" etc.
    pub unit: String,
    pub source_url: String,
    /// Reported by the model's publisher rather than measured independently.
    pub self_reported: bool,
    #[serde(default)]
    pub date: Option<String>,
}
