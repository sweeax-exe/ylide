//! Platform dispatch. Exactly one probe implementation is compiled per target.

use crate::PlatformProbe;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) fn current() -> impl PlatformProbe {
    windows::WindowsProbe
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(windows, target_os = "linux"))]
mod nvml;
#[cfg(target_os = "linux")]
pub(crate) fn current() -> impl PlatformProbe {
    linux::LinuxProbe
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) fn current() -> impl PlatformProbe {
    macos::MacProbe
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod fallback;
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(crate) fn current() -> impl PlatformProbe {
    fallback::FallbackProbe
}

/// The raw SMBIOS structure table (without the entry point), if the OS gives it out.
#[cfg(windows)]
pub(crate) fn smbios_table() -> Option<Vec<u8>> {
    windows::smbios_table()
}
#[cfg(target_os = "linux")]
pub(crate) fn smbios_table() -> Option<Vec<u8>> {
    // Readable by root only on most distributions.
    std::fs::read("/sys/firmware/dmi/tables/DMI").ok()
}
#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn smbios_table() -> Option<Vec<u8>> {
    None
}

/// The raw processor layout (Windows: `GetLogicalProcessorInformationEx`).
#[cfg(windows)]
pub(crate) fn processor_information() -> Option<Vec<u8>> {
    windows::processor_information()
}
#[cfg(not(windows))]
pub(crate) fn processor_information() -> Option<Vec<u8>> {
    None
}

/// Loads a shared library without keeping it, to test for its presence.
#[allow(dead_code)]
pub(crate) fn library_loadable(name: &str) -> bool {
    // SAFETY: loading a system library runs its initialiser; we only probe
    // well-known vendor runtimes (Vulkan loader, CUDA driver, HIP runtime).
    unsafe { libloading::Library::new(name).is_ok() }
}

/// Queries the CUDA driver API version (e.g. "13.3") from the driver library
/// (`nvcuda.dll` on Windows, `libcuda.so.1` on Linux).
#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn cuda_driver_version(library: &str) -> Option<String> {
    type CuInit = unsafe extern "system" fn(u32) -> i32;
    type CuDriverGetVersion = unsafe extern "system" fn(*mut i32) -> i32;
    // SAFETY: symbols are resolved from the official driver library with their
    // documented signatures; the library outlives the calls.
    unsafe {
        let lib = libloading::Library::new(library).ok()?;
        let init: libloading::Symbol<CuInit> = lib.get(b"cuInit\0").ok()?;
        let get_version: libloading::Symbol<CuDriverGetVersion> = lib.get(b"cuDriverGetVersion\0").ok()?;
        if init(0) != 0 {
            return None;
        }
        let mut version = 0i32;
        if get_version(&mut version) != 0 || version <= 0 {
            return None;
        }
        Some(format_cuda_version(version))
    }
}

/// CUDA encodes versions as `1000 * major + 10 * minor`.
#[allow(dead_code)]
pub(crate) fn format_cuda_version(version: i32) -> String {
    format!("{}.{}", version / 1000, (version % 1000) / 10)
}

#[cfg(test)]
mod tests {
    #[test]
    fn cuda_version_format() {
        assert_eq!(super::format_cuda_version(13030), "13.3");
        assert_eq!(super::format_cuda_version(12080), "12.8");
        assert_eq!(super::format_cuda_version(11020), "11.2");
    }
}
