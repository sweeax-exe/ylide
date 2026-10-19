//! Memory and speed estimation for running a GGUF model with llama.cpp.
//!
//! The numbers do not need to be exact; they need to be conservative enough that
//! a recommended configuration never fails to load, and accurate enough to rank
//! candidates. Formulas:
//!
//! * KV cache = attention layers x tokens x kv_heads x (head_dim_k + head_dim_v) x bytes/element
//!   (sliding-window layers only keep `window` tokens)
//! * compute buffers ~ 300 MiB + 1.5 % of the weights + 2 MiB per 1k context
//! * vision projector (when image input is on) = its file + 512 MiB for encoding one image
//! * decode speed ~ efficiency x bandwidth / bytes read per token (memory-bound)

use crate::schema::{Architecture, ArchitectureKind, Model, Variant};
use hardware::{Backend, GpuKind, GpuVendor, HardwareProfile};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

const GIB: u64 = 1 << 30;
const MIB: u64 = 1 << 20;

/// KV cache element type (`-ctk` / `-ctv` in llama.cpp).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum KvCacheType {
    F16,
    Q8_0,
    Q4_0,
}

impl KvCacheType {
    pub fn bytes_per_element(self) -> f64 {
        match self {
            Self::F16 => 2.0,
            Self::Q8_0 => 34.0 / 32.0,
            Self::Q4_0 => 18.0 / 32.0,
        }
    }

    pub fn llama_arg(self) -> &'static str {
        match self {
            Self::F16 => "f16",
            Self::Q8_0 => "q8_0",
            Self::Q4_0 => "q4_0",
        }
    }
}

/// KV cache size in bytes for `tokens` tokens of context.
pub fn kv_cache_bytes(arch: &Architecture, tokens: u64, kv: KvCacheType) -> u64 {
    let bpe = kv.bytes_per_element();
    if let Some(per_token_f16) = arch.kv_bytes_per_token_f16 {
        return (per_token_f16 as f64 * tokens as f64 * bpe / 2.0) as u64;
    }
    let attention_layers = arch.attention_layers.unwrap_or(arch.layers) as u64;
    let per_layer_token = arch.kv_heads as f64 * (arch.head_dim_k + arch.head_dim_v) as f64 * bpe;
    let (swa_layers, window) = match (arch.sliding_window, arch.sliding_window_layers) {
        (Some(w), Some(l)) => ((l as u64).min(attention_layers), w as u64),
        _ => (0, 0),
    };
    let full_layers = attention_layers - swa_layers;
    // llama.cpp keeps window + one ubatch of cells for SWA layers.
    let swa_tokens = tokens.min(window + SWA_UBATCH_SLACK);
    let kv = (per_layer_token * (full_layers * tokens + swa_layers * swa_tokens) as f64) as u64;
    kv + recurrent_state_bytes(arch)
}

const SWA_UBATCH_SLACK: u64 = 2048;

/// Constant state of recurrent (hybrid) layers for one sequence.
pub fn recurrent_state_bytes(arch: &Architecture) -> u64 {
    arch.recurrent_state_mib.map(|m| (m * MIB as f64) as u64).unwrap_or(0)
}

/// llama.cpp compute/scratch buffers (heuristic, errs on the high side).
pub fn compute_overhead_bytes(weights: u64, tokens: u64) -> u64 {
    300 * MIB + weights / 66 + tokens / 1024 * 2 * MIB
}

/// Images the runtime lets the projector turn into at most this many tokens
/// (llama-server `--image-max-tokens`), which also bounds its compute buffer.
pub const IMAGE_MAX_TOKENS: u32 = 2048;

/// Memory of a loaded vision projector (`--mmproj`): its weights plus the
/// buffer llama.cpp reserves to encode an image of [`IMAGE_MAX_TOKENS`].
/// It sits where the model computes: on the GPU, or in RAM without one.
pub fn projector_bytes(file_bytes: u64) -> u64 {
    if file_bytes == 0 { 0 } else { file_bytes + 512 * MIB }
}

/// Where the weights live.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum Placement {
    /// Everything on the dedicated GPU.
    Gpu,
    /// Attention/shared weights + KV on GPU, `cpu_expert_layers` layers' experts in RAM
    /// (`--n-cpu-moe`).
    #[serde(rename_all = "camelCase")]
    MoeOffload { cpu_expert_layers: u32 },
    /// Dense model split by layers (`-ngl gpu_layers`).
    #[serde(rename_all = "camelCase")]
    PartialOffload { gpu_layers: u32 },
    /// Apple Silicon / APU: weights in unified memory, computed on the GPU.
    Unified,
    /// CPU only.
    Cpu,
}

impl Placement {
    /// How much slower prompt processing is relative to full GPU (rough).
    pub fn prefill_factor(self) -> f64 {
        match self {
            Self::Gpu => 1.0,
            Self::MoeOffload { .. } => 0.75,
            Self::Unified => 0.6,
            Self::PartialOffload { .. } => 0.4,
            Self::Cpu => 0.2,
        }
    }
}

/// What the machine can offer to a model, derived from a [`HardwareProfile`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ComputeBudget {
    /// VRAM usable for one model on the primary discrete GPU (0 without dGPU).
    #[ts(type = "number")]
    pub vram_bytes: u64,
    pub gpu_bandwidth_gbps: f64,
    /// System RAM usable for model weights (OS and the IDE itself are reserved).
    #[ts(type = "number")]
    pub ram_bytes: u64,
    pub ram_bandwidth_gbps: f64,
    /// Unified memory machine; `unified_bytes` is the GPU working-set limit.
    pub unified: bool,
    #[ts(type = "number")]
    pub unified_bytes: u64,
    #[ts(type = "number | null")]
    pub disk_free_bytes: Option<u64>,
    pub backend: Backend,
    pub gpu_name: Option<String>,
}

/// Safety margin kept free on the GPU (llama.cpp's `--fit` margin). Desktop usage is
/// already excluded from the measured free VRAM.
pub const VRAM_RESERVE: u64 = GIB;
/// Reserved RAM for the OS, the IDE, language tooling and the user's other apps:
/// 20 % of the total, at least 3 GiB.
pub fn ram_reserve(total: u64) -> u64 {
    (total / 5).max(3 * GIB)
}

impl ComputeBudget {
    pub fn from_profile(hw: &HardwareProfile, hints: &[crate::schema::GpuHint]) -> Self {
        let gpu = hw.primary_gpu();
        let backend = hw.preferred_backends().first().copied().unwrap_or(Backend::Cpu);
        let ram_bytes = hw.memory.total_bytes.saturating_sub(ram_reserve(hw.memory.total_bytes));
        let hint = |name: &str| {
            let lower = name.to_lowercase();
            hints
                .iter()
                .filter(|h| lower.contains(&h.name_contains.to_lowercase()))
                .max_by_key(|h| h.name_contains.len())
                .map(|h| h.bandwidth_gbps)
        };

        let mut budget = ComputeBudget {
            vram_bytes: 0,
            gpu_bandwidth_gbps: 0.0,
            ram_bytes,
            ram_bandwidth_gbps: default_ram_bandwidth(hw),
            unified: false,
            unified_bytes: 0,
            disk_free_bytes: hw.disk.as_ref().map(|d| d.free_bytes),
            backend,
            gpu_name: gpu.map(|g| g.name.clone()),
        };

        match gpu {
            Some(g) if g.kind == GpuKind::Discrete && backend != Backend::Cpu => {
                budget.vram_bytes = g.usable_vram_bytes().saturating_sub(VRAM_RESERVE);
                budget.gpu_bandwidth_gbps =
                    hint(&g.name).unwrap_or_else(|| default_gpu_bandwidth(g.dedicated_vram_bytes));
            }
            Some(g) if g.kind == GpuKind::Integrated && g.vendor == GpuVendor::Apple && backend == Backend::Metal => {
                budget.unified = true;
                budget.unified_bytes = g.shared_memory_bytes.min(hw.memory.total_bytes).saturating_sub(2 * GIB);
                let bw = hint(&g.name).unwrap_or(100.0);
                budget.gpu_bandwidth_gbps = bw;
                budget.ram_bandwidth_gbps = bw;
            }
            _ => {}
        }
        budget
    }
}

/// Without a hint we guess by VRAM class (bandwidth correlates with bus width).
fn default_gpu_bandwidth(vram: u64) -> f64 {
    match vram / GIB {
        v if v >= 30 => 1000.0,
        v if v >= 22 => 850.0,
        v if v >= 15 => 550.0,
        v if v >= 11 => 400.0,
        v if v >= 7 => 280.0,
        _ => 180.0,
    }
}

/// Dual-channel DDR4 ~ 40-50 GB/s, DDR5 ~ 60-90 GB/s. Big core counts usually mean DDR5.
fn default_ram_bandwidth(hw: &HardwareProfile) -> f64 {
    if hw.cpu.features.avx512 || hw.cpu.logical_cores >= 24 {
        65.0
    } else {
        45.0
    }
}

/// Fully resolved memory/speed estimate for one model configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Plan {
    pub placement: Placement,
    pub context: u32,
    pub kv_cache_type: KvCacheType,
    #[ts(type = "number")]
    pub weights_bytes: u64,
    #[ts(type = "number")]
    pub kv_bytes: u64,
    #[ts(type = "number")]
    pub overhead_bytes: u64,
    /// Vision projector with its buffer (0 while image input is off).
    #[ts(type = "number")]
    pub projector_bytes: u64,
    /// Total that must fit on the GPU.
    #[ts(type = "number")]
    pub vram_bytes: u64,
    /// Total that must fit in system RAM.
    #[ts(type = "number")]
    pub ram_bytes: u64,
    pub est_tokens_per_sec: f64,
}

/// Fraction of peak bandwidth llama.cpp typically achieves during decode.
const GPU_EFFICIENCY: f64 = 0.6;
const CPU_EFFICIENCY: f64 = 0.45;
/// Per-token cost of handing activations between CPU and GPU in split setups.
const HYBRID_SYNC_SECONDS: f64 = 0.002;

/// Finds the fastest placement for `variant` at `context` tokens, if any fits.
pub fn plan(model: &Model, variant: &Variant, context: u32, kv: KvCacheType, budget: &ComputeBudget) -> Option<Plan> {
    plan_with_projector(model, variant, 0, context, kv, budget)
}

/// Like [`plan`], with a vision projector of `projector_file_bytes` loaded
/// next to the model (0 for none). It stays with the computation: on the GPU,
/// in unified memory, or in RAM when everything runs on the CPU.
pub fn plan_with_projector(
    model: &Model,
    variant: &Variant,
    projector_file_bytes: u64,
    context: u32,
    kv: KvCacheType,
    budget: &ComputeBudget,
) -> Option<Plan> {
    let arch = &model.architecture;
    let weights = variant.size_bytes();
    let kv_bytes = kv_cache_bytes(arch, context as u64, kv);
    // The projector is one more fixed block next to the KV cache and the buffers.
    let projector = projector_bytes(projector_file_bytes);
    let overhead = compute_overhead_bytes(weights, context as u64);
    let fixed = kv_bytes + overhead + projector;
    let active_ratio = (arch.params_active_b / arch.params_total_b.max(0.001)).clamp(0.0, 1.0);
    let active_bytes = weights as f64 * active_ratio;

    let make = |placement, vram, ram, tps| Plan {
        placement,
        context,
        kv_cache_type: kv,
        weights_bytes: weights,
        kv_bytes,
        overhead_bytes: overhead,
        projector_bytes: projector,
        vram_bytes: vram,
        ram_bytes: ram,
        est_tokens_per_sec: tps,
    };

    // 1. Unified memory (Apple Silicon): everything in the Metal working set.
    if budget.unified {
        let need = weights + fixed;
        if need <= budget.unified_bytes && need <= budget.ram_bytes + budget.unified_bytes / 4 {
            let tps = tokens_per_sec(active_bytes, 0.0, budget);
            return Some(make(Placement::Unified, 0, need, tps));
        }
    }

    if budget.vram_bytes > 0 {
        // 2. Everything on the GPU.
        let need = weights + fixed;
        if need <= budget.vram_bytes {
            let tps = tokens_per_sec(active_bytes, 0.0, budget);
            return Some(make(Placement::Gpu, need, 0, tps));
        }

        let gpu_fixed = fixed;
        if gpu_fixed < budget.vram_bytes {
            let free_for_weights = budget.vram_bytes - gpu_fixed;

            // 3. MoE: keep shared weights on the GPU, push expert layers to RAM.
            if arch.kind == ArchitectureKind::Moe {
                let expert_fraction = arch.expert_fraction.unwrap_or(0.9).clamp(0.0, 0.99);
                let expert_bytes = weights as f64 * expert_fraction;
                let shared_bytes = weights as f64 - expert_bytes;
                if shared_bytes < free_for_weights as f64 {
                    let experts_on_gpu = ((free_for_weights as f64 - shared_bytes) / expert_bytes).clamp(0.0, 1.0);
                    let cpu_fraction = 1.0 - experts_on_gpu;
                    let cpu_layers = (cpu_fraction * arch.layers as f64).ceil() as u32;
                    let cpu_fraction = cpu_layers as f64 / arch.layers as f64;
                    let ram_need = (expert_bytes * cpu_fraction) as u64;
                    if ram_need <= budget.ram_bytes {
                        // At least half of what a token reads is expert weights in every
                        // real MoE; this also guards against inconsistent registry data.
                        let active_expert = (active_bytes - shared_bytes).max(active_bytes * 0.5);
                        let active_shared = active_bytes - active_expert;
                        let tps = tokens_per_sec(
                            active_shared + active_expert * (1.0 - cpu_fraction),
                            active_expert * cpu_fraction,
                            budget,
                        );
                        let vram = gpu_fixed + (weights as f64 - expert_bytes * cpu_fraction) as u64;
                        return Some(make(
                            Placement::MoeOffload { cpu_expert_layers: cpu_layers },
                            vram,
                            ram_need,
                            tps,
                        ));
                    }
                }
            } else {
                // 4. Dense: split by layers.
                let gpu_fraction = (free_for_weights as f64 / weights as f64).clamp(0.0, 1.0);
                let gpu_layers = (gpu_fraction * arch.layers as f64).floor() as u32;
                let gpu_fraction = gpu_layers as f64 / arch.layers as f64;
                let ram_need = (weights as f64 * (1.0 - gpu_fraction)) as u64;
                if gpu_layers > 0 && ram_need <= budget.ram_bytes {
                    let tps = tokens_per_sec(active_bytes * gpu_fraction, active_bytes * (1.0 - gpu_fraction), budget);
                    let vram = gpu_fixed + (weights as f64 * gpu_fraction) as u64;
                    return Some(make(Placement::PartialOffload { gpu_layers }, vram, ram_need, tps));
                }
            }
        }
    }

    // 5. CPU only.
    let need = weights + fixed;
    if need <= budget.ram_bytes {
        let tps = tokens_per_sec(0.0, active_bytes, budget);
        return Some(make(Placement::Cpu, 0, need, tps));
    }
    None
}

/// How much of the model leaves the GPU (lower is better).
fn offload_rank(p: Placement) -> u8 {
    match p {
        Placement::Gpu | Placement::Unified => 0,
        Placement::MoeOffload { .. } => 1,
        Placement::PartialOffload { .. } => 2,
        Placement::Cpu => 3,
    }
}

/// The plan at `context` as the app starts it: an F16 KV cache, or q8_0
/// when the smaller cache keeps weights on the GPU that F16 would push to
/// the CPU (a dense model that fits completely only with it), or always
/// q8_0 when the user chose it (`force_q8`). Between MoE offloads of
/// different depth F16 stays: a lossy cache is the user's call there.
pub fn plan_at(model: &Model, variant: &Variant, projector_file_bytes: u64, context: u32, budget: &ComputeBudget, force_q8: bool) -> Option<Plan> {
    let q8 = plan_with_projector(model, variant, projector_file_bytes, context, KvCacheType::Q8_0, budget);
    if force_q8 {
        return q8;
    }
    match (plan_with_projector(model, variant, projector_file_bytes, context, KvCacheType::F16, budget), q8) {
        (Some(f16), Some(q8)) if offload_rank(q8.placement) < offload_rank(f16.placement) => Some(q8),
        (Some(f16), _) => Some(f16),
        (None, q8) => q8,
    }
}

/// Decode is memory-bound: time per token = bytes read / effective bandwidth.
fn tokens_per_sec(gpu_bytes: f64, cpu_bytes: f64, budget: &ComputeBudget) -> f64 {
    let mut seconds = 0.0;
    if gpu_bytes > 0.0 {
        seconds += gpu_bytes / 1e9 / (budget.gpu_bandwidth_gbps * GPU_EFFICIENCY);
    }
    if cpu_bytes > 0.0 {
        seconds += cpu_bytes / 1e9 / (budget.ram_bandwidth_gbps * CPU_EFFICIENCY);
    }
    if gpu_bytes > 0.0 && cpu_bytes > 0.0 {
        seconds += HYBRID_SYNC_SECONDS;
    }
    if seconds > 0.0 { 1.0 / seconds } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::*;
    use hardware::*;

    pub(crate) fn arch_qwen3_30b_a3b() -> Architecture {
        Architecture {
            kind: ArchitectureKind::Moe,
            params_total_b: 30.5,
            params_active_b: 3.3,
            layers: 48,
            attention_layers: None,
            kv_heads: 4,
            head_dim_k: 128,
            head_dim_v: 128,
            sliding_window: None,
            sliding_window_layers: None,
            kv_bytes_per_token_f16: None,
            expert_fraction: Some(0.92),
            recurrent_state_mib: None,
        }
    }

    #[test]
    fn kv_cache_matches_hand_calculation() {
        // 48 layers * 4 heads * (128+128) dims * 2 bytes = 98,304 bytes per token
        let arch = arch_qwen3_30b_a3b();
        assert_eq!(kv_cache_bytes(&arch, 1, KvCacheType::F16), 98_304);
        assert_eq!(kv_cache_bytes(&arch, 32_768, KvCacheType::F16), 98_304 * 32_768);
        // q8_0 is 34/32 bytes per element
        assert_eq!(kv_cache_bytes(&arch, 32, KvCacheType::Q8_0), (49_152.0 * 34.0 / 32.0 * 32.0) as u64);
    }

    #[test]
    fn sliding_window_layers_cap_tokens() {
        let mut arch = arch_qwen3_30b_a3b();
        arch.sliding_window = Some(4096);
        arch.sliding_window_layers = Some(24);
        let full = kv_cache_bytes(&arch_qwen3_30b_a3b(), 32_768, KvCacheType::F16);
        let swa = kv_cache_bytes(&arch, 32_768, KvCacheType::F16);
        // half the layers keep only window + ubatch slack (6144) of 32768 tokens
        let per_layer = full / 48;
        assert_eq!(swa, per_layer * 24 + per_layer * 24 * 6144 / 32768);
    }

    #[test]
    fn hybrid_model_kv_matches_measured_qwen3_6() {
        // Qwen3.6-35B-A3B: 10 of 40 layers attend, 2 KV heads x 256 -> 20 KiB/token at f16.
        let mut arch = arch_qwen3_30b_a3b();
        arch.layers = 40;
        arch.attention_layers = Some(10);
        arch.kv_heads = 2;
        arch.head_dim_k = 256;
        arch.head_dim_v = 256;
        assert_eq!(kv_cache_bytes(&arch, 1, KvCacheType::F16), 20_480);
        arch.recurrent_state_mib = Some(60.0);
        assert_eq!(kv_cache_bytes(&arch, 1, KvCacheType::F16), 20_480 + 60 * MIB);
    }

    #[test]
    fn hybrid_models_only_count_attention_layers() {
        let mut arch = arch_qwen3_30b_a3b();
        arch.attention_layers = Some(12);
        assert_eq!(
            kv_cache_bytes(&arch, 1000, KvCacheType::F16),
            kv_cache_bytes(&arch_qwen3_30b_a3b(), 1000, KvCacheType::F16) / 4
        );
    }

    #[test]
    fn explicit_override_wins() {
        let mut arch = arch_qwen3_30b_a3b();
        arch.kv_bytes_per_token_f16 = Some(70_000);
        assert_eq!(kv_cache_bytes(&arch, 10, KvCacheType::F16), 700_000);
        assert_eq!(kv_cache_bytes(&arch, 10, KvCacheType::Q4_0), (700_000.0 * 0.5625 / 2.0) as u64);
    }

    pub(crate) fn hw(vram_gib: u64, ram_gib: u64, cuda: bool) -> HardwareProfile {
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
                total_bytes: ram_gib * GIB,
                available_bytes: ram_gib * GIB / 2,
            },
            gpus: if vram_gib > 0 {
                vec![GpuInfo {
                    index: 0,
                    name: "Test GPU".into(),
                    vendor: GpuVendor::Nvidia,
                    vendor_id: 0x10de,
                    device_id: 0,
                    kind: GpuKind::Discrete,
                    dedicated_vram_bytes: vram_gib * GIB,
                    shared_memory_bytes: 0,
                    vram_budget_bytes: None,
                    vram_free_bytes: None,
                    compute_capability: None,
                }]
            } else {
                vec![]
            },
            acceleration: Acceleration {
                cuda_driver: cuda.then(|| "13.0".to_string()),
                vulkan: true,
                ..Acceleration::default()
            },
            disk: Some(DiskInfo {
                mount_point: "D:\\".into(),
                total_bytes: 1000 * GIB,
                free_bytes: 500 * GIB,
            }),
            probed_at_unix_ms: 0,
            warnings: vec![],
        }
    }

    #[test]
    fn budget_reserves_memory() {
        let b = ComputeBudget::from_profile(&hw(16, 64, true), &[]);
        // no measured free VRAM in the fixture: dedicated minus desktop allowance minus margin
        assert_eq!(b.vram_bytes, 16 * GIB - hardware::UNMEASURED_DESKTOP_VRAM - VRAM_RESERVE);
        assert_eq!(b.ram_bytes, 64 * GIB - 64 * GIB / 5);
        let small = ComputeBudget::from_profile(&hw(0, 8, false), &[]);
        assert_eq!(small.ram_bytes, 5 * GIB, "small machines keep at least 3 GiB for the OS");
        assert_eq!(b.backend, Backend::Cuda);
        let none = ComputeBudget::from_profile(&hw(0, 16, false), &[]);
        assert_eq!(none.vram_bytes, 0);
        assert_eq!(none.backend, Backend::Cpu);
    }

    #[test]
    fn placement_fields_are_camel_case_in_json() {
        let v = serde_json::to_value(Placement::MoeOffload { cpu_expert_layers: 3 }).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "moeOffload", "cpuExpertLayers": 3}));
        let v = serde_json::to_value(Placement::PartialOffload { gpu_layers: 7 }).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "partialOffload", "gpuLayers": 7}));
    }

    #[test]
    fn a_projector_takes_its_memory_where_the_model_computes() {
        let reg = crate::bundled();
        let model = reg.models.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap();
        let variant = model.variants.iter().find(|v| v.quant == "UD-IQ4_XS").unwrap();
        let projector = model.projector.as_ref().unwrap().size_bytes;
        assert_eq!(projector_bytes(0), 0);
        assert_eq!(projector_bytes(projector), projector + 512 * MIB);

        // 16 GB GPU: the MoE model is split; the projector moves more experts to RAM.
        let budget = ComputeBudget::from_profile(&hw(16, 64, true), &[]);
        let without = plan(model, variant, 65_536, KvCacheType::F16, &budget).unwrap();
        let with = plan_with_projector(model, variant, projector, 65_536, KvCacheType::F16, &budget).unwrap();
        assert_eq!(without.projector_bytes, 0);
        assert_eq!(with.projector_bytes, projector_bytes(projector));
        let layers = |p: &Plan| match p.placement {
            Placement::MoeOffload { cpu_expert_layers } => cpu_expert_layers,
            other => panic!("{other:?}"),
        };
        assert!(layers(&with) > layers(&without), "{} vs {}", layers(&with), layers(&without));
        assert!(with.vram_bytes <= budget.vram_bytes && with.ram_bytes > without.ram_bytes);

        // Room to spare: everything stays on the GPU, the projector included.
        let big = ComputeBudget::from_profile(&hw(48, 64, true), &[]);
        let without = plan(model, variant, 32_768, KvCacheType::F16, &big).unwrap();
        let with = plan_with_projector(model, variant, projector, 32_768, KvCacheType::F16, &big).unwrap();
        assert_eq!((with.placement, without.placement), (Placement::Gpu, Placement::Gpu));
        assert_eq!(with.vram_bytes, without.vram_bytes + projector_bytes(projector));

        // No GPU: it needs RAM instead.
        let cpu = ComputeBudget::from_profile(&hw(0, 64, false), &[]);
        let without = plan(model, variant, 32_768, KvCacheType::F16, &cpu).unwrap();
        let with = plan_with_projector(model, variant, projector, 32_768, KvCacheType::F16, &cpu).unwrap();
        assert_eq!(with.placement, Placement::Cpu);
        assert_eq!((with.ram_bytes, with.vram_bytes), (without.ram_bytes + projector_bytes(projector), 0));
    }

    #[test]
    fn the_kv_cache_is_compressed_only_where_it_keeps_the_model_on_the_gpu() {
        let reg = crate::bundled();
        let budget = ComputeBudget::from_profile(&hw(16, 64, true), &[]);
        // Qwen3.8 27B GSQ IQ3_XXS at 64K: F16 needs CPU layers, q8_0 fits the GPU.
        let gsq = reg.models.iter().find(|m| m.id == "qwen3.8-27b-gsq").unwrap();
        let v = gsq.variants.iter().find(|v| v.quant == "GSQ-RCO-IQ3_XXS").unwrap();
        let f16 = plan(gsq, v, 65_536, KvCacheType::F16, &budget).unwrap();
        assert!(matches!(f16.placement, Placement::PartialOffload { .. }), "{f16:?}");
        let p = plan_at(gsq, v, 0, 65_536, &budget, false).unwrap();
        assert_eq!((p.placement, p.kv_cache_type), (Placement::Gpu, KvCacheType::Q8_0));
        // The MoE default at 128K offloads experts either way: F16 stays.
        let moe = reg.models.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap();
        let v = moe.variants.iter().find(|v| v.quant == "UD-IQ4_XS").unwrap();
        let p = plan_at(moe, v, 0, 131_072, &budget, false).unwrap();
        assert_eq!(p.kv_cache_type, KvCacheType::F16);
        assert!(matches!(p.placement, Placement::MoeOffload { .. }));
        // The user's choice wins.
        assert_eq!(plan_at(moe, v, 0, 131_072, &budget, true).unwrap().kv_cache_type, KvCacheType::Q8_0);
    }

    #[test]
    fn gpu_hint_overrides_bandwidth() {
        let hints = vec![
            GpuHint {
                name_contains: "test".into(),
                bandwidth_gbps: 123.0,
            },
            GpuHint {
                name_contains: "test gpu".into(),
                bandwidth_gbps: 896.0,
            },
        ];
        let b = ComputeBudget::from_profile(&hw(16, 64, true), &hints);
        assert_eq!(b.gpu_bandwidth_gbps, 896.0, "longest match wins");
    }
}
