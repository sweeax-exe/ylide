//! Linux: NVML for NVIDIA (the proprietary driver exposes no VRAM in sysfs),
//! DRM sysfs (`/sys/class/drm/cardN/device`) for AMD and Intel.

use super::{cuda_driver_version, library_loadable, nvml};
use crate::{Acceleration, GpuInfo, GpuKind, GpuVendor, PlatformProbe};
use std::fs;
use std::path::Path;

pub(crate) struct LinuxProbe;

impl PlatformProbe for LinuxProbe {
    fn gpus(&self, warnings: &mut Vec<String>) -> Vec<GpuInfo> {
        let mut gpus = Vec::new();
        let nvidia = nvml::devices("libnvidia-ml.so.1");
        if let Some(devices) = &nvidia {
            for (i, d) in devices.iter().enumerate() {
                gpus.push(GpuInfo {
                    index: i as u32,
                    name: d.name.clone(),
                    vendor: GpuVendor::Nvidia,
                    vendor_id: 0x10de,
                    device_id: d.pci_device_id.map(|id| id >> 16).unwrap_or(0),
                    kind: GpuKind::Discrete,
                    dedicated_vram_bytes: d.total_bytes,
                    shared_memory_bytes: 0,
                    vram_budget_bytes: Some(d.free_bytes + d.used_bytes),
                    vram_free_bytes: Some(d.free_bytes),
                    compute_capability: d.compute_capability.map(|(a, b)| format!("{a}.{b}")),
                });
            }
        }

        let Ok(entries) = fs::read_dir("/sys/class/drm") else {
            warnings.push("drm_sysfs_unavailable".into());
            return gpus;
        };
        let mut cards: Vec<_> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let n: u32 = name.strip_prefix("card")?.parse().ok()?;
                Some((n, e.path()))
            })
            .collect();
        cards.sort_by_key(|(n, _)| *n);

        for (n, path) in cards {
            let device = path.join("device");
            let Some(vendor_id) = read_hex(&device.join("vendor")) else { continue };
            let vendor = GpuVendor::from_pci_id(vendor_id);
            if vendor == GpuVendor::Nvidia && nvidia.is_some() {
                continue; // already reported by NVML
            }
            let device_id = read_hex(&device.join("device")).unwrap_or(0);
            let vram_total = read_u64(&device.join("mem_info_vram_total"));
            let vram_used = read_u64(&device.join("mem_info_vram_used"));
            let kind = classify(vendor, device_id, vram_total);
            if vram_total.is_none() && kind == GpuKind::Discrete {
                warnings.push(format!("vram_unknown: card{n}"));
            }
            let name = fs::read_to_string(device.join("product_name"))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("{vendor:?} GPU {device_id:#06x}"));
            gpus.push(GpuInfo {
                index: 100 + n,
                name,
                vendor,
                vendor_id,
                device_id,
                kind,
                dedicated_vram_bytes: vram_total.unwrap_or(0),
                shared_memory_bytes: 0,
                vram_budget_bytes: if kind == GpuKind::Discrete { vram_total } else { None },
                vram_free_bytes: match (kind, vram_total, vram_used) {
                    (GpuKind::Discrete, Some(t), Some(u)) => Some(t.saturating_sub(u)),
                    _ => None,
                },
                compute_capability: None,
            });
        }
        gpus
    }

    fn acceleration(&self, gpus: &[GpuInfo]) -> Acceleration {
        let has_nvidia = gpus.iter().any(|g| g.vendor == GpuVendor::Nvidia);
        Acceleration {
            cuda_driver: if has_nvidia { cuda_driver_version("libcuda.so.1") } else { None },
            vulkan: library_loadable("libvulkan.so.1"),
            directml: false,
            metal: false,
            rocm: Path::new("/opt/rocm").exists() || library_loadable("libamdhip64.so"),
        }
    }
}

/// AMD APUs report a small VRAM carve-out; Intel Arc dGPUs use known PCI id ranges.
fn classify(vendor: GpuVendor, device_id: u32, vram_total: Option<u64>) -> GpuKind {
    match vendor {
        GpuVendor::Amd => match vram_total {
            Some(v) if v >= 3 << 30 => GpuKind::Discrete,
            _ => GpuKind::Integrated,
        },
        GpuVendor::Intel => {
            let family = device_id & 0xff00;
            if family == 0x5600 || family == 0xe200 || vram_total.is_some_and(|v| v >= 3 << 30) {
                GpuKind::Discrete
            } else {
                GpuKind::Integrated
            }
        }
        GpuVendor::Nvidia => GpuKind::Discrete,
        _ => GpuKind::Integrated,
    }
}

fn read_hex(path: &Path) -> Option<u32> {
    let s = fs::read_to_string(path).ok()?;
    u32::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok()
}

fn read_u64(path: &Path) -> Option<u64> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_amd_by_vram() {
        assert_eq!(classify(GpuVendor::Amd, 0x744c, Some(24 << 30)), GpuKind::Discrete);
        assert_eq!(classify(GpuVendor::Amd, 0x15bf, Some(512 << 20)), GpuKind::Integrated);
    }

    #[test]
    fn classifies_intel_arc_by_id() {
        assert_eq!(classify(GpuVendor::Intel, 0x56a0, None), GpuKind::Discrete);
        assert_eq!(classify(GpuVendor::Intel, 0xe20b, None), GpuKind::Discrete);
        assert_eq!(classify(GpuVendor::Intel, 0x46a6, None), GpuKind::Integrated);
    }
}
