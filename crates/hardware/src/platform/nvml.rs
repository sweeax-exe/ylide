//! Minimal, dynamically loaded NVML binding (only the calls we need).
//! Loading at runtime means the app still starts on machines without an NVIDIA driver.

use std::ffi::{CStr, c_char, c_int, c_uint, c_void};

#[repr(C)]
#[derive(Default)]
struct NvmlMemory {
    total: u64,
    free: u64,
    used: u64,
}

/// `nvmlPciInfo_t` (v3 layout).
#[repr(C)]
struct NvmlPciInfo {
    bus_id_legacy: [c_char; 16],
    domain: c_uint,
    bus: c_uint,
    device: c_uint,
    /// `(device_id << 16) | vendor_id`
    pci_device_id: c_uint,
    pci_sub_system_id: c_uint,
    bus_id: [c_char; 32],
}

// Windows takes totals from DXGI; Linux needs all fields.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) struct NvmlDevice {
    pub name: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_bytes: u64,
    /// `(device_id << 16) | vendor_id`, used to match DXGI adapters.
    pub pci_device_id: Option<u32>,
    pub compute_capability: Option<(i32, i32)>,
}

type NvmlReturn = i32;
type InitFn = unsafe extern "C" fn() -> NvmlReturn;
type CountFn = unsafe extern "C" fn(*mut c_uint) -> NvmlReturn;
type HandleFn = unsafe extern "C" fn(c_uint, *mut *mut c_void) -> NvmlReturn;
type NameFn = unsafe extern "C" fn(*mut c_void, *mut c_char, c_uint) -> NvmlReturn;
type MemoryFn = unsafe extern "C" fn(*mut c_void, *mut NvmlMemory) -> NvmlReturn;
type PciFn = unsafe extern "C" fn(*mut c_void, *mut NvmlPciInfo) -> NvmlReturn;
type CapabilityFn = unsafe extern "C" fn(*mut c_void, *mut c_int, *mut c_int) -> NvmlReturn;

/// Returns `None` when NVML is not installed or fails to initialise.
pub(crate) fn devices(library: &str) -> Option<Vec<NvmlDevice>> {
    // SAFETY: documented NVML signatures; the library stays loaded for all calls.
    unsafe {
        let lib = libloading::Library::new(library).ok()?;
        let init: libloading::Symbol<InitFn> = lib.get(b"nvmlInit_v2\0").ok()?;
        let shutdown: libloading::Symbol<InitFn> = lib.get(b"nvmlShutdown\0").ok()?;
        let count: libloading::Symbol<CountFn> = lib.get(b"nvmlDeviceGetCount_v2\0").ok()?;
        let handle: libloading::Symbol<HandleFn> = lib.get(b"nvmlDeviceGetHandleByIndex_v2\0").ok()?;
        let name: libloading::Symbol<NameFn> = lib.get(b"nvmlDeviceGetName\0").ok()?;
        let memory: libloading::Symbol<MemoryFn> = lib.get(b"nvmlDeviceGetMemoryInfo\0").ok()?;
        let pci: Option<libloading::Symbol<PciFn>> = lib.get(b"nvmlDeviceGetPciInfo_v3\0").ok();
        let capability: Option<libloading::Symbol<CapabilityFn>> = lib.get(b"nvmlDeviceGetCudaComputeCapability\0").ok();

        if init() != 0 {
            return None;
        }
        let mut n: c_uint = 0;
        let mut out = Vec::new();
        if count(&mut n) == 0 {
            for i in 0..n {
                let mut dev: *mut c_void = std::ptr::null_mut();
                if handle(i, &mut dev) != 0 {
                    continue;
                }
                let mut buf = [0 as c_char; 96];
                let dev_name = if name(dev, buf.as_mut_ptr(), buf.len() as c_uint) == 0 {
                    CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned()
                } else {
                    format!("NVIDIA GPU {i}")
                };
                let mut mem = NvmlMemory::default();
                if memory(dev, &mut mem) != 0 {
                    continue;
                }
                let pci_device_id = pci.as_ref().and_then(|f| {
                    let mut info: NvmlPciInfo = std::mem::zeroed();
                    (f(dev, &mut info) == 0).then_some(info.pci_device_id)
                });
                let compute_capability = capability.as_ref().and_then(|f| {
                    let (mut major, mut minor) = (0, 0);
                    (f(dev, &mut major, &mut minor) == 0 && major > 0).then_some((major, minor))
                });
                out.push(NvmlDevice {
                    name: dev_name,
                    total_bytes: mem.total,
                    free_bytes: mem.free,
                    used_bytes: mem.used,
                    pci_device_id,
                    compute_capability,
                });
            }
        }
        shutdown();
        Some(out)
    }
}
