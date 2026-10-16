# Contributing to Ylide

Thank you for helping. Ylide is built by a small team, so we optimise for code
that is easy to read, test and maintain.

Bugs and ideas go into [GitHub issues](https://github.com/sweeax-exe/ylide/issues)
or the [Ylide Discord](https://discord.gg/GRzTvRGHpr), questions into `#help`
there. Security problems are reported privately, see [SECURITY.md](SECURITY.md).
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

**How this repository works.** The public repository gets one commit per
released version ("Ylide 0.1.4", tagged `v0.1.4`), made from exactly the code
that was built and signed for that release. Development between releases
happens in the maintainers' working tree. Pull requests against `main` are
welcome all the same: an accepted change is carried into the development tree
and appears here with the next release, credited to you in its release notes.

## Ground rules

- **Local first, private by default.** No feature may send user data anywhere.
  New network access needs a clear purpose, a switch in the network settings
  and an entry in the network log (`apps/desktop/src-tauri/src/network.rs`).
- **No hidden behaviour.** Prompts, roles and settings the app uses must be
  visible and editable in the UI.
- **Licenses.** Code is Apache-2.0. Dependencies must be compatible (MIT,
  Apache-2.0, BSD, ISC, Unlicense, CC0, Zlib, OFL for fonts). No GPL/LGPL/MPL
  in the shipped app. Models in the registry must allow use in an IDE,
  including commercial use, or carry a clear note.

## Development setup

See the "Build from source" section of the [README](README.md). Useful commands:

| Task | Command |
|---|---|
| Rust tests | `cargo test --workspace` |
| Lints | `cargo clippy --workspace --all-targets` |
| Formatting | `cargo fmt --all` |
| UI type check | `node node_modules/typescript/bin/tsc --noEmit -p apps/desktop` |
| UI tests | `npm test -w apps/desktop` |
| UI with mock backend | `node node_modules/vite/bin/vite.js apps/desktop` |
| Regenerate TS types | `cargo test --workspace export_bindings` |
| Real-model E2E test | `cargo test -p ylide-desktop --lib e2e -- --ignored --nocapture` |

## Where things live

- `crates/*`: the core, without UI. Every crate has unit tests; keep it that way.
- `apps/desktop/src-tauri`: Tauri commands and services that glue the crates together.
- `apps/desktop/src`: the UI. `lib/ipc.ts` is the only place that calls Tauri;
  `bindings/` is generated from Rust and must not be edited by hand.
- `registry/`: model data. See [docs/registry.md](docs/registry.md).

## UI conventions

- Use the design tokens (`design/themes.ts`) through CSS variables only, and
  the shared components in `components/`. See [docs/design.md](docs/design.md).
- Every string goes through i18n and exists in every app language under
  `i18n/locales/` (a test enforces parity; `node tools/i18n/check.mjs <lang>`
  checks one language). Where you cannot translate, use the English text and
  say so in the pull request. Sentence case, plain verbs, no exclamation marks.
- Keyboard accessible, visible focus, labels on icon buttons, reduced motion respected.

## Rust conventions

- `cargo fmt` and no clippy warnings.
- Errors that reach the UI are `AppError { code, message }`; add a translation
  for new codes in `i18n/locales/*/common.json`.
- Types shared with the UI derive `TS` with `#[ts(export)]` and
  `#[serde(rename_all = "camelCase")]` (also on enum struct variants).
- Platform-specific code stays behind a trait or `cfg` in one module.

## Pull requests

1. One topic per pull request, with tests for new logic.
2. Describe what changed and how you verified it (screenshots for UI changes).
3. Commit messages in English, imperative mood ("Add X", "Fix Y").
4. CI runs clippy and the Rust, UI and Discord bot tests on every pull request
   (`.github/workflows/ci.yml`); changes to the model list are also checked
   against Hugging Face and the llama.cpp releases.

By contributing, you agree that your contribution is licensed under the
Apache License 2.0, like the rest of Ylide (section 5 of the [LICENSE](LICENSE)).
