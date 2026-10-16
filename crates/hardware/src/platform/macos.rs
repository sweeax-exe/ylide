//! macOS: Apple Silicon has one GPU sharing unified memory with the CPU.
//!
//! Metal limits how much memory a process may wire for the GPU
//! (`recommendedMaxWorkingSetSize`). Without linking Metal we use Apple's
//! documented behaviour: about 2/3 of RAM up to 36 GB, about 3/4 above.
//! The port phase replaces this estimate with the real Metal query.

use crate::{Acceleration, GpuInfo, GpuKind, GpuVendor, PlatformProbe};

pub(crate) struct MacProbe;

impl PlatformProbe for MacProbe {
    fn gpus(&self, warnings: &mut Vec<String>) -> Vec<GpuInfo> {
        if !cfg!(target_arch = "aarch64") {
            warnings.push("intel_mac_gpu_not_supported".into());
            return Vec::new();
        }
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        sys.refresh_cpu_all();
        let chip = sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Apple Silicon".into());
        vec![GpuInfo {
            index: 0,
            name: format!("{chip} GPU"),
            vendor: GpuVendor::Apple,
            vendor_id: 0x106b,
            device_id: 0,
            kind: GpuKind::Integrated,
            dedicated_vram_bytes: 0,
            shared_memory_bytes: metal_working_set_estimate(sys.total_memory()),
            vram_budget_bytes: None,
            vram_free_bytes: None,
            compute_capability: None,
        }]
    }

    fn acceleration(&self, _gpus: &[GpuInfo]) -> Acceleration {
        Acceleration {
            metal: cfg!(target_arch = "aarch64"),
            ..Acceleration::default()
        }
    }
}

pub(crate) fn metal_working_set_estimate(total_ram: u64) -> u64 {
    if total_ram <= 36 << 30 {
        total_ram / 3 * 2
    } else {
        total_ram / 4 * 3
    }
}
