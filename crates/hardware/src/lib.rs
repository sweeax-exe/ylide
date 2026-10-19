//! Hardware detection for choosing and running local LLMs.
//!
//! The crate is split into a portable part (CPU, RAM, disk via `sysinfo`)
//! and a platform part (`platform::*`) that knows how to enumerate GPUs and
//! detect acceleration backends on each operating system. Adding a platform
//! means implementing [`PlatformProbe`] in a new module; nothing else changes.

mod memory;
mod platform;
mod topology;
mod types;

pub use memory::{MemoryModule, RamSpeedTip, memory_modules, parse_smbios, ram_speed_tip, rated_mts_from_part};
pub use topology::{CacheGroup, CpuTopology, cpu_mask, cpu_topology, parse_processor_information};
pub use types::*;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// OS specific probing. One implementation per supported platform.
pub(crate) trait PlatformProbe {
    /// Enumerates GPUs. Problems are reported through `warnings`, never by panicking.
    fn gpus(&self, warnings: &mut Vec<String>) -> Vec<GpuInfo>;
    /// Detects which acceleration runtimes are installed.
    fn acceleration(&self, gpus: &[GpuInfo]) -> Acceleration;
}

/// Probes the machine. `model_dir` is the directory models will be stored in;
/// its disk is reported so the UI can warn about insufficient free space.
///
/// Probing is synchronous and takes ~50-300 ms; call it from a blocking task.
pub fn probe(model_dir: Option<&Path>) -> HardwareProfile {
    let platform = platform::current();
    let mut warnings = Vec::new();

    let mut gpus = platform.gpus(&mut warnings);
    gpus.sort_by_key(|g| g.index);
    let acceleration = platform.acceleration(&gpus);

    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    let logical = sys.cpus().len() as u32;
    let cpu = CpuInfo {
        brand: sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .unwrap_or_default(),
        physical_cores: sysinfo::System::physical_core_count()
            .map(|c| c as u32)
            .unwrap_or(logical),
        logical_cores: logical,
        features: cpu_features(),
    };

    let memory = MemoryInfo {
        total_bytes: sys.total_memory(),
        available_bytes: sys.available_memory(),
    };

    let disk = model_dir.and_then(disk_for_path);
    if model_dir.is_some() && disk.is_none() {
        warnings.push("disk_unknown".into());
    }

    HardwareProfile {
        os: OsInfo {
            family: std::env::consts::OS.to_string(),
            version: sysinfo::System::long_os_version().unwrap_or_default(),
            arch: std::env::consts::ARCH.to_string(),
        },
        cpu,
        memory,
        gpus,
        acceleration,
        disk,
        probed_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        warnings,
    }
}

/// RAM available right now (free plus reclaimable cache), without a full probe.
pub fn available_memory() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.available_memory()
}

fn cpu_features() -> CpuFeatures {
    #[cfg(target_arch = "x86_64")]
    {
        CpuFeatures {
            avx2: std::arch::is_x86_feature_detected!("avx2"),
            avx512: std::arch::is_x86_feature_detected!("avx512f"),
            fma: std::arch::is_x86_feature_detected!("fma"),
            neon: false,
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
        CpuFeatures {
            neon: std::arch::is_aarch64_feature_detected!("neon"),
            ..CpuFeatures::default()
        }
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        CpuFeatures::default()
    }
}

/// Finds the disk whose mount point is the longest prefix of `path`.
/// Works for paths that do not exist yet by walking up to an existing ancestor.
pub fn disk_for_path(path: &Path) -> Option<DiskInfo> {
    let existing = existing_ancestor(path)?;
    let target = normalize_for_compare(&existing);
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| {
            let mount = normalize_for_compare(d.mount_point());
            target.starts_with(&mount)
        })
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| DiskInfo {
            mount_point: d.mount_point().display().to_string(),
            total_bytes: d.total_space(),
            free_bytes: d.available_space(),
        })
}

fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(p) = current {
        if let Ok(canonical) = p.canonicalize() {
            return Some(canonical);
        }
        current = p.parent();
    }
    None
}

/// Strips Windows verbatim prefixes and lower-cases on case-insensitive systems
/// so that `\\?\D:\Models` matches the mount point `D:\`.
fn normalize_for_compare(path: &Path) -> String {
    let s = path.display().to_string();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).replace('\\', "/");
    if cfg!(any(windows, target_os = "macos")) {
        s.to_lowercase()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(index: u32, vendor: GpuVendor, kind: GpuKind, vram_gib: u64) -> GpuInfo {
        GpuInfo {
            index,
            name: format!("gpu{index}"),
            vendor,
            vendor_id: 0,
            device_id: 0,
            kind,
            dedicated_vram_bytes: vram_gib << 30,
            shared_memory_bytes: 16 << 30,
            vram_budget_bytes: None,
            vram_free_bytes: None,
            compute_capability: None,
        }
    }

    fn profile(gpus: Vec<GpuInfo>, acceleration: Acceleration) -> HardwareProfile {
        HardwareProfile {
            os: OsInfo {
                family: "windows".into(),
                version: String::new(),
                arch: "x86_64".into(),
            },
            cpu: CpuInfo {
                brand: "cpu".into(),
                physical_cores: 8,
                logical_cores: 16,
                features: CpuFeatures::default(),
            },
            memory: MemoryInfo {
                total_bytes: 32 << 30,
                available_bytes: 20 << 30,
            },
            gpus,
            acceleration,
            disk: None,
            probed_at_unix_ms: 0,
            warnings: vec![],
        }
    }

    #[test]
    fn vendor_from_pci_id() {
        assert_eq!(GpuVendor::from_pci_id(0x10de), GpuVendor::Nvidia);
        assert_eq!(GpuVendor::from_pci_id(0x1002), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_pci_id(0x8086), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_pci_id(0x1414), GpuVendor::Microsoft);
        assert_eq!(GpuVendor::from_pci_id(0xdead), GpuVendor::Other);
    }

    #[test]
    fn primary_gpu_prefers_largest_discrete_over_igpu() {
        let p = profile(
            vec![
                gpu(0, GpuVendor::Amd, GpuKind::Integrated, 2),
                gpu(1, GpuVendor::Nvidia, GpuKind::Discrete, 8),
                gpu(2, GpuVendor::Nvidia, GpuKind::Discrete, 16),
                gpu(3, GpuVendor::Microsoft, GpuKind::Software, 0),
            ],
            Acceleration::default(),
        );
        assert_eq!(p.primary_gpu().unwrap().index, 2);
        assert!(!p.has_unified_memory());
    }

    #[test]
    fn integrated_only_means_unified_memory() {
        let p = profile(
            vec![gpu(0, GpuVendor::Apple, GpuKind::Integrated, 0)],
            Acceleration {
                metal: true,
                ..Acceleration::default()
            },
        );
        assert!(p.has_unified_memory());
        assert_eq!(p.preferred_backends(), vec![Backend::Metal, Backend::Cpu]);
    }

    #[test]
    fn usable_vram_prefers_measured_free_memory() {
        let mut g = gpu(0, GpuVendor::Nvidia, GpuKind::Discrete, 16);
        assert_eq!(g.usable_vram_bytes(), (16 << 30) - UNMEASURED_DESKTOP_VRAM);
        g.vram_budget_bytes = Some(15 << 30);
        assert_eq!(g.usable_vram_bytes(), (16 << 30) - UNMEASURED_DESKTOP_VRAM, "the DXGI budget is not free memory");
        g.vram_free_bytes = Some(13 << 30);
        assert_eq!(g.usable_vram_bytes(), 13 << 30);
        let igpu = gpu(1, GpuVendor::Amd, GpuKind::Integrated, 2);
        assert_eq!(igpu.usable_vram_bytes(), 0);
    }

    #[test]
    fn backend_preference_nvidia() {
        let with_cuda = profile(
            vec![gpu(0, GpuVendor::Nvidia, GpuKind::Discrete, 12)],
            Acceleration {
                cuda_driver: Some("13.0".into()),
                vulkan: true,
                ..Acceleration::default()
            },
        );
        assert_eq!(
            with_cuda.preferred_backends(),
            vec![Backend::Cuda, Backend::Vulkan, Backend::Cpu]
        );
        let without_driver = profile(
            vec![gpu(0, GpuVendor::Nvidia, GpuKind::Discrete, 12)],
            Acceleration {
                vulkan: true,
                ..Acceleration::default()
            },
        );
        assert_eq!(without_driver.preferred_backends(), vec![Backend::Vulkan, Backend::Cpu]);
    }

    #[test]
    fn no_gpu_falls_back_to_cpu() {
        let p = profile(vec![], Acceleration::default());
        assert!(p.primary_gpu().is_none());
        assert_eq!(p.preferred_backends(), vec![Backend::Cpu]);
    }

    #[test]
    fn profile_serializes_camel_case() {
        let p = profile(vec![gpu(0, GpuVendor::Nvidia, GpuKind::Discrete, 16)], Acceleration::default());
        let json = serde_json::to_value(&p).unwrap();
        assert!(json["gpus"][0]["dedicatedVramBytes"].is_u64());
        assert_eq!(json["gpus"][0]["vendor"], "nvidia");
        assert_eq!(json["gpus"][0]["kind"], "discrete");
    }

    #[test]
    fn normalizes_windows_verbatim_paths() {
        if cfg!(windows) {
            assert_eq!(normalize_for_compare(Path::new(r"\\?\D:\Models\x")), "d:/models/x");
            assert!(normalize_for_compare(Path::new(r"\\?\D:\Models")).starts_with(&normalize_for_compare(Path::new(r"D:\"))));
        }
    }

    #[test]
    fn real_probe_does_not_panic() {
        let dir = std::env::temp_dir();
        let p = probe(Some(&dir));
        assert!(p.cpu.logical_cores > 0);
        assert!(p.memory.total_bytes > 0);
        assert!(p.disk.is_some(), "temp dir disk should resolve: {:?}", p.warnings);
    }
}
