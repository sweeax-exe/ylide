// Agent roles: tool list, ids for custom roles, comparisons with defaults.

import type { RoleDefinition } from '../../../bindings/RoleDefinition';
import type { ToolRisk } from '../../../bindings/ToolRisk';

/** Every tool the agent core offers, with its risk (crates/agent/src/tools.rs). */
export const TOOLS: ReadonlyArray<{ name: string; risk: ToolRisk }> = [
  { name: 'list_dir', risk: 'read' },
  { name: 'read_file', risk: 'read' },
  { name: 'search', risk: 'read' },
  { name: 'find_files', risk: 'read' },
  { name: 'write_file', risk: 'write' },
  { name: 'edit_file', risk: 'write' },
  { name: 'delete_file', risk: 'delete' },
  { name: 'run_command', risk: 'execute' },
  { name: 'ask', risk: 'communicate' },
  { name: 'finish', risk: 'communicate' },
  { name: 'submit_plan', risk: 'communicate' },
  { name: 'submit_review', risk: 'communicate' },
];

export const READ_TOOLS = TOOLS.filter((t) => t.risk === 'read').map((t) => t.name);

export const BUILTIN_ROLE_IDS = ['orchestrator', 'coder', 'reviewer'] as const;

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** "Test writer" -> "test-writer"; umlauts are transliterated (ä -> ae). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** `base`, or `base-2`, `base-3` ... if it is taken. */
export function uniqueId(base: string, taken: readonly string[]): string {
  const root = base || 'role';
  if (!taken.includes(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root.slice(0, 29)}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export type RoleIdProblem = 'empty' | 'format' | 'taken';

export function roleIdProblem(id: string, taken: readonly string[]): RoleIdProblem | null {
  if (!id) return 'empty';
  if (!ID_PATTERN.test(id)) return 'format';
  if (taken.includes(id)) return 'taken';
  return null;
}

/** A new custom role, optionally copying prompt, tools and limits from another role. */
export function createRole(fields: { id: string; name: string; description: string }, template?: RoleDefinition): RoleDefinition {
  return {
    id: fields.id,
    name: fields.name.trim() || fields.id,
    description: fields.description.trim(),
    systemPrompt: template?.systemPrompt ?? '',
    tools: template ? [...template.tools] : [...READ_TOOLS, 'ask', 'finish'],
    model: template?.model ?? null,
    temperature: template?.temperature ?? null,
    maxSteps: template?.maxSteps ?? 20,
    builtin: false,
  };
}

/** True when a role matches its shipped default (ignores tool order). */
export function sameRole(a: RoleDefinition, b: RoleDefinition): boolean {
  const tools = (r: RoleDefinition) => [...r.tools].sort().join(',');
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.description === b.description &&
    a.systemPrompt === b.systemPrompt &&
    tools(a) === tools(b) &&
    a.model === b.model &&
    a.temperature === b.temperature &&
    a.maxSteps === b.maxSteps
  );
}

/** Toggles a tool and keeps the canonical order of `TOOLS`; unknown tools are kept at the end. */
export function toggleTool(tools: readonly string[], name: string, on: boolean): string[] {
  const set = new Set(tools);
  if (on) set.add(name);
  else set.delete(name);
  const known = TOOLS.map((t) => t.name).filter((n) => set.has(n));
  const unknown = [...set].filter((n) => !TOOLS.some((t) => t.name === n));
  return [...known, ...unknown];
}
