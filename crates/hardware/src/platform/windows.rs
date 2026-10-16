//! Windows: DXGI for enumeration and VRAM size, D3D12 for UMA (integrated)
//! detection, NVML for free VRAM and compute capability on NVIDIA, the CUDA
//! driver API for the driver version, DLL presence for Vulkan/DirectML.
//!
//! DXGI's `QueryVideoMemoryInfo().Budget` is a per-process budget and overstates
//! what is free while the desktop uses the same GPU, so it is only informational.

use super::{cuda_driver_version, library_loadable, nvml};
use crate::{Acceleration, GpuInfo, GpuKind, GpuVendor, PlatformProbe};
use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
use windows::Win32::Graphics::Direct3D12::{
    D3D12_FEATURE_ARCHITECTURE, D3D12_FEATURE_DATA_ARCHITECTURE, D3D12CreateDevice, ID3D12Device,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_DESC1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND,
    DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO, IDXGIAdapter1, IDXGIAdapter3,
    IDXGIFactory1,
};
use windows::core::Interface;

pub(crate) struct WindowsProbe;

impl PlatformProbe for WindowsProbe {
    fn gpus(&self, warnings: &mut Vec<String>) -> Vec<GpuInfo> {
        match enumerate_adapters() {
            Ok(mut gpus) => {
                if gpus.iter().any(|g| g.vendor == GpuVendor::Nvidia) {
                    enrich_from_nvml(&mut gpus);
                }
                gpus
            }
            Err(e) => {
                tracing::warn!("DXGI enumeration failed: {e}");
                warnings.push(format!("gpu_enumeration_failed: {e}"));
                Vec::new()
            }
        }
    }

    fn acceleration(&self, gpus: &[GpuInfo]) -> Acceleration {
        let has_nvidia = gpus.iter().any(|g| g.vendor == GpuVendor::Nvidia);
        Acceleration {
            cuda_driver: if has_nvidia { cuda_driver_version("nvcuda.dll") } else { None },
            vulkan: library_loadable("vulkan-1.dll"),
            directml: system32_has("DirectML.dll"),
            metal: false,
            rocm: std::env::var_os("HIP_PATH").is_some(),
        }
    }
}

fn enumerate_adapters() -> windows::core::Result<Vec<GpuInfo>> {
    // SAFETY: plain COM calls on interfaces owned by this function.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut out = Vec::new();
        let mut index = 0u32;
        loop {
            let adapter = match factory.EnumAdapters1(index) {
                Ok(a) => a,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(e),
            };
            let desc = adapter.GetDesc1()?;
            out.push(describe(index, &adapter, &desc));
            index += 1;
        }
        Ok(dedupe(out))
    }
}

/// # Safety
/// `adapter` must be a valid adapter returned by `EnumAdapters1`.
unsafe fn describe(index: u32, adapter: &IDXGIAdapter1, desc: &DXGI_ADAPTER_DESC1) -> GpuInfo {
    let name = String::from_utf16_lossy(&desc.Description)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    let vendor = GpuVendor::from_pci_id(desc.VendorId);
    let software = (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 || vendor == GpuVendor::Microsoft;

    let kind = if software {
        GpuKind::Software
    } else if unsafe { is_uma(adapter) }.unwrap_or(desc.DedicatedVideoMemory < (1 << 30)) {
        GpuKind::Integrated
    } else {
        GpuKind::Discrete
    };

    // The "local" segment budget is only meaningful for discrete GPUs; for UMA
    // devices it reports a share of system RAM.
    let budget = match (kind, unsafe { local_memory_info(adapter) }) {
        (GpuKind::Discrete, Some(info)) => Some(info.Budget),
        _ => None,
    };

    GpuInfo {
        index,
        name,
        vendor,
        vendor_id: desc.VendorId,
        device_id: desc.DeviceId,
        kind,
        dedicated_vram_bytes: desc.DedicatedVideoMemory as u64,
        shared_memory_bytes: desc.SharedSystemMemory as u64,
        vram_budget_bytes: budget,
        vram_free_bytes: None,
        compute_capability: None,
    }
}

/// Adds measured free VRAM and compute capability from NVML (System32\nvml.dll,
/// installed with the driver). Devices are matched by PCI id, then by name.
fn enrich_from_nvml(gpus: &mut [GpuInfo]) {
    let Some(root) = std::env::var_os("SystemRoot") else { return };
    let path = std::path::Path::new(&root).join("System32").join("nvml.dll");
    let Some(devices) = nvml::devices(&path.to_string_lossy()) else { return };
    for gpu in gpus.iter_mut().filter(|g| g.vendor == GpuVendor::Nvidia) {
        let pci_id = (gpu.device_id << 16) | gpu.vendor_id;
        let found = devices
            .iter()
            .find(|d| d.pci_device_id == Some(pci_id))
            .or_else(|| devices.iter().find(|d| d.name == gpu.name));
        if let Some(d) = found {
            gpu.vram_free_bytes = Some(d.free_bytes);
            gpu.compute_capability = d.compute_capability.map(|(major, minor)| format!("{major}.{minor}"));
        }
    }
}

/// Asks D3D12 whether the adapter uses unified memory (= integrated GPU).
unsafe fn is_uma(adapter: &IDXGIAdapter1) -> Option<bool> {
    let mut device: Option<ID3D12Device> = None;
    unsafe { D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, &mut device) }.ok()?;
    let device = device?;
    let mut arch = D3D12_FEATURE_DATA_ARCHITECTURE::default();
    unsafe {
        device.CheckFeatureSupport(
            D3D12_FEATURE_ARCHITECTURE,
            &mut arch as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<D3D12_FEATURE_DATA_ARCHITECTURE>() as u32,
        )
    }
    .ok()?;
    Some(arch.UMA.as_bool())
}

unsafe fn local_memory_info(adapter: &IDXGIAdapter1) -> Option<DXGI_QUERY_VIDEO_MEMORY_INFO> {
    let adapter3: IDXGIAdapter3 = adapter.cast().ok()?;
    let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
    unsafe { adapter3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info) }.ok()?;
    Some(info)
}

/// Some drivers expose the same physical GPU twice (e.g. hybrid laptops);
/// keep the first entry per (vendor, device, VRAM) triple.
fn dedupe(gpus: Vec<GpuInfo>) -> Vec<GpuInfo> {
    let mut seen = std::collections::HashSet::new();
    gpus.into_iter()
        .filter(|g| seen.insert((g.vendor_id, g.device_id, g.dedicated_vram_bytes, g.kind)))
        .collect()
}

fn system32_has(file: &str) -> bool {
    std::env::var_os("SystemRoot")
        .map(|root| std::path::Path::new(&root).join("System32").join(file).is_file())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerates_without_error() {
        let mut warnings = Vec::new();
        let gpus = WindowsProbe.gpus(&mut warnings);
        // CI runners have at least the Basic Render Driver.
        assert!(warnings.is_empty(), "{warnings:?}");
        for g in &gpus {
            assert!(!g.name.is_empty());
            if g.kind != GpuKind::Discrete {
                assert!(g.vram_budget_bytes.is_none());
            }
        }
    }

    #[test]
    fn dedupe_removes_identical_entries() {
        let g = GpuInfo {
            index: 0,
            name: "x".into(),
            vendor: GpuVendor::Nvidia,
            vendor_id: 0x10de,
            device_id: 1,
            kind: GpuKind::Discrete,
            dedicated_vram_bytes: 8 << 30,
            shared_memory_bytes: 0,
            vram_budget_bytes: None,
            vram_free_bytes: None,
            compute_capability: None,
        };
        let mut g2 = g.clone();
        g2.index = 1;
        assert_eq!(dedupe(vec![g, g2]).len(), 1);
    }
}
