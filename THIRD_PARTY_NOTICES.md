# Third-party notices

Ylide is licensed under the Apache License 2.0. It includes or downloads the
following third-party software. Full license texts are included in the
respective packages and, for bundled runtimes, next to the binaries.

## Bundled with the installer

| Component | License | Notes |
|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`, ggml) | MIT | Bundled CPU and Vulkan builds (release b11669), unmodified. |
| LLVM OpenMP runtime (`libomp.dll`, part of the llama.cpp builds) | Apache-2.0 WITH LLVM-exception | License text: `runtime/<variant>/LICENSE-LLVM-OpenMP`. |
| [Tauri](https://tauri.app) and its plugins (dialog, opener, window-state, single-instance) | Apache-2.0 OR MIT | |
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | MIT | |
| [React](https://react.dev), [zustand](https://github.com/pmndrs/zustand), [i18next](https://www.i18next.com), [react-markdown](https://github.com/remarkjs/react-markdown), [remark-gfm](https://github.com/remarkjs/remark-gfm) | MIT | |
| [Lucide icons](https://lucide.dev) | ISC | |
| [Instrument Sans](https://github.com/Instrument/instrument-sans), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | SIL Open Font License 1.1 | Via Fontsource. |
| Rust crates (tokio, reqwest, rustls, serde, sysinfo, windows, ignore, grep-*, similar, notify, zip, tar, flate2, process-wrap, ts-rs and their dependencies) | MIT, Apache-2.0, BSD, ISC, Unlicense, CC0-1.0, Zlib | Run `cargo tree` for the complete list. |

## Downloaded on request

| Component | Source | License |
|---|---|---|
| llama.cpp CUDA and ROCm builds | GitHub releases of ggml-org/llama.cpp | MIT |
| NVIDIA CUDA runtime libraries (`cudart-*` packs) | GitHub releases of ggml-org/llama.cpp | NVIDIA CUDA Toolkit EULA (redistributable components) |
| AMD ROCm/HIP runtime libraries (inside the ROCm build) | GitHub releases of ggml-org/llama.cpp | See the license files inside the pack |
| Model weights | Hugging Face | Each model's own license, shown in the app before download |

Model licenses are listed in `registry/models.json` and in the model manager.
