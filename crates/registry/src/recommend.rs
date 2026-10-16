//! Picks the best model configuration for the machine plus alternatives.
//!
//! Every (model, quantisation, context, KV type) combination is planned with
//! [`estimate::plan`]; the resulting candidates are scored by curated quality,
//! quantisation loss, context and estimated speed. Reasons are returned as codes
//! with parameters so the UI can render them in any language.

use crate::estimate::{self, ComputeBudget, KvCacheType, Placement, Plan};
use crate::schema::{Model, Registry, Role, ToolCalling, Variant};
use hardware::HardwareProfile;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

const GIB: f64 = (1u64 << 30) as f64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReasonCode {
    FitsInVram,
    MoeOffload,
    PartialOffload,
    UnifiedMemory,
    CpuOnly,
    SpeedEstimate,
    TopQualityForBudget,
    Benchmark,
    ToolCalling,
    LongContext,
    ReasoningModel,
    PermissiveLicense,
    RestrictedLicense,
    SlowWarning,
    QuantizedKvCache,
    SharesGpuWithMain,
    RunsOnCpu,
    /// This configuration needs the GPU memory otherwise used by autocomplete.
    AutocompleteMovesToCpu,
    NoGpu,
    LowDiskSpace,
    NothingFits,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Reason {
    pub code: ReasonCode,
    pub params: BTreeMap<String, String>,
}

impl Reason {
    fn new(code: ReasonCode) -> Self {
        Self {
            code,
            params: BTreeMap::new(),
        }
    }

    fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Candidate {
    pub model_id: String,
    pub quant: String,
    pub plan: Plan,
    pub score: f64,
    #[ts(type = "number")]
    pub download_bytes: u64,
    pub reasons: Vec<Reason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AlternativeKind {
    /// Noticeably faster, slightly weaker.
    Faster,
    /// Stronger, but slower or larger.
    Stronger,
    /// Needs much less memory (leaves room for other apps).
    Lighter,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Alternative {
    pub kind: AlternativeKind,
    pub candidate: Candidate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Recommendation {
    pub budget: ComputeBudget,
    /// Main chat/agent model.
    pub primary: Option<Candidate>,
    pub alternatives: Vec<Alternative>,
    /// Small fill-in-the-middle model for tab completion.
    pub autocomplete: Option<Candidate>,
    /// Embedding model for semantic code search.
    pub embedding: Option<Candidate>,
    /// Machine-level notices (no GPU, low disk, ...).
    pub notices: Vec<Reason>,
    /// The best configuration of every variant for its model's main role, with
    /// the whole machine to itself, including models that are never recommended:
    /// what the catalog shows under "on this computer". A variant that does not
    /// fit is missing.
    pub fits: Vec<Candidate>,
}

/// Generation speed (tokens/s) a role needs to feel responsive.
fn target_tps(role: Role) -> f64 {
    match role {
        Role::Agent => 25.0,
        Role::Chat => 18.0,
        Role::Fim => 60.0,
        Role::Embedding => 1.0,
    }
}

/// Below this a configuration is not offered unless nothing else fits.
fn minimum_tps(role: Role) -> f64 {
    match role {
        Role::Agent => 6.0,
        Role::Chat => 4.0,
        Role::Fim => 10.0,
        Role::Embedding => 0.0,
    }
}

fn context_options(model: &Model, role: Role) -> Vec<u32> {
    let mut opts: Vec<u32> = match role {
        Role::Fim => vec![8_192, 4_096],
        Role::Embedding => vec![model.embedding.as_ref().map(|e| e.max_tokens).unwrap_or(8_192).min(8_192)],
        Role::Agent | Role::Chat => vec![model.context.recommended, 65_536, 32_768, 16_384, 8_192],
    };
    opts.retain(|c| *c <= model.context.max && *c > 0);
    opts.sort_unstable_by(|a, b| b.cmp(a));
    opts.dedup();
    opts
}

/// Agent loops accumulate tool output quickly, so they value long context much
/// more than chat does.
fn context_penalty(context: u32, role: Role) -> f64 {
    match role {
        Role::Agent => match context {
            c if c >= 131_072 => 0.0,
            c if c >= 65_536 => 1.5,
            c if c >= 32_768 => 5.0,
            c if c >= 16_384 => 12.0,
            _ => 25.0,
        },
        Role::Chat => match context {
            c if c >= 32_768 => 0.0,
            c if c >= 16_384 => 3.0,
            _ => 10.0,
        },
        Role::Fim | Role::Embedding => 0.0,
    }
}

/// Autocomplete needs low latency: it runs entirely on the GPU or entirely on the CPU.
fn placement_allowed(role: Role, placement: Placement) -> bool {
    match role {
        Role::Fim => matches!(placement, Placement::Gpu | Placement::Unified | Placement::Cpu),
        _ => true,
    }
}

/// Models the recommender may pick for `role`. Uncensored variants are only
/// offered in the catalog, where the user chooses them knowingly.
fn offered(model: &Model, role: Role) -> bool {
    model.has_role(role) && !model.uncensored
}

fn raw_quality(model: &Model, role: Role) -> f64 {
    let base = match role {
        Role::Agent => model.quality.agentic,
        _ => model.quality.coding,
    };
    let tools = match (role, model.capabilities.tool_calling) {
        (Role::Agent, ToolCalling::None) => -1000.0,
        (Role::Agent, ToolCalling::Basic) => -8.0,
        (Role::Agent, ToolCalling::Excellent) => 2.0,
        _ => 0.0,
    };
    base + tools
}

fn score(model: &Model, variant: &Variant, plan: &Plan, role: Role) -> f64 {
    let quality = raw_quality(model, role) - variant.quality_penalty - context_penalty(plan.context, role);
    let kv = if plan.kv_cache_type == KvCacheType::F16 { 0.0 } else { 0.5 };
    // Speed matters logarithmically; slow prefill (CPU) hurts agents with long prompts.
    let target = target_tps(role);
    let effective_tps = plan.est_tokens_per_sec * plan.placement.prefill_factor().sqrt();
    let speed = if role == Role::Embedding {
        -(plan.weights_bytes as f64 / GIB) * 2.0
    } else {
        (8.0 * (effective_tps.min(target * 2.0) / target).log2()).clamp(-40.0, 8.0)
    };
    quality - kv + speed
}

/// Best candidate per model for `role` under `budget`.
fn best_per_model<'r>(registry: &'r Registry, role: Role, budget: &ComputeBudget, allow_slow: bool) -> Vec<(Candidate, &'r Model)> {
    best_configs(registry, role, budget, allow_slow, false)
}

/// Best configuration per model, or per (model, quantisation) when `per_variant`.
fn best_configs<'r>(
    registry: &'r Registry,
    role: Role,
    budget: &ComputeBudget,
    allow_slow: bool,
    per_variant: bool,
) -> Vec<(Candidate, &'r Model)> {
    let mut out = Vec::new();
    for model in registry.models.iter().filter(|m| offered(m, role)) {
        configs_of(model, role, budget, allow_slow, per_variant, &mut out);
    }
    out.sort_by(|a, b| b.0.score.total_cmp(&a.0.score));
    out
}

/// Adds the best configuration of `model` (or of each of its variants) for `role` to `out`.
fn configs_of<'r>(model: &'r Model, role: Role, budget: &ComputeBudget, allow_slow: bool, per_variant: bool, out: &mut Vec<(Candidate, &'r Model)>) {
    if role == Role::Agent && model.capabilities.tool_calling == ToolCalling::None {
        return;
    }
    // Autocomplete must not be split between GPU and CPU; a variant too big for
    // the GPU may still run on the CPU alone.
    let cpu_only = ComputeBudget { vram_bytes: 0, unified: false, ..budget.clone() };
    {
        let mut best: Option<Candidate> = None;
        for variant in &model.variants {
            if per_variant && let Some(c) = best.take() {
                out.push((c, model));
            }
            let download = variant.size_bytes();
            if budget.disk_free_bytes.is_some_and(|free| download > free) {
                continue;
            }
            for context in context_options(model, role) {
                for kv in [KvCacheType::F16, KvCacheType::Q8_0] {
                    let plan = match estimate::plan(model, variant, context, kv, budget) {
                        Some(p) if placement_allowed(role, p.placement) => p,
                        Some(_) => match estimate::plan(model, variant, context, kv, &cpu_only) {
                            Some(p) if placement_allowed(role, p.placement) => p,
                            _ => continue,
                        },
                        None => continue,
                    };
                    if !allow_slow && plan.est_tokens_per_sec < minimum_tps(role) {
                        continue;
                    }
                    let s = score(model, variant, &plan, role);
                    if best.as_ref().is_none_or(|b| s > b.score) {
                        best = Some(Candidate {
                            model_id: model.id.clone(),
                            quant: variant.quant.clone(),
                            plan,
                            score: s,
                            download_bytes: download,
                            reasons: Vec::new(),
                        });
                    }
                }
            }
        }
        if let Some(c) = best {
            out.push((c, model));
        }
    }
}

/// The role a model is planned for in the catalog: the most demanding one it has.
fn main_role(model: &Model) -> Option<Role> {
    [Role::Agent, Role::Chat, Role::Fim, Role::Embedding]
        .into_iter()
        .find(|&r| model.has_role(r) && !(r == Role::Agent && model.capabilities.tool_calling == ToolCalling::None))
}

/// See [`Recommendation::fits`]. Slow configurations count, and free disk space
/// does not: the catalog says that apart.
fn variant_fits(registry: &Registry, budget: &ComputeBudget) -> Vec<Candidate> {
    let budget = ComputeBudget { disk_free_bytes: None, ..budget.clone() };
    // Like in `recommend`: embeddings stay off the GPU, which belongs to the main model.
    let embed_budget = ComputeBudget { vram_bytes: 0, unified: false, ..budget.clone() };
    let mut out = Vec::new();
    for model in &registry.models {
        if let Some(role) = main_role(model) {
            let budget = if role == Role::Embedding { &embed_budget } else { &budget };
            configs_of(model, role, budget, true, true, &mut out);
        }
    }
    out.into_iter().map(|(c, _)| c).collect()
}

fn footprint(c: &Candidate) -> u64 {
    c.plan.vram_bytes + c.plan.ram_bytes
}

fn placement_reason(plan: &Plan) -> Reason {
    let gb = |b: u64| format!("{:.1}", b as f64 / GIB);
    match plan.placement {
        Placement::Gpu => Reason::new(ReasonCode::FitsInVram).with("vramGb", gb(plan.vram_bytes)),
        Placement::MoeOffload { cpu_expert_layers } => Reason::new(ReasonCode::MoeOffload)
            .with("vramGb", gb(plan.vram_bytes))
            .with("ramGb", gb(plan.ram_bytes))
            .with("cpuExpertLayers", cpu_expert_layers),
        Placement::PartialOffload { gpu_layers } => Reason::new(ReasonCode::PartialOffload)
            .with("vramGb", gb(plan.vram_bytes))
            .with("ramGb", gb(plan.ram_bytes))
            .with("gpuLayers", gpu_layers),
        Placement::Unified => Reason::new(ReasonCode::UnifiedMemory).with("ramGb", gb(plan.ram_bytes)),
        Placement::Cpu => Reason::new(ReasonCode::CpuOnly).with("ramGb", gb(plan.ram_bytes)),
    }
}

fn explain(c: &mut Candidate, model: &Model, role: Role, best_quality_in_budget: f64) {
    let mut r = vec![placement_reason(&c.plan)];
    r.push(Reason::new(ReasonCode::SpeedEstimate).with("tps", format!("{:.0}", c.plan.est_tokens_per_sec)));
    if (role == Role::Agent || role == Role::Chat) && raw_quality(model, role) >= best_quality_in_budget - 0.01 {
        r.push(Reason::new(ReasonCode::TopQualityForBudget));
    }
    if let Some(b) = model.benchmarks.first() {
        r.push(
            Reason::new(ReasonCode::Benchmark)
                .with("name", &b.name)
                .with("score", b.score)
                .with("unit", &b.unit)
                .with("selfReported", b.self_reported),
        );
    }
    if role == Role::Agent && model.capabilities.tool_calling >= ToolCalling::Good {
        r.push(Reason::new(ReasonCode::ToolCalling).with("level", format!("{:?}", model.capabilities.tool_calling).to_lowercase()));
    }
    if c.plan.context >= 32_768 && (role == Role::Agent || role == Role::Chat) {
        r.push(Reason::new(ReasonCode::LongContext).with("tokens", c.plan.context));
    }
    if model.capabilities.reasoning != crate::schema::Reasoning::None && role != Role::Fim {
        r.push(Reason::new(ReasonCode::ReasoningModel));
    }
    if c.plan.kv_cache_type != KvCacheType::F16 {
        r.push(Reason::new(ReasonCode::QuantizedKvCache).with("type", c.plan.kv_cache_type.llama_arg()));
    }
    let permissive = model.license.commercial_use
        && ["Apache-2.0", "MIT", "BSD-3-Clause", "BSD-2-Clause"].contains(&model.license.id.as_str());
    r.push(
        Reason::new(if permissive {
            ReasonCode::PermissiveLicense
        } else {
            ReasonCode::RestrictedLicense
        })
        .with("license", &model.license.name),
    );
    if c.plan.est_tokens_per_sec < minimum_tps(role) * 2.0 && role != Role::Embedding {
        r.push(Reason::new(ReasonCode::SlowWarning));
    }
    c.reasons = r;
}

/// VRAM to keep free so an autocomplete model also runs on the GPU: the best
/// one that needs at most a fifth of the budget, otherwise the smallest.
fn autocomplete_reserve(registry: &Registry, budget: &ComputeBudget) -> u64 {
    if budget.vram_bytes < 10 << 30 {
        return 0;
    }
    let mut options: Vec<(f64, u64)> = registry
        .models
        .iter()
        .filter(|m| offered(m, Role::Fim))
        .flat_map(|m| {
            m.variants.iter().map(move |v| {
                let weights = v.size_bytes();
                let need = weights
                    + estimate::kv_cache_bytes(&m.architecture, 8_192, KvCacheType::F16)
                    + estimate::compute_overhead_bytes(weights, 8_192);
                (m.quality.coding - v.quality_penalty, need)
            })
        })
        .collect();
    let limit = budget.vram_bytes / 5;
    options.sort_by(|a, b| b.0.total_cmp(&a.0));
    options
        .iter()
        .find(|(_, need)| *need <= limit)
        .or_else(|| options.iter().min_by_key(|(_, need)| *need))
        .map(|(_, need)| *need)
        .unwrap_or(0)
}

/// Computes the recommendation for `hw` from `registry`.
pub fn recommend(registry: &Registry, hw: &HardwareProfile) -> Recommendation {
    let budget = ComputeBudget::from_profile(hw, &registry.gpu_hints);
    let mut notices = Vec::new();
    if budget.vram_bytes == 0 && !budget.unified {
        notices.push(Reason::new(ReasonCode::NoGpu));
    }

    let role = Role::Agent;
    // Keep room for the autocomplete model on the GPU unless that costs the main
    // model noticeably (e.g. a model that only just fits completely).
    let reserve = autocomplete_reserve(registry, &budget);
    let full = best_per_model(registry, role, &budget, false);
    let mut main_budget = budget.clone();
    let mut ranked = if reserve > 0 {
        main_budget.vram_bytes -= reserve;
        let reserved = best_per_model(registry, role, &main_budget, false);
        match (reserved.first(), full.first()) {
            (Some(r), Some(f)) if r.0.score >= f.0.score - 3.0 => reserved,
            _ => {
                main_budget = budget.clone();
                full
            }
        }
    } else {
        full
    };
    if ranked.is_empty() {
        ranked = best_per_model(registry, role, &main_budget, true);
    }
    if ranked.is_empty() {
        notices.push(Reason::new(ReasonCode::NothingFits));
    }
    let best_quality = ranked.iter().map(|(_, m)| raw_quality(m, role)).fold(f64::MIN, f64::max);

    let mut primary = ranked.first().map(|(c, _)| c.clone());
    let mut alternatives = Vec::new();
    if let Some(p) = &primary {
        let primary_quality = ranked.iter().find(|(c, _)| c.model_id == p.model_id).map(|(_, m)| raw_quality(m, role)).unwrap_or(0.0);
        let mut used = vec![p.model_id.clone()];
        let others = || ranked.iter().filter(|(c, _)| c.model_id != p.model_id);

        // "Faster" may also be the same model in a smaller quantisation.
        let per_variant = best_configs(registry, role, &main_budget, false, true);
        let faster = per_variant
            .iter()
            .filter(|(c, _)| !(c.model_id == p.model_id && c.quant == p.quant))
            .filter(|(c, _)| c.plan.est_tokens_per_sec >= p.plan.est_tokens_per_sec * 1.4 && c.score >= p.score - 25.0)
            .max_by(|a, b| a.0.score.total_cmp(&b.0.score));
        if let Some((c, _)) = faster {
            if c.model_id != p.model_id {
                used.push(c.model_id.clone());
            }
            alternatives.push((AlternativeKind::Faster, c.clone()));
        }

        // "Stronger" may be slow and may claim the VRAM reserved for autocomplete.
        let slow_ranked = best_per_model(registry, role, &budget, true);
        let stronger = slow_ranked
            .iter()
            .filter(|(c, m)| !used.contains(&c.model_id) && raw_quality(m, role) > primary_quality + 2.0 && c.plan.est_tokens_per_sec >= 3.0)
            .max_by(|a, b| raw_quality(a.1, role).total_cmp(&raw_quality(b.1, role)));
        if let Some((c, _)) = stronger {
            used.push(c.model_id.clone());
            alternatives.push((AlternativeKind::Stronger, c.clone()));
        }

        let lighter = others()
            .filter(|(c, _)| !used.contains(&c.model_id) && (footprint(c) as f64) <= footprint(p) as f64 * 0.6)
            .max_by(|a, b| a.0.score.total_cmp(&b.0.score));
        if let Some((c, _)) = lighter {
            alternatives.push((AlternativeKind::Lighter, c.clone()));
        }
    }

    let model_of = |id: &str| registry.models.iter().find(|m| m.id == id);
    if let Some(p) = primary.as_mut()
        && let Some(m) = model_of(&p.model_id)
    {
        explain(p, m, role, best_quality);
    }
    let alternatives = alternatives
        .into_iter()
        .map(|(kind, mut c)| {
            if let Some(m) = model_of(&c.model_id) {
                explain(&mut c, m, role, best_quality);
            }
            if c.plan.vram_bytes > main_budget.vram_bytes {
                c.reasons.push(Reason::new(ReasonCode::AutocompleteMovesToCpu));
            }
            Alternative { kind, candidate: c }
        })
        .collect();

    // Autocomplete shares the GPU with the main model: plan it with what is left.
    let mut fim_budget = budget.clone();
    if let Some(p) = &primary {
        fim_budget.vram_bytes = fim_budget.vram_bytes.saturating_sub(p.plan.vram_bytes);
        fim_budget.ram_bytes = fim_budget.ram_bytes.saturating_sub(p.plan.ram_bytes);
        fim_budget.unified_bytes = fim_budget.unified_bytes.saturating_sub(p.plan.ram_bytes);
    }
    let autocomplete = best_per_model(registry, Role::Fim, &fim_budget, false).into_iter().next().map(|(mut c, m)| {
        explain(&mut c, m, Role::Fim, 0.0);
        c.reasons.insert(
            0,
            Reason::new(if c.plan.placement == Placement::Cpu {
                ReasonCode::RunsOnCpu
            } else {
                ReasonCode::SharesGpuWithMain
            }),
        );
        c
    });

    // Embeddings run fine on the CPU and must not compete with the main model for VRAM.
    let mut embed_budget = fim_budget.clone();
    embed_budget.vram_bytes = 0;
    embed_budget.unified = false;
    if let Some(a) = &autocomplete {
        embed_budget.ram_bytes = embed_budget.ram_bytes.saturating_sub(a.plan.ram_bytes);
    }
    let embedding = best_per_model(registry, Role::Embedding, &embed_budget, true).into_iter().next().map(|(mut c, m)| {
        explain(&mut c, m, Role::Embedding, 0.0);
        c.reasons.insert(0, Reason::new(ReasonCode::RunsOnCpu));
        c
    });

    if let (Some(p), Some(free)) = (&primary, budget.disk_free_bytes) {
        let needed = p.download_bytes + autocomplete.as_ref().map_or(0, |a| a.download_bytes) + (5u64 << 30);
        if free < needed {
            notices.push(Reason::new(ReasonCode::LowDiskSpace).with("freeGb", format!("{:.0}", free as f64 / GIB)));
        }
    }

    let fits = variant_fits(registry, &budget);
    Recommendation {
        budget,
        primary,
        alternatives,
        autocomplete,
        embedding,
        notices,
        fits,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::schema::*;
    use hardware::*;

    const GB: u64 = 1_000_000_000;

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn model(
        id: &str,
        roles: &[Role],
        moe: bool,
        total_b: f64,
        active_b: f64,
        layers: u32,
        kv_heads: u32,
        quality: f64,
        tools: ToolCalling,
        variants: &[(&str, f64, f64)],
    ) -> Model {
        Model {
            id: id.into(),
            name: id.into(),
            family: id.into(),
            publisher: "test".into(),
            release_date: "2026-01-01".into(),
            roles: roles.to_vec(),
            description: LocalizedText::from([("en".to_string(), id.to_string())]),
            strengths: vec![],
            license: License {
                id: "Apache-2.0".into(),
                name: "Apache License 2.0".into(),
                url: "https://www.apache.org/licenses/LICENSE-2.0".into(),
                commercial_use: true,
                notes: None,
            },
            architecture: Architecture {
                kind: if moe { ArchitectureKind::Moe } else { ArchitectureKind::Dense },
                params_total_b: total_b,
                params_active_b: active_b,
                layers,
                attention_layers: None,
                kv_heads,
                head_dim_k: 128,
                head_dim_v: 128,
                sliding_window: None,
                sliding_window_layers: None,
                kv_bytes_per_token_f16: None,
                expert_fraction: moe.then_some(0.92),
                recurrent_state_mib: None,
            },
            context: ContextInfo {
                max: 131_072,
                recommended: 32_768,
            },
            capabilities: Capabilities {
                tool_calling: tools,
                reasoning: Reasoning::None,
                vision: false,
            },
            quality: Quality {
                coding: quality,
                agentic: quality,
            },
            request_defaults: None,
            source: Source {
                hf_repo: format!("test/{id}"),
                revision: "main".into(),
                homepage: None,
            },
            variants: variants
                .iter()
                .map(|(quant, size_gb, penalty)| Variant {
                    quant: quant.to_string(),
                    bits_per_weight: 4.8,
                    files: vec![ModelFile {
                        path: format!("{id}-{quant}.gguf"),
                        size_bytes: (size_gb * GB as f64) as u64,
                        sha256: "0".repeat(64),
                    }],
                    quality_penalty: *penalty,
                })
                .collect(),
            fim: roles.contains(&Role::Fim).then(|| FimFormat {
                prefix: "<p>".into(),
                suffix: "<s>".into(),
                middle: "<m>".into(),
                file_separator: None,
                stop: vec![],
            }),
            embedding: roles.contains(&Role::Embedding).then(|| EmbeddingInfo {
                dimensions: 1024,
                pooling: "last".into(),
                max_tokens: 8192,
                query_prefix: String::new(),
                document_prefix: String::new(),
            }),
            benchmarks: vec![],
            llama_args: vec![],
            tags: vec![],
            notes: None,
            uncensored: false,
        }
    }

    pub(crate) fn test_registry() -> Registry {
        use Role::*;
        Registry {
            schema_version: SCHEMA_VERSION,
            registry_version: "2026.1.1".into(),
            updated_at: "2026-01-01".into(),
            runtimes: vec![],
            gpu_hints: vec![],
            models: vec![
                model("moe-30b", &[Chat, Agent], true, 30.5, 3.3, 48, 4, 70.0, ToolCalling::Good,
                      &[("Q4_K_M", 18.6, 2.0), ("Q5_K_M", 21.7, 1.0), ("Q3_K_XL", 13.8, 5.0)]),
                model("dense-24b", &[Chat, Agent], false, 24.0, 24.0, 40, 8, 74.0, ToolCalling::Excellent,
                      &[("Q4_K_M", 14.3, 2.0), ("Q6_K", 19.3, 0.5)]),
                model("big-moe-120b", &[Chat, Agent], true, 117.0, 5.1, 36, 8, 80.0, ToolCalling::Good,
                      &[("MXFP4", 63.0, 0.0)]),
                model("dense-8b", &[Chat, Agent], false, 8.0, 8.0, 36, 8, 50.0, ToolCalling::Good,
                      &[("Q4_K_M", 5.0, 2.0), ("Q8_0", 8.7, 0.0)]),
                model("dense-4b", &[Chat, Agent], false, 4.0, 4.0, 36, 8, 38.0, ToolCalling::Basic,
                      &[("Q4_K_M", 2.5, 3.0), ("Q8_0", 4.3, 0.0)]),
                model("chat-only-14b", &[Chat], false, 14.0, 14.0, 40, 8, 90.0, ToolCalling::None,
                      &[("Q4_K_M", 9.0, 2.0)]),
                model("fim-1.5b", &[Fim], false, 1.5, 1.5, 28, 2, 40.0, ToolCalling::None, &[("Q8_0", 1.6, 0.0)]),
                model("fim-7b", &[Fim], false, 7.6, 7.6, 28, 4, 55.0, ToolCalling::None, &[("Q4_K_M", 4.7, 1.0)]),
                model("embed-0.6b", &[Embedding], false, 0.6, 0.6, 28, 8, 60.0, ToolCalling::None, &[("Q8_0", 0.64, 0.0)]),
            ],
        }
    }

    pub(crate) fn machine(vram_gib: u64, ram_gib: u64) -> HardwareProfile {
        HardwareProfile {
            os: OsInfo {
                family: "windows".into(),
                version: String::new(),
                arch: "x86_64".into(),
            },
            cpu: CpuInfo {
                brand: "test".into(),
                physical_cores: 8,
                logical_cores: 16,
                features: CpuFeatures {
                    avx2: true,
                    ..CpuFeatures::default()
                },
            },
            memory: MemoryInfo {
                total_bytes: ram_gib << 30,
                available_bytes: ram_gib << 29,
            },
            gpus: if vram_gib > 0 {
                vec![GpuInfo {
                    index: 0,
                    name: "Test GPU".into(),
                    vendor: GpuVendor::Nvidia,
                    vendor_id: 0x10de,
                    device_id: 0,
                    kind: GpuKind::Discrete,
                    dedicated_vram_bytes: vram_gib << 30,
                    shared_memory_bytes: 0,
                    vram_budget_bytes: None,
                    vram_free_bytes: None,
                    compute_capability: None,
                }]
            } else {
                vec![]
            },
            acceleration: Acceleration {
                cuda_driver: (vram_gib > 0).then(|| "13.0".into()),
                vulkan: vram_gib > 0,
                ..Acceleration::default()
            },
            disk: Some(DiskInfo {
                mount_point: "D:\\".into(),
                total_bytes: 2000 << 30,
                free_bytes: 800 << 30,
            }),
            probed_at_unix_ms: 0,
            warnings: vec![],
        }
    }

    fn apple(ram_gib: u64) -> HardwareProfile {
        let mut hw = machine(0, ram_gib);
        hw.gpus = vec![GpuInfo {
            index: 0,
            name: "Apple M4 Max GPU".into(),
            vendor: GpuVendor::Apple,
            vendor_id: 0x106b,
            device_id: 0,
            kind: GpuKind::Integrated,
            dedicated_vram_bytes: 0,
            shared_memory_bytes: (ram_gib << 30) / 4 * 3,
            vram_budget_bytes: None,
            vram_free_bytes: None,
            compute_capability: None,
        }];
        hw.acceleration = Acceleration {
            metal: true,
            ..Acceleration::default()
        };
        hw
    }

    #[test]
    fn every_tier_gets_a_usable_primary() {
        let reg = test_registry();
        for (vram, ram) in [(0, 8), (0, 16), (0, 64), (6, 16), (8, 32), (12, 32), (16, 64), (24, 64), (32, 128)] {
            let r = recommend(&reg, &machine(vram, ram));
            let p = r.primary.unwrap_or_else(|| panic!("no primary for {vram} GB VRAM / {ram} GB RAM"));
            let fits = p.plan.vram_bytes <= r.budget.vram_bytes && p.plan.ram_bytes <= r.budget.ram_bytes;
            assert!(fits, "{vram}/{ram}: {p:#?} exceeds {:#?}", r.budget);
            assert_ne!(p.model_id, "chat-only-14b", "agent role requires tool calling");
        }
    }

    #[test]
    fn sixteen_gb_prefers_strong_model_on_gpu_or_moe_offload() {
        let r = recommend(&test_registry(), &machine(16, 64));
        let p = r.primary.unwrap();
        assert!(["moe-30b", "dense-24b"].contains(&p.model_id.as_str()), "{}", p.model_id);
        assert!(p.plan.est_tokens_per_sec >= 20.0, "{p:#?}");
        assert!(p.plan.context >= 32_768);
    }

    #[test]
    fn twentyfour_gb_runs_fully_on_gpu() {
        let r = recommend(&test_registry(), &machine(24, 64));
        let p = r.primary.unwrap();
        assert_eq!(p.plan.placement, Placement::Gpu, "{p:#?}");
        assert!(p.reasons.iter().any(|r| r.code == ReasonCode::FitsInVram));
    }

    #[test]
    fn cpu_only_machine_gets_small_or_moe_model() {
        let r = recommend(&test_registry(), &machine(0, 16));
        let p = r.primary.unwrap();
        assert_eq!(p.plan.placement, Placement::Cpu);
        assert!(r.notices.iter().any(|n| n.code == ReasonCode::NoGpu));
        // dense-24b on DDR4 would crawl; must not be chosen
        assert_ne!(p.model_id, "dense-24b");
    }

    #[test]
    fn big_moe_is_offered_with_plenty_of_ram() {
        // 64 GB RAM: the 63 GB model does not fit next to the OS.
        let small = recommend(&test_registry(), &machine(16, 64));
        assert!(small.primary.as_ref().unwrap().model_id != "big-moe-120b");
        // 128 GB RAM: it becomes the primary pick or at least the "stronger" alternative.
        let r = recommend(&test_registry(), &machine(16, 128));
        let primary = r.primary.as_ref().unwrap().model_id.as_str();
        let stronger = r.alternatives.iter().find(|a| a.kind == AlternativeKind::Stronger).map(|a| a.candidate.model_id.as_str());
        assert!(primary == "big-moe-120b" || stronger == Some("big-moe-120b"), "{primary} / {stronger:?}");
    }

    #[test]
    fn uncensored_variants_are_never_recommended() {
        // A copy of every agent model that would otherwise win everywhere.
        let mut reg = test_registry();
        let copies: Vec<Model> = reg
            .models
            .iter()
            .filter(|m| m.has_role(Role::Agent) || m.has_role(Role::Fim))
            .map(|m| {
                let mut u = m.clone();
                u.id = format!("{}-uncensored", m.id);
                u.uncensored = true;
                u.quality.coding += 20.0;
                u.quality.agentic += 20.0;
                u
            })
            .collect();
        reg.models.extend(copies);
        for (vram, ram) in [(0, 8), (0, 16), (6, 16), (8, 32), (12, 32), (16, 64), (16, 128), (24, 64), (32, 128)] {
            let r = recommend(&reg, &machine(vram, ram));
            let picked = r
                .primary
                .iter()
                .chain(r.alternatives.iter().map(|a| &a.candidate))
                .chain(r.autocomplete.iter())
                .chain(r.embedding.iter());
            for c in picked {
                assert!(!c.model_id.ends_with("-uncensored"), "{vram}/{ram}: recommended {}", c.model_id);
            }
            assert!(r.primary.is_some(), "{vram}/{ram}: the normal models still get recommended");
        }
    }

    #[test]
    fn every_variant_that_fits_gets_an_estimate() {
        let mut reg = test_registry();
        let mut variant = reg.models[0].clone();
        variant.id = "moe-30b-uncensored".into();
        variant.uncensored = true;
        reg.models.push(variant);
        let mut hw = machine(16, 64);
        hw.disk.as_mut().unwrap().free_bytes = GB; // Too little for any model: still estimated.
        let r = recommend(&reg, &hw);
        let fit = |id: &str, quant: &str| r.fits.iter().find(|c| c.model_id == id && c.quant == quant);
        for m in &reg.models {
            for v in &m.variants {
                assert!(fit(&m.id, &v.quant).is_some(), "{} {} has no estimate", m.id, v.quant);
            }
        }
        // Never recommended, but estimated like its original.
        assert_eq!(fit("moe-30b-uncensored", "Q4_K_M").map(|c| c.plan.placement), fit("moe-30b", "Q4_K_M").map(|c| c.plan.placement));
        // 63 GB of weights fit (slowly) in 64 GB of RAM, but not in 32 GB.
        let small = recommend(&reg, &machine(16, 32));
        assert!(small.fits.iter().all(|c| c.model_id != "big-moe-120b"));
        // Chat-only models are planned for chat, autocomplete models for autocomplete.
        assert!(fit("chat-only-14b", "Q4_K_M").is_some());
        assert!(fit("fim-1.5b", "Q8_0").is_some());
        // Embeddings are planned off the GPU, as recommended.
        assert_eq!(fit("embed-0.6b", "Q8_0").map(|c| c.plan.vram_bytes), Some(0));
    }

    #[test]
    fn autocomplete_too_big_for_the_gpu_runs_on_the_cpu() {
        // 4.7 GB of weights do not fit next to the desktop on a 4 GB card, and autocomplete must not split.
        let r = recommend(&test_registry(), &machine(4, 32));
        let fim = r.fits.iter().find(|c| c.model_id == "fim-7b" && c.quant == "Q4_K_M").expect("estimated");
        assert_eq!(fim.plan.placement, Placement::Cpu);
    }

    #[test]
    fn alternatives_are_distinct_models() {
        let r = recommend(&test_registry(), &machine(16, 64));
        let mut ids: Vec<_> = r.alternatives.iter().map(|a| a.candidate.model_id.clone()).collect();
        ids.push(r.primary.unwrap().model_id);
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn lighter_alternative_uses_much_less_memory() {
        let r = recommend(&test_registry(), &machine(16, 64));
        let p = r.primary.clone().unwrap();
        if let Some(l) = r.alternatives.iter().find(|a| a.kind == AlternativeKind::Lighter) {
            assert!((footprint(&l.candidate) as f64) <= footprint(&p) as f64 * 0.6);
        }
    }

    #[test]
    fn autocomplete_fits_next_to_primary() {
        let r = recommend(&test_registry(), &machine(16, 64));
        let p = r.primary.unwrap();
        let a = r.autocomplete.expect("fim model");
        assert!(p.plan.vram_bytes + a.plan.vram_bytes <= r.budget.vram_bytes);
        let e = r.embedding.expect("embedding model");
        assert_eq!(e.plan.placement, Placement::Cpu);
    }

    #[test]
    fn apple_silicon_uses_unified_memory() {
        let r = recommend(&test_registry(), &apple(64));
        let p = r.primary.unwrap();
        assert_eq!(p.plan.placement, Placement::Unified);
        assert!(r.budget.unified);
    }

    #[test]
    fn tiny_machine_still_gets_a_model_or_a_clear_notice() {
        let r = recommend(&test_registry(), &machine(0, 4));
        assert!(r.primary.is_some() || r.notices.iter().any(|n| n.code == ReasonCode::NothingFits));
    }

    #[test]
    fn low_disk_space_is_reported() {
        let mut hw = machine(16, 64);
        hw.disk.as_mut().unwrap().free_bytes = 16 << 30;
        let r = recommend(&test_registry(), &hw);
        if let Some(p) = &r.primary {
            assert!(p.download_bytes <= 16 << 30, "never recommend what cannot be downloaded");
        }
        assert!(r.notices.iter().any(|n| n.code == ReasonCode::LowDiskSpace));
    }

    #[test]
    fn reasons_explain_license_and_speed() {
        let r = recommend(&test_registry(), &machine(16, 64));
        let p = r.primary.unwrap();
        assert!(p.reasons.iter().any(|r| r.code == ReasonCode::SpeedEstimate));
        assert!(p.reasons.iter().any(|r| r.code == ReasonCode::PermissiveLicense));
    }
}
