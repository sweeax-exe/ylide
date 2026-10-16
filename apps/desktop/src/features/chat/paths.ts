// Recognising project paths in answers, so the chat can offer "Open file".
// Only clear references count: inline code that is a path, or a code block
// that names its file (fence info, a first-line comment, or a lead-in
// paragraph like "Change `src/cart.ts`:"). Whether the file exists is checked
// separately (projectPaths.ts).

export interface PathRef {
  /** Normalised, as written (may be a bare file name). */
  path: string;
  line: number | null;
}

/** Common files without an extension that still clearly are file names. */
const EXTENSIONLESS = new Set(['Makefile', 'Dockerfile', 'Containerfile', 'Justfile', 'Procfile', 'Gemfile', 'Rakefile', 'LICENSE', 'CODEOWNERS']);

/**
 * Extensions that make a bare name (no folder) count as a file. Without this
 * list, member access such as `item.price` or `this.state` would look like a
 * file name; with a folder in front, any extension is accepted.
 */
const FILE_EXTENSIONS = new Set(
  (
    'ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx txt rst adoc html htm css scss sass less vue svelte astro ' +
    'rs py pyi go java kt kts scala groovy gradle c h cc cpp cxx hpp hh m mm cs fs vb swift dart rb php pl lua r jl ex exs erl hrl zig nim hs ml ' +
    'sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto toml yaml yml ini cfg conf env xml svg csv tsv lock mod sum ' +
    'tf hcl nix cmake mk dockerfile wgsl glsl hlsl ipynb'
  ).split(' '),
);

const PATH_RE = /^(?:\.\/)?((?:[\w@.+-]+\/)*[\w@.+-]+)(?::(\d+)(?::\d+)?)?$/;

/** Normalises separators and strips a leading `./` or the project root. */
export function normalizeRef(raw: string, root?: string | null): string {
  let p = raw.trim().replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) p = p.slice(r.length + 1);
  }
  return p.replace(/^\.\//, '');
}

/**
 * Parses text that is meant to be a path, e.g. `src/cart.ts` or `cart.ts:12`.
 * A path in a folder needs an extension that starts with a letter; a bare
 * name needs a known file extension. So `3.14`, `v1.2`, `item.price` and
 * plain words are not paths.
 */
export function parsePathRef(text: string, root?: string | null): PathRef | null {
  if (!text || text.length > 240 || /\s/.test(text.trim())) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  const m = PATH_RE.exec(normalizeRef(text, root));
  if (!m) return null;
  const path = m[1];
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name.startsWith('..')) return null;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const dotfile = name.startsWith('.') && name.length > 1 && name.indexOf('.', 1) < 0;
  const inFolder = path.includes('/');
  const fileLike = inFolder ? /^[a-z][a-z0-9]{0,9}$/i.test(ext) : FILE_EXTENSIONS.has(ext.toLowerCase());
  if (!dotfile && !EXTENSIONLESS.has(name) && !fileLike) return null;
  return { path, line: m[2] ? Number(m[2]) : null };
}

/** Path-like tokens in free text: inline code first, then bare tokens containing a slash. */
function refsInText(text: string, root?: string | null): PathRef[] {
  const out: PathRef[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const ref = parsePathRef(m[1], root);
    if (ref) out.push(ref);
  }
  if (out.length) return out;
  for (const token of text.replace(/`[^`]*`/g, ' ').split(/[\s,;()]+/)) {
    const cleaned = token.replace(/[:.]+$/, '');
    if (!cleaned.includes('/')) continue;
    const ref = parsePathRef(cleaned, root);
    if (ref) out.push(ref);
  }
  return out;
}

const COMMENT_RE = /^\s*(?:\/\/+|#+|--|;+|\/\*+|<!--|%)\s*(?:file(?:name)?\s*:\s*)?(\S+?)\s*(?:\*\/|-->)?\s*$/i;

/**
 * The file a fenced code block refers to.
 * `source` is the whole Markdown, `fenceOffset` the offset of the opening fence.
 */
export function codeBlockPath(source: string, fenceOffset: number, code: string, root?: string | null): PathRef | null {
  // 1. The fence info string: ```ts src/cart.ts, ```ts:src/cart.ts, ```ts title="src/cart.ts"
  const lineEnd = source.indexOf('\n', fenceOffset);
  const fence = source.slice(fenceOffset, lineEnd < 0 ? undefined : lineEnd);
  const info = /^\s*(?:`{3,}|~{3,})\s*(.*)$/.exec(fence)?.[1] ?? '';
  const [lang = '', ...meta] = info.trim().split(/\s+/);
  const candidates = [lang.includes(':') ? lang.slice(lang.indexOf(':') + 1) : '', ...meta.map((m) => m.replace(/^(?:title|file|filename|path)=/i, '').replace(/^["']|["']$/g, ''))];
  for (const c of candidates) {
    const ref = c && parsePathRef(c, root);
    if (ref) return ref;
  }

  // 2. A first-line comment that names the file: `// src/cart.ts`, `# file: app.py`
  const first = code.split('\n', 1)[0] ?? '';
  const comment = COMMENT_RE.exec(first);
  if (comment) {
    const ref = parsePathRef(comment[1], root);
    if (ref) return ref;
  }

  // 3. A lead-in paragraph directly above the block that ends with a colon.
  const before = source.slice(0, fenceOffset).replace(/\s+$/, '');
  if (!before.endsWith(':')) return null;
  let paragraph = before.slice(before.lastIndexOf('\n\n') + 1);
  const previousFence = paragraph.lastIndexOf('```');
  if (previousFence >= 0) paragraph = paragraph.slice(previousFence + 3);
  const refs = refsInText(paragraph, root);
  return refs.length ? refs[refs.length - 1] : null;
}

/**
 * Picks the project file `ref` refers to from file search results: an exact
 * path, or the only file whose path ends with it (a bare `cart.ts`).
 */
export function pickExisting(ref: string, results: string[]): string | null {
  const want = ref.toLowerCase();
  const exact = results.find((r) => r.toLowerCase() === want);
  if (exact) return exact;
  const suffix = results.filter((r) => r.toLowerCase().endsWith(`/${want}`));
  return suffix.length === 1 ? suffix[0] : null;
}

/**
 * 1-based line in `file` where `snippet` starts, using its first meaningful
 * line; null if it does not occur exactly once.
 */
export function findSnippetLine(file: string, snippet: string): number | null {
  const lines = file.split(/\r?\n/).map((l) => l.trim());
  const first = snippet
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 6 && !/^(\/\/|#|\/\*|\*|<!--|--)/.test(l));
  if (!first) return null;
  const hits = lines.flatMap((l, i) => (l === first ? [i + 1] : []));
  return hits.length === 1 ? hits[0] : null;
}
