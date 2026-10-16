fn main() {
    // Tauri embeds its Windows manifest only into the app binary. Test binaries
    // need it too (Common Controls v6), otherwise they fail to start with
    // STATUS_ENTRYPOINT_NOT_FOUND. So we embed our own manifest for every target.
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("tauri build step");

    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // Read the folder when the script runs, not with env!: Cargo keeps the
        // compiled build script after the repo folder moves, and a path baked in
        // at compile time then points the linker at the old folder.
        let dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
        let manifest = std::path::Path::new(&dir).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
