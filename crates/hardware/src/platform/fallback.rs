//! Unsupported platforms: CPU-only inference, no GPU information.

use crate::{Acceleration, GpuInfo, PlatformProbe};

pub(crate) struct FallbackProbe;

impl PlatformProbe for FallbackProbe {
    fn gpus(&self, warnings: &mut Vec<String>) -> Vec<GpuInfo> {
        warnings.push("platform_gpu_probe_unsupported".into());
        Vec::new()
    }

    fn acceleration(&self, _gpus: &[GpuInfo]) -> Acceleration {
        Acceleration::default()
    }
}
