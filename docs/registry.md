# The model registry

`registry/models.json` describes every model and runtime Ylide can download.
It is plain, versioned data so that adding a model is a pull request, not a
release. The JSON Schema is `registry/schema/registry.schema.json`; the Rust
types in `crates/registry/src/schema.rs` mirror it and a test keeps both in sync.

## Lifecycle

1. The installer ships a copy (offline fallback).
2. At startup, and when the user refreshes the list in the model settings, the
   app fetches `network.registryUrl` (default:
   `https://ylide.app/registry/v2/models.json`) with `If-None-Match`, if registry
   updates are allowed in the network settings. Settings that still hold an
   earlier default (`https://ylide.app/registry/models.json`, the GitHub
   addresses) follow the current one.
3. A new list (not a 304) needs its signature, fetched from the same path plus
   `.sig` with the same query (`models.json.sig`). The list names programs (the
   runtimes), so the official one is accepted only with a valid signature of the
   release key for the file name `models.json`. A list at an address the user
   set is checked when there is a signature and accepted without one; "not
   found" (404, 410), "not allowed" (401, 403: cloud storage such as S3 answers
   a missing file that way), or a page that is not a signature at all (a start
   page served for every address) counts as none. Any other answer (a server
   error, no connection) keeps the list out, since it may be signed.
4. The list is validated and cached together with its address and whether it
   was signed. A cached list counts only for the address it came from, and at
   the official address only a signed one counts. A newer `registryVersion`
   (calendar version `YYYY.M.D[.N]`) replaces the cached copy; anything invalid
   is ignored.

The official list is published with `node scripts/publish-registry.mjs
--publish` (see "Publishing the model list" in `docs/releasing.md`).

## Schema versions

`registry/models.json` is schema 2. Version 2 added `uncensored`: an app that
does not know the flag would treat such a model like any other and could
recommend it. So the publish script writes two lists from the one file:

| Address | Schema | Read by |
|---|---|---|
| `https://ylide.app/registry/v2/models.json` | 2, the file as it is | Ylide 0.1.4 and newer |
| `https://ylide.app/registry/models.json` | 1, without the uncensored models and the flag | Ylide 0.1.3 and older |

Validation refuses an uncensored model in a schema 1 list.

## Top level

| Field | Meaning |
|---|---|
| `schemaVersion` | Major schema version (2, see above). Newer versions are rejected by older apps. |
| `registryVersion`, `updatedAt` | Data version and date. |
| `runtimes[]` | llama.cpp builds: `version` (release tag) and `assets[]` per `os`/`arch`/`backend`/`variant` with `files[]` (`url`, `sizeBytes`, `sha256`), `bundled` and `minCudaDriver`. |
| `gpuHints[]` | `nameContains` + `bandwidthGbps` for speed estimates (longest match wins). |
| `models[]` | See below. |

## Model fields

| Field | Meaning |
|---|---|
| `id`, `name`, `family`, `publisher`, `releaseDate` | Identity. `id` is stable. |
| `roles` | `chat`, `agent`, `fim` (autocomplete), `embedding`. `agent` requires tool calling. |
| `description`, `strengths[]` | Localized text: `{ "en": ..., "de": ... }`. |
| `license` | `id` (SPDX or `LicenseRef-...`), `name`, `url`, `commercialUse`, `notes`. Models whose license forbids commercial use or restricts IDE-like products are not added. |
| `architecture` | `type` (dense/moe), `paramsTotalB`, `paramsActiveB`, `layers`, `attentionLayers` (hybrid models), `kvHeads`, `headDimK`, `headDimV`, `slidingWindow` + `slidingWindowLayers`, `kvBytesPerTokenF16` (override for exotic layouts), `expertFraction` (share of weights in expert tensors), `recurrentStateMib`. Read from the GGUF header with `tools/registry/gguf-meta.mjs`. |
| `context` | `max` and `recommended` tokens. |
| `capabilities` | `toolCalling` (none/basic/good/excellent), `reasoning` (none/optional/always), `vision`. |
| `quality` | Curated 0-100 `coding` and `agentic` scores derived from the listed benchmarks, used for ranking only. Prefer independent results (SWE-rebench, Artificial Analysis) over self-reported ones. |
| `requestDefaults` | Per mode (`agent`, `chat`, `inline`): `temperature`, `topP`, `topK`, `minP`, `presencePenalty`, `repeatPenalty`, `templateKwargs` (sent as `chat_template_kwargs`, e.g. `{"enable_thinking": false}`), following the model card. |
| `source` | `hfRepo` and `revision` (a pinned commit, so hashes stay valid). |
| `variants[]` | `quant`, `bitsPerWeight`, `qualityPenalty` (quantization loss), `files[]` (`path`, `sizeBytes`, `sha256`; several files for split GGUFs). |
| `fim` | Token format for autocomplete models. |
| `embedding` | `dimensions`, `pooling`, `maxTokens`, query/document prefixes. |
| `benchmarks[]` | `name`, `score`, `unit`, `sourceUrl`, `selfReported`, `date`. |
| `llamaArgs` | Extra llama-server arguments (e.g. `--jinja`). Unknown flags are dropped at runtime. |
| `uncensored` | `true` for a variant with the refusal training removed. See below. |

## Adding a model

1. Add the entry with `sizeBytes: 0` and `sha256: ""` for each file and
   `revision: "main"`.
2. `node tools/registry/fill.mjs --pin` pins the revision and fills sizes and
   hashes from the Hugging Face API (runtime assets from the GitHub API).
3. `node tools/registry/gguf-meta.mjs --registry --write` reads the GGUF
   headers and corrects the architecture values.
4. Bump `registryVersion`, run `cargo test -p registry` and open a pull
   request with the sources for license and benchmark numbers.

## Uncensored variants

Some users want a model that does not refuse. The list offers a few variants
of listed models with the refusal training removed, marked `uncensored: true`
and with an `id` ending in `-uncensored`. The normal models stay the default:

* The recommender never picks them, neither as the recommendation nor as an
  alternative (`recommend::offered`); the user chooses them in the catalog.
* The catalog shows them in their own group, with a badge and a note that
  explains what was changed.

What a variant needs before it goes in:

* Plain refusal removal (abliteration, e.g. Heretic) on the official weights of
  a model that is already in the list, with the method and its parameters
  published. No merges, no distills, no fine-tunes on other models' outputs.
* The base model's license, unchanged (Apache-2.0 so far).
* Published drift and refusal numbers (KL divergence on harmless prompts,
  refusals before and after, ideally MMLU before and after). `quality` is the
  original's minus that drift, and `notes` says so: there are usually no
  independent coding or tool-calling benchmarks for such variants.
* The same tool-call format as the original. If the GGUF embeds a different
  chat template, `notes` says so, and `requestDefaults` set every template
  switch (`enable_thinking`) explicitly instead of relying on its defaults.
* A pinned `revision`: these repositories are often maintained by one person.

Current entries: `qwen3.6-35b-a3b-uncensored`, `qwen3.6-27b-uncensored` and
`qwen3.5-9b-uncensored`, all Heretic v1.2.0 builds by llmfan46 on the official
Qwen weights. Rejected for now: HauhauCS (method not disclosed, no upstream
weights), huihui-ai (no measurements), merges such as Genesis-Hermes, and
Qwen3-Coder-Next variants (drift about 30 times that of the 27B).
