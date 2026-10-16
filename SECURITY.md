# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues, discussions or
Discord channels.

* **Preferred:** GitHub's private vulnerability reporting:
  [Report a vulnerability](https://github.com/sweeax-exe/ylide/security/advisories/new).
* **Alternatively:** open a private ticket on the
  [Ylide Discord](https://discord.gg/GRzTvRGHpr) (channel `#tickets`,
  "Something else") and say that it is about security. Only you and the team
  can see a ticket; we then continue in a private advisory.

Please include the Ylide version, what an attacker could do, the steps or a
proof of concept, and what the attack needs (for example a crafted project
folder, GGUF file or model list, or a position on the network).

Ylide is maintained by a small team. We confirm reports within a week, keep
you informed while we work on a fix, and credit you in the release notes
unless you prefer otherwise. Please give us 90 days, or until a fixed version
is out, before you publish details. There is no bug bounty.

## Supported versions

Only the latest release gets security fixes. Ylide updates itself, so please
check that a problem still exists in the newest version.

## Scope

Examples of what we want to hear about:

* Getting an installer or a model list past the signature check
  (`signing.rs`, `updates.rs`, `registry_service.rs` in
  `apps/desktop/src-tauri/src/`).
* Agent tools reaching outside the project folder, or acting without the
  approval the permission settings require (`crates/agent`,
  `crates/workspace`).
* Network access that bypasses the switches and the network log in
  Settings → Network and privacy, or project data leaving the computer.
* The local model server being reachable from other machines or without its
  key.
* Code execution through a project's files, a model file, or chat and markdown
  content shown in the UI.

Out of scope:

* What a model writes. Wrong or harmful code is a quality problem; what agents
  may do on their own is set by the approval settings you choose.
* Vulnerabilities in llama.cpp itself: please report them
  [upstream](https://github.com/ggml-org/llama.cpp/security). Tell us as well
  if the way Ylide runs it makes them exploitable.
* Windows SmartScreen warnings: the installers are signed with the release key
  but not yet with a Windows code-signing certificate.

How releases and the model list are protected, and how to verify a download
yourself: [docs/trust.md](docs/trust.md).
