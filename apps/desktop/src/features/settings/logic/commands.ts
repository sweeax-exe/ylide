// Allowed command prefixes and command-line display.

/**
 * Shell constructs that make the core refuse automatic approval, mirroring
 * `is_allowlisted` in crates/agent/src/permissions.rs.
 */
export const CHAINING = ['&&', '||', ';', '|', '`', '$(', '>', '<'] as const;

export type PrefixProblem = 'empty' | 'chaining' | 'duplicate';

/** Why a prefix cannot be added to the allow list, or `null` if it can. */
export function prefixProblem(prefix: string, existing: readonly string[]): PrefixProblem | null {
  const p = normalizePrefix(prefix);
  if (!p) return 'empty';
  if (CHAINING.some((c) => p.includes(c))) return 'chaining';
  if (existing.some((e) => normalizePrefix(e) === p)) return 'duplicate';
  return null;
}

/** Collapses inner whitespace, so "cargo   test" and "cargo test" are the same prefix. */
export function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/\s+/g, ' ');
}

/** Quotes one argument for display, the way a shell user would type it. */
export function quoteArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"'`$&|<>;]/.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, '\\$1')}"`;
}

/** A copyable single-line command, e.g. for the llama-server transparency view. */
export function commandLine(args: readonly string[]): string {
  return args.map(quoteArg).join(' ');
}
