//! Plain data types describing the machine. They are serialised to the UI
//! (camelCase) and exported as TypeScript via `ts-rs`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Everything the recommender needs to know about the machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HardwareProfile {
    pub os: OsInfo,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub gpus: Vec<GpuInfo>,
    pub acceleration: Acceleration,
    /// Disk that holds the model directory, if it could be resolved.
    pub disk: Option<DiskInfo>,
    #[ts(type = "number")]
    pub probed_at_unix_ms: u64,
    /// Non-fatal problems encountered while probing (shown in the UI).
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OsInfo {
    /// `windows`, `macos` or `linux`.
    pub family: String,
    /// Human readable version, e.g. "Windows 11 Pro 26200".
    pub version: String,
    /// `x86_64`, `aarch64`, ...
    pub arch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CpuInfo {
    pub brand: String,
    pub physical_cores: u32,
    pub logical_cores: u32,
    pub features: CpuFeatures,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CpuFeatures {
    pub avx2: bool,
    pub avx512: bool,
    pub fma: bool,
    pub neon: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemoryInfo {
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub available_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiskInfo {
    /// Mount point / drive that contains the probed path.
    pub mount_point: String,
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub free_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Qualcomm,
    Microsoft,
    Other,
}

impl GpuVendor {
    /// Maps a PCI vendor id to a vendor.
    pub fn from_pci_id(id: u32) -> Self {
        match id {
            0x10de => Self::Nvidia,
            0x1002 | 0x1022 => Self::Amd,
            0x8086 | 0x8087 => Self::Intel,
            0x106b => Self::Apple,
            0x5143 | 0x4d4f_4351 => Self::Qualcomm,
            0x1414 => Self::Microsoft,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum GpuKind {
    /// Own VRAM (desktop/laptop dGPU).
    Discrete,
    /// Shares system memory (iGPU, Apple Silicon).
    Integrated,
    /// Software rasteriser such as "Microsoft Basic Render Driver".
    Software,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GpuInfo {
    /// Stable index in enumeration order of the platform API.
    pub index: u32,
    pub name: String,
    pub vendor: GpuVendor,
    pub vendor_id: u32,
    pub device_id: u32,
    pub kind: GpuKind,
    /// Dedicated VRAM. For integrated GPUs this is the (small) carve-out.
    #[ts(type = "number")]
    pub dedicated_vram_bytes: u64,
    /// System memory the GPU may borrow.
    #[ts(type = "number")]
    pub shared_memory_bytes: u64,
    /// Per-process budget reported by the OS (DXGI). Informational: it is larger
    /// than what is actually free when other programs (the desktop) use VRAM.
    #[ts(type = "number | null")]
    pub vram_budget_bytes: Option<u64>,
    /// VRAM free right now across all processes (NVML / sysfs), if known.
    #[ts(type = "number | null")]
    pub vram_free_bytes: Option<u64>,
    /// CUDA compute capability such as "12.0" (NVIDIA only).
    pub compute_capability: Option<String>,
}

/// Assumed desktop/compositor usage when free VRAM cannot be measured.
pub const UNMEASURED_DESKTOP_VRAM: u64 = 1536 << 20;

impl GpuInfo {
    /// Memory a model can realistically occupy on this GPU right now.
    ///
    /// * discrete: measured free VRAM, or dedicated VRAM minus a desktop allowance
    /// * integrated: unified memory is accounted for as system RAM instead
    pub fn usable_vram_bytes(&self) -> u64 {
        match self.kind {
            GpuKind::Discrete => match self.vram_free_bytes {
                Some(free) => free.min(self.dedicated_vram_bytes),
                None => self.dedicated_vram_bytes.saturating_sub(UNMEASURED_DESKTOP_VRAM),
            },
            GpuKind::Integrated | GpuKind::Software => 0,
        }
    }
}

/// Inference backends that llama.cpp can use on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Acceleration {
    /// CUDA driver API version (e.g. "13.3") when an NVIDIA driver is installed.
    pub cuda_driver: Option<String>,
    /// A Vulkan loader is installed.
    pub vulkan: bool,
    /// DirectML is available (Windows 10 1903+).
    pub directml: bool,
    /// Metal is available (macOS).
    pub metal: bool,
    /// ROCm/HIP runtime found (AMD).
    pub rocm: bool,
}

/// llama.cpp backend flavours the app knows how to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Backend {
    Cuda,
    Vulkan,
    Metal,
    Rocm,
    Cpu,
}

impl HardwareProfile {
    /// The GPU a model should be placed on: the discrete GPU with the most
    /// usable VRAM, otherwise the first integrated GPU.
    pub fn primary_gpu(&self) -> Option<&GpuInfo> {
        let discrete = self
            .gpus
            .iter()
            .filter(|g| g.kind == GpuKind::Discrete)
            .max_by_key(|g| g.usable_vram_bytes());
        discrete.or_else(|| self.gpus.iter().find(|g| g.kind == GpuKind::Integrated))
    }

    /// True if the machine has unified memory (Apple Silicon or an APU without dGPU).
    pub fn has_unified_memory(&self) -> bool {
        matches!(self.primary_gpu(), Some(g) if g.kind == GpuKind::Integrated)
    }

    /// Backends in order of preference for the primary GPU.
    pub fn preferred_backends(&self) -> Vec<Backend> {
        let mut out = Vec::new();
        if let Some(gpu) = self.primary_gpu() {
            match gpu.vendor {
                GpuVendor::Nvidia if self.acceleration.cuda_driver.is_some() => out.push(Backend::Cuda),
                GpuVendor::Apple if self.acceleration.metal => out.push(Backend::Metal),
                GpuVendor::Amd if self.acceleration.rocm => out.push(Backend::Rocm),
                _ => {}
            }
            if self.acceleration.vulkan && gpu.vendor != GpuVendor::Apple {
                out.push(Backend::Vulkan);
            }
        }
        out.push(Backend::Cpu);
        out
    }
}
