<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/banner-dark.png">
    <img alt="Ylide, Your Local IDE: chat, inline edits and coding agents, powered only by models on your own computer" src="docs/images/banner-light.png" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/sweeax-exe/ylide/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/sweeax-exe/ylide?style=flat-square&label=release&color=22D3EE&labelColor=111726"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-22D3EE?style=flat-square&labelColor=111726"></a>
  <a href="#system-requirements"><img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-C9A66B?style=flat-square&labelColor=111726"></a>
  <a href="https://discord.gg/GRzTvRGHpr"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-22D3EE?style=flat-square&logo=discord&logoColor=E6ECF5&labelColor=111726"></a>
  <a href="https://ylide.app"><img alt="Website: ylide.app" src="https://img.shields.io/badge/web-ylide.app-22D3EE?style=flat-square&labelColor=111726"></a>
</p>

<p align="center">
  <a href="https://ylide.app">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/download-dark.png">
      <img alt="Download Ylide for Windows from ylide.app" src="docs/images/download-light.png" width="300">
    </picture>
  </a>
</p>

<p align="center">
  <a href="README.de.md">Deutsch</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#models-and-hardware">Models</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="docs/trust.md">Verify a download</a>
</p>

Ylide is an open-source AI coding IDE in the spirit of Cursor, with one
difference: **every model runs on your own computer**. Chat with your project,
edit code inline, and let a small team of agents (Orchestrator, Coder,
Reviewer) work on tasks, all through [llama.cpp](https://github.com/ggml-org/llama.cpp).
No cloud, no account, no telemetry, and your code never leaves your machine.

<p align="center">
  <img alt="The Ylide workbench: the demo project's cart.ts in the editor, and the chat explaining why the cart total ignores the quantity" src="docs/images/screenshot-chat.png" width="100%">
</p>

## Why Ylide

- **Private by design.** Models, prompts, chats and code stay on your disk.
  Ylide goes online for exactly four things, each switchable and logged:
  the model list, the update check, and the model and runtime downloads you
  start yourself.
- **The right model for your machine.** A hardware scan measures graphics
  memory, RAM, CPU and disk, then recommends the strongest coding model that
  runs smoothly, with a quantization and context length that fit, and tells
  you why.
- **Agents you can watch.** Every agent is a line on a timeline, every task
  gets a checkpoint you can roll back to, and commands or deletions ask
  first. Every prompt and role is visible and editable.

## Features

- **Hardware-aware setup**: GPU, free VRAM, RAM, CPU features and disk, then a
  recommendation with faster, stronger and lighter alternatives. One-click
  download with resume and SHA-256 verification.
- **Runs what you choose**: models from the curated list, your own GGUF files
  and finetunes, or an existing OpenAI-compatible server (Ollama, LM Studio,
  llama-server).
- **Editor** based on Monaco, with tabs, file tree, search and go-to-file.
- **Chat with context**: `@file`, `@folder`, `@symbol` and the selection, with
  a token count for everything you attach. Chats are saved per project.
- **Inline edit** (<kbd>Ctrl</kbd>+<kbd>K</kbd>): describe a change, review the
  diff, accept or reject.
- **Agent mode** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>): the
  Orchestrator plans, the Coder implements, the Reviewer checks each task and
  sends it back when something is off.
- **Updates itself**, after checking the installer's signature.
- **Eleven languages**: English, German, Spanish, French, Portuguese, Chinese,
  Japanese, Korean, Russian, Hindi, Indonesian. Dark and light theme.

## Screenshots

<table>
  <tr>
    <td width="50%"><img alt="Agents at work: the Orchestrator's plan, the Coder on task 2 and the Reviewer's approval of task 1, with the run's timeline" src="docs/images/screenshot-agents.png"><p align="center"><sub>Agents at work: plan, tasks, review and timeline</sub></p></td>
    <td width="50%"><img alt="The Coder asks before running npm test: Reject, Approve for this run or Approve" src="docs/images/screenshot-approval.png"><p align="center"><sub>Commands ask first</sub></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Setup: Qwen3.6 35B-A3B recommended for an RTX 5070 Ti, with memory use, speed estimate and alternatives" src="docs/images/screenshot-onboarding.png"><p align="center"><sub>A model chosen for this computer</sub></p></td>
    <td width="50%"><img alt="The model catalog with the recommendation for this computer and the list of models with parameters, context, tool use and license" src="docs/images/screenshot-catalog.png"><p align="center"><sub>The catalog, checked against your hardware</sub></p></td>
  </tr>
</table>

<sub>Screenshots of Ylide 0.1.4 with its built-in demo project.</sub>

## Quick start

1. **Download** the installer from [ylide.app](https://ylide.app) and run it.
   It is signed with Ylide's release key ([how to verify it](docs/trust.md)).
   It is not yet signed with a Windows code-signing certificate, so
   SmartScreen may ask: choose *More info* → *Run anyway*.
2. **Scan and pick a model.** Ylide measures your hardware and recommends a
   model. The download resumes if interrupted and is checked against its
   SHA-256.
3. **Open a folder** and start: chat with <kbd>Ctrl</kbd>+<kbd>L</kbd>, edit the
   selection with <kbd>Ctrl</kbd>+<kbd>K</kbd>, hand a task to the agents with
   <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>, jump to a file with
   <kbd>Ctrl</kbd>+<kbd>P</kbd>.

Questions? Ask in `#help` on the [Ylide Discord](https://discord.gg/GRzTvRGHpr).

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/how-it-works-dark.png">
    <img alt="Editor, chat and agents talk to a llama-server on 127.0.0.1, which runs GGUF model files from your disk. Only four switchable doors lead outside: the signed model list and update check from ylide.app, model downloads from Hugging Face and runtime downloads from the llama.cpp releases, both checked against SHA-256." src="docs/images/how-it-works-light.png" width="100%">
  </picture>
</p>

Ylide starts llama.cpp's `llama-server` as a supervised child process that
listens only on `127.0.0.1`, with a random key. Editor, chat and agents talk to
it like to any OpenAI-compatible server; the model files stay where they are
on your disk. Ylide ships CPU and Vulkan builds of llama.cpp (NVIDIA, AMD and
Intel GPUs); NVIDIA cards can add an optional CUDA pack.

### The agents

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/agents-dark.png">
    <img alt="The agent run as world lines: the Orchestrator plans two tasks, the Coder works on task 1 with a checkpoint and asks before npm test, the Reviewer requests changes, the Coder fixes, the Reviewer approves, then task 2 the same way, and the Orchestrator finishes." src="docs/images/agents-light.png" width="100%">
  </picture>
</p>

The Orchestrator explores the project and splits the request into small tasks.
The Coder takes one task at a time; a checkpoint before each one lets you undo
any step. The Reviewer checks every finished task and sends it back with notes
when something is off. You choose how much the agents may do on their own:
by default, reading and undoable edits run automatically, while commands and
deletions wait for your approval.

## Privacy

Ylide has no account, no telemetry and no cloud backend. It goes online for
four purposes only, each one switchable in *Settings → Network and privacy*
and recorded in the network log:

| Door | Where | What protects it |
|---|---|---|
| Model list | `ylide.app` | signed with the release key |
| Update check | `ylide.app` | sends only `Ylide/<version>`; installers are signed |
| Model downloads | `huggingface.co` | SHA-256 from the signed model list |
| Runtime downloads | `github.com/ggml-org/llama.cpp` | SHA-256 from the signed model list |

ylide.app keeps no access log. Your projects, prompts and chats are never
uploaded anywhere. How releases and the model list are signed, and how to
check a download yourself: [docs/trust.md](docs/trust.md).

## System requirements

| | |
|---|---|
| Operating system | Windows 10 or 11, 64-bit. macOS and Linux will follow; the core is cross-platform. |
| Runtime | WebView2 (part of Windows 11; the installer adds it when it is missing) |
| Memory | 16 GB RAM or more recommended; small models also run with less |
| Graphics | Optional. NVIDIA, AMD and Intel GPUs through Vulkan; NVIDIA also through the optional CUDA pack |
| Disk | About 25 MB for the installer, plus 1 to 50 GB for models |

## Models and hardware

The hardware scan picks the model, quantization and context length for your
exact machine. As a rough guide:

| Model | Kind | Download | Runs well with |
|---|---|---|---|
| Qwen3.6 35B-A3B | MoE, 35B (3B active) | 13–37 GB | 12 GB VRAM + 32 GB RAM (experts in RAM), or 24 GB VRAM |
| Qwen3-Coder-Next 80B-A3B | MoE, 80B (3B active) | 38–50 GB | 16 GB VRAM + 64 GB RAM |
| Qwen3.8 27B | dense, 27.8B | 11–29 GB | 12–24 GB VRAM |
| Qwen3.6 27B | dense, 27B | 15–29 GB | 16–24 GB VRAM |
| Muse Glimmer 30B | dense, 29.6B | 17–20 GB | 20–24 GB VRAM |
| gpt-oss 20B | MoE, 21B (3.6B active) | 12 GB | 16 GB VRAM, or 8 GB VRAM + RAM |
| Gemma 4 12B | dense, 12B | 7–13 GB | 8–16 GB VRAM |
| Qwen3.5 9B | dense, 9B | 6–10 GB | 8–12 GB VRAM |
| Qwen3.5 4B | dense, 4B | 3–5 GB | 4–6 GB VRAM, or the CPU |
| Qwen3.5 2B | dense, 2B | 1–2 GB | the CPU (chat only) |

Helpers run next to the main model: Qwen2.5-Coder 0.5B, 1.5B or 7B for
autocomplete, and Qwen3-Embedding 0.6B or EmbeddingGemma 2 for code search.
Three uncensored variants are in the catalog too; they are marked and never
recommended. Every model's license is shown before it is downloaded; the
inclusion rules are in [docs/registry.md](docs/registry.md).

## Build from source

Prerequisites:

- [Rust](https://rustup.rs) 1.88 or newer (MSVC toolchain)
- [Node.js](https://nodejs.org) 20.19 or newer
- Visual Studio Build Tools 2022 with the "Desktop development with C++" workload
- Git

```bash
git clone https://github.com/sweeax-exe/ylide.git
```

```bash
cd ylide
```

```bash
npm install
```

```bash
node scripts/fetch-runtime.mjs
```

The last step downloads the bundled llama.cpp builds (CPU and Vulkan, about
50 MB) from the official llama.cpp releases and verifies their checksums.

Run the app in development mode:

```bash
npm run dev
```

Build the installer (`target/release/bundle/nsis/`):

```bash
npm run build
```

Your own build runs exactly like a release, but it cannot update itself from
ylide.app: updates must be signed with the release key, which is not in this
repository ([docs/trust.md](docs/trust.md)).

### Tests

```bash
cargo test --workspace
```

```bash
npm test -w apps/desktop
```

The end-to-end test against a real model is opt-in:

```bash
cargo test -p ylide-desktop --lib e2e -- --ignored --nocapture
```

It needs `YLIDE_E2E_MODEL` pointing to a GGUF file (for example Qwen3.5-4B
Q4_K_M from the registry).

### UI work without Tauri

`node node_modules/vite/bin/vite.js apps/desktop` serves the UI at
http://localhost:1420 with an in-browser mock backend (demo project, simulated
downloads, streaming chat and a scripted agent run). Add `?workbench` to skip
onboarding.

## Project structure

```text
apps/desktop/
  src-tauri/        Tauri app: commands, services, updater, signatures
  src/              React UI: onboarding, editor, chat, agents, settings
crates/
  hardware/         GPU, VRAM, RAM, CPU and disk probing
  registry/         model list schema, memory estimates, recommendations
  downloader/       resumable, checksum-verified downloads
  inference/        llama-server supervision, streaming client, scheduler
  workspace/        sandboxed project access, search, @-mention context
  agent/            tools, permissions, checkpoints, orchestrator
registry/           the model list (models.json)
scripts/            runtime download, release and publishing
tools/              translation checks, model list maintenance
website/            ylide.app
docs/               architecture, design, registry, releasing, trust
```

More detail: [architecture](docs/architecture.md), [design language](docs/design.md),
[model list](docs/registry.md), [releasing](docs/releasing.md),
[roadmap](docs/roadmap.md).

## Contributing

Bug reports, model suggestions, translations and code are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); questions go to `#help` on the
[Discord](https://discord.gg/GRzTvRGHpr). This repository gets one commit per
released version, tagged like `v0.1.4`; accepted pull requests are carried
into the development tree and ship with the next release.

Security problems: please report them privately, as described in
[SECURITY.md](SECURITY.md). Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

## License

Ylide is licensed under the [Apache License 2.0](LICENSE). Third-party
components and their licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Models have their own licenses, shown before every download. The name Ylide
and its logo are not covered by the license; forks please use their own name.
