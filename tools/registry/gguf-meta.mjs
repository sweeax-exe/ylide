#!/usr/bin/env node
// Reads the metadata and tensor table of a GGUF file on Hugging Face without
// downloading it (HTTP Range requests on the header only), and derives what
// Ylide's memory estimator needs.
//
//   node tools/registry/gguf-meta.mjs <repo> <path> [revision]
//   node tools/registry/gguf-meta.mjs --registry [--write]   (all models in registry/models.json)
//
// GGUF v3 layout: magic, version, tensor_count, kv_count, KV pairs, tensor infos,
// alignment padding, tensor data. Tensor sizes are derived from offset
// differences, which works for every quantisation type.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const UA = { 'User-Agent': 'ylide-registry-tool' };

async function fetchRange(url, start, end) {
  const res = await fetch(url, { headers: { ...UA, Range: `bytes=${start}-${end}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`${res.status} for ${url}`);
  const total = Number(res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length'));
  return { bytes: new Uint8Array(await res.arrayBuffer()), total };
}

class Truncated extends Error {}

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = 0;
  }
  need(n) { if (this.o + n > this.b.length) throw new Truncated(); }
  u8() { this.need(1); return this.v.getUint8(this.o++); }
  u32() { this.need(4); const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  i32() { this.need(4); const x = this.v.getInt32(this.o, true); this.o += 4; return x; }
  u64() { this.need(8); const x = this.v.getBigUint64(this.o, true); this.o += 8; return Number(x); }
  f32() { this.need(4); const x = this.v.getFloat32(this.o, true); this.o += 4; return x; }
  f64() { this.need(8); const x = this.v.getFloat64(this.o, true); this.o += 8; return x; }
  str() { const n = this.u64(); this.need(n); const s = new TextDecoder().decode(this.b.subarray(this.o, this.o + n)); this.o += n; return s; }
  value(type) {
    switch (type) {
      case 0: return this.u8();
      case 1: { this.need(1); return this.v.getInt8(this.o++); }
      case 2: { this.need(2); const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
      case 3: { this.need(2); const x = this.v.getInt16(this.o, true); this.o += 2; return x; }
      case 4: return this.u32();
      case 5: return this.i32();
      case 6: return this.f32();
      case 7: return this.u8() !== 0;
      case 8: return this.str();
      case 9: {
        const itemType = this.u32();
        const len = this.u64();
        // Large arrays (vocabularies) are skipped, only their length is kept.
        if (len > 4096) { for (let i = 0; i < len; i++) this.value(itemType); return { length: len }; }
        const out = [];
        for (let i = 0; i < len; i++) out.push(this.value(itemType));
        return out;
      }
      case 10: return this.u64();
      case 11: { this.need(8); const x = this.v.getBigInt64(this.o, true); this.o += 8; return Number(x); }
      case 12: return this.f64();
      default: throw new Error(`unknown GGUF value type ${type}`);
    }
  }
}

function parse(bytes, fileSize) {
  const r = new Reader(bytes);
  if (r.u32() !== 0x46554747) throw new Error('not a GGUF file');
  const version = r.u32();
  const tensorCount = r.u64();
  const kvCount = r.u64();
  const meta = {};
  for (let i = 0; i < kvCount; i++) {
    const key = r.str();
    meta[key] = r.value(r.u32());
  }
  const tensors = [];
  for (let i = 0; i < tensorCount; i++) {
    const name = r.str();
    const nDims = r.u32();
    const dims = [];
    for (let d = 0; d < nDims; d++) dims.push(r.u64());
    const type = r.u32();
    const offset = r.u64();
    tensors.push({ name, dims, type, offset });
  }
  const alignment = meta['general.alignment'] ?? 32;
  const dataStart = Math.ceil(r.o / alignment) * alignment;
  const sorted = [...tensors].sort((a, b) => a.offset - b.offset);
  sorted.forEach((t, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1].offset : fileSize - dataStart;
    t.size = next - t.offset;
  });
  return { version, meta, tensors, headerBytes: r.o };
}

export async function ggufMeta(repo, path, revision = 'main') {
  const url = `https://huggingface.co/${repo}/resolve/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
  let size = 8 << 20;
  for (;;) {
    const { bytes, total } = await fetchRange(url, 0, size - 1);
    try {
      return summarize(parse(bytes, total), total);
    } catch (e) {
      if (!(e instanceof Truncated) || size >= total) throw e;
      size *= 2;
    }
  }
}

const EXPERT = /\.ffn_(up|down|gate|gate_up)_(ch)?exps\b/;

function summarize({ meta, tensors }, fileSize) {
  const arch = meta['general.architecture'];
  const k = (name) => meta[`${arch}.${name}`];
  const layers = k('block_count');
  const headCountKv = k('attention.head_count_kv');
  const headCount = k('attention.head_count');
  const embd = k('embedding_length');
  const keyLength = k('attention.key_length') ?? (embd && headCount ? embd / headCount : undefined);
  const valueLength = k('attention.value_length') ?? keyLength;
  const kvPerLayer = Array.isArray(headCountKv) ? headCountKv : null;
  const fullInterval = k('full_attention_interval');
  const slidingWindow = k('attention.sliding_window');
  const swaPattern = k('attention.sliding_window_pattern');

  // Layers that hold a KV cache: those with attention K/V tensors.
  const attnLayers = new Set();
  for (const t of tensors) {
    const m = t.name.match(/^blk\.(\d+)\.attn_(k|v|kv_a_mqa|k_b)\b/);
    if (m) attnLayers.add(Number(m[1]));
  }
  const expertBytes = tensors.filter((t) => EXPERT.test(t.name)).reduce((s, t) => s + t.size, 0);
  const tokenEmbd = tensors.find((t) => t.name === 'token_embd.weight')?.size ?? 0;
  const total = tensors.reduce((s, t) => s + t.size, 0);

  let swaLayers = null;
  if (slidingWindow && Array.isArray(swaPattern)) swaLayers = swaPattern.filter(Boolean).length;
  else if (slidingWindow && typeof swaPattern === 'number' && swaPattern > 0) swaLayers = Math.round(layers - layers / swaPattern);

  return {
    architecture: arch,
    name: meta['general.name'],
    fileSize,
    layers,
    attentionLayers: attnLayers.size || layers,
    kvHeads: kvPerLayer ? Math.max(...kvPerLayer) : headCountKv,
    headDimK: keyLength,
    headDimV: valueLength,
    contextLength: k('context_length'),
    fullAttentionInterval: fullInterval ?? null,
    slidingWindow: slidingWindow ?? null,
    slidingWindowLayers: swaLayers,
    expertCount: k('expert_count') ?? null,
    expertUsedCount: k('expert_used_count') ?? null,
    expertFraction: expertBytes > 0 ? Number((expertBytes / total).toFixed(4)) : null,
    tokenEmbdBytes: tokenEmbd,
    kvLoraRank: k('attention.kv_lora_rank') ?? null,
    fim: {
      prefix: meta['tokenizer.ggml.fim_pre_token_id'] ?? null,
      suffix: meta['tokenizer.ggml.fim_suf_token_id'] ?? null,
      middle: meta['tokenizer.ggml.fim_mid_token_id'] ?? null,
    },
    poolingType: k('pooling_type') ?? null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--registry') {
    const [repo, path, rev] = args;
    if (!repo || !path) {
      console.error('usage: gguf-meta.mjs <repo> <path> [revision] | --registry [--write]');
      process.exit(2);
    }
    console.log(JSON.stringify(await ggufMeta(repo, path, rev), null, 2));
    return;
  }
  const write = args.includes('--write');
  const file = fileURLToPath(new URL('../../registry/models.json', import.meta.url));
  const registry = JSON.parse(await readFile(file, 'utf8'));
  for (const model of registry.models) {
    // The smallest real weights file gives the header fastest.
    const variant = [...model.variants].sort((a, b) => a.files[0].sizeBytes - b.files[0].sizeBytes)[0];
    const m = await ggufMeta(model.source.hfRepo, variant.files[0].path, model.source.revision);
    const a = model.architecture;
    const found = {
      layers: m.layers,
      attentionLayers: m.attentionLayers !== m.layers ? m.attentionLayers : null,
      kvHeads: m.kvHeads,
      headDimK: m.headDimK,
      headDimV: m.headDimV,
      slidingWindow: m.slidingWindow,
      slidingWindowLayers: m.slidingWindowLayers,
      expertFraction: m.expertFraction,
    };
    const diffs = Object.entries(found).filter(([key, v]) => v !== undefined && (a[key] ?? null) !== v);
    console.log(`${model.id}: ${m.architecture}, ${m.layers} layers, attn ${m.attentionLayers}, kv ${m.kvHeads}x${m.headDimK}/${m.headDimV}, swa ${m.slidingWindow ?? '-'}x${m.slidingWindowLayers ?? '-'}, experts ${m.expertFraction ?? '-'}`);
    for (const [key, v] of diffs) {
      console.log(`  ${key}: ${a[key] ?? 'unset'} -> ${v}`);
      if (write) {
        if (v === null) delete a[key];
        else a[key] = v;
      }
    }
  }
  if (write) await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
