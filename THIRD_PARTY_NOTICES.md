# Third-party notices

Ylide is licensed under the Apache License 2.0. It includes or downloads the
following third-party software. The full license texts of everything compiled
into Ylide are in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) (generated
by `scripts/third-party-licenses.mjs`); the bundled runtimes carry theirs next to
the binaries in `runtime/<variant>/`. Both are installed with Ylide.

## Bundled with the installer

| Component | License | Notes |
|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`, ggml) | MIT | Bundled CPU and Vulkan builds (release b11669), unmodified. License text: `runtime/<variant>/LICENSE-llama.cpp`. |
| [cpp-httplib](https://github.com/yhirose/cpp-httplib), [nlohmann/json](https://github.com/nlohmann/json) (part of the llama.cpp builds) | MIT | License texts: `runtime/<variant>/LICENSE-httplib`, `LICENSE-jsonhpp`. |
| [BoringSSL](https://boringssl.googlesource.com/boringssl) (linked into the llama.cpp builds) | Apache-2.0 | License text: `runtime/<variant>/LICENSE-BoringSSL`. |
| LLVM OpenMP runtime (`libomp.dll`, part of the llama.cpp builds) | Apache-2.0 WITH LLVM-exception | License text: `runtime/<variant>/LICENSE-LLVM-OpenMP`. |
| [Tauri](https://tauri.app) and its plugins (dialog, opener, window-state, single-instance) | Apache-2.0 OR MIT | |
| Microsoft WebView2 loader (`WebView2LoaderStatic.lib`, linked into ylide.exe) | Microsoft BSD-style license | Text in THIRD_PARTY_LICENSES.txt (with webview2-com-sys). |
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | MIT | With DOMPurify (MPL-2.0 OR Apache-2.0, used under Apache-2.0) and marked (MIT); Monaco's own third-party notices are in THIRD_PARTY_LICENSES.txt. |
| [React](https://react.dev), [zustand](https://github.com/pmndrs/zustand), [i18next](https://www.i18next.com), [react-markdown](https://github.com/remarkjs/react-markdown), [remark-gfm](https://github.com/remarkjs/remark-gfm) and their dependencies | MIT, ISC | |
| [Lucide icons](https://lucide.dev) | ISC | |
| [Instrument Sans](https://github.com/Instrument/instrument-sans), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | SIL Open Font License 1.1 | Via Fontsource. |
| Rust crates (tokio, reqwest, rustls, serde, sysinfo, windows, ignore, grep-*, similar, notify, zip, tar, flate2, process-wrap, ts-rs and their dependencies) | MIT, Apache-2.0, Unicode-3.0, Unlicense, ISC, Zlib, BSD-3-Clause, MPL-2.0, MIT-0, CC0-1.0, 0BSD | Complete list with versions and texts in THIRD_PARTY_LICENSES.txt. The MPL-2.0 crates (cssparser, selectors, dtoa-short, option-ext) are used unmodified; their source code is on crates.io at the address listed there. |

## Downloaded on request

| Component | Source | License |
|---|---|---|
| llama.cpp CUDA and ROCm builds | GitHub releases of ggml-org/llama.cpp | MIT; Ylide writes the license texts of llama.cpp and the libraries linked into it next to the binaries |
| NVIDIA CUDA runtime libraries (`cudart-*` packs) | GitHub releases of ggml-org/llama.cpp | NVIDIA CUDA Toolkit EULA (redistributable components) |
| AMD ROCm/HIP runtime libraries (inside the ROCm build) | GitHub releases of ggml-org/llama.cpp | See the license files inside the pack |
| Model weights | Hugging Face | Each model's own license, shown in the app before download |

Model licenses are listed in `registry/models.json` and in the model manager.
