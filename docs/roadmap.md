# Roadmap

## MVP (0.1): local AI IDE on Windows

- Open a folder; editor with tabs, file tree, project search, go-to-file.
- First-run onboarding: hardware scan, model recommendation with reasons and
  alternatives, one-click download (resume, SHA-256), optional CUDA pack.
- Managed llama.cpp runtime: bundled CPU and Vulkan builds, on-demand CUDA,
  automatic backend and GPU selection, tool-call self-test.
- Chat with project context (`@file`, `@folder`, `@symbol`, selection).
- Inline edit (Ctrl+K) with diff preview, accept or reject.
- Agent mode: orchestrator with Coder and Reviewer, approvals
  (ask / auto-safe / autonomous), checkpoints with undo, live overview.
- Settings for everything, including every prompt and role.
- German and English UI, dark and light theme.

## v1.0: daily driver

- **Autocomplete** (tab completion) with a small FIM model on the GPU or CPU,
  repo-level context, debounced and cancelled per keystroke.
- **Codebase index**: tree-sitter chunking, local embeddings
  (Qwen3-Embedding 0.6B), SQLite with sqlite-vec and FTS5, hybrid search;
  `@codebase` in chat and a search tool for agents.
- **Symbols** via tree-sitter instead of patterns; repo map for agents.
- **Integrated terminal** (xterm.js + ConPTY/PTY).
- **Git basics**: status, diff, stage, commit, branch (gix for reads, git CLI
  for writes); agent changes shown as a reviewable change set.
- **More roles**: Planner, Tester, Docs, read-only Explorer; parallel
  sub-agents when tasks are independent and slots allow; per-role models.
- Persistent chat and run history; checkpoint timeline with per-file diffs;
  whole-tree snapshots (shadow repository) to also cover shell effects.
- `llama-fit-params` calibration cache, MTP speculative decoding after A/B
  tests, idle unloading to free VRAM for games.
- Signed installer and an opt-in updater (off by default).

## 1.x: macOS and Linux

- macOS (Apple Silicon first): bundled Metal build, Metal working-set query
  (`recommendedMaxWorkingSetSize`), notarization, WKWebView input testing
  (Monaco IME edge cases).
- Linux: AppImage, .deb and .rpm; bundled CPU/Vulkan builds, CUDA and ROCm
  packs; WebKitGTK testing.
- CI matrix for all three platforms; hardware probes for Linux and macOS
  already exist and compile today.

## Later

- Language server integration (diagnostics, go to definition, rename).
- Plugin API and an MCP client for local tools.
- Next-edit prediction (a small model that suggests the next change).
- Optional LAN inference node (use a stronger machine in the same network).
- Multi-GPU splitting, voice input, notebooks.
