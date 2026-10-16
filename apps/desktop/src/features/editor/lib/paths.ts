// Project-relative paths with forward slashes, as the core uses them.

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Parent folder; `''` is the project root. */
export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  const clean = name.replace(/^\/+|\/+$/g, '');
  return dir ? `${dir}/${clean}` : clean;
}

/** True when `path` is `ancestor` itself or lies below it. The root `''` contains everything. */
export function isWithin(path: string, ancestor: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Moves `path` from below `from` to below `to` (for renames of folders). */
export function replacePrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  return isWithin(path, from) ? `${to}${path.slice(from.length)}` : path;
}

/** All folders that contain `path`, outermost first (`a/b/c.ts` -> `a`, `a/b`). */
export function ancestors(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function extension(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

export type NameProblem = 'empty' | 'invalid';

/** Checks a file or folder name typed into the tree. Slashes create nested folders. */
export function validateName(name: string): NameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (/[\\:*?"<>|]/.test(trimmed)) return 'invalid';
  const parts = trimmed.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p !== p.trim())) return 'invalid';
  return null;
}

/** DOM id of an editor tab, so the editor panel can name the tab it belongs to. */
export const tabElementId = (path: string) => `editor-tab-${encodeURIComponent(path)}`;

export interface TabLabel {
  name: string;
  /** Folder suffix that tells tabs with the same file name apart, or null. */
  hint: string | null;
}

/** Labels for editor tabs: the file name, plus the shortest distinguishing folder suffix for duplicates. */
export function tabLabels(paths: string[]): Record<string, TabLabel> {
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    const n = basename(p);
    byName.set(n, [...(byName.get(n) ?? []), p]);
  }
  const out: Record<string, TabLabel> = {};
  for (const [name, group] of byName) {
    if (group.length === 1) {
      out[group[0]] = { name, hint: null };
      continue;
    }
    const dirs = group.map((p) => (dirname(p) ? dirname(p).split('/') : []));
    group.forEach((p, i) => {
      const own = dirs[i];
      if (own.length === 0) {
        out[p] = { name, hint: null };
        return;
      }
      let k = 1;
      const suffix = (segs: string[], n: number) => segs.slice(Math.max(0, segs.length - n)).join('/');
      while (k < own.length && dirs.some((d, j) => j !== i && suffix(d, k) === suffix(own, k))) k++;
      out[p] = { name, hint: suffix(own, k) };
    });
  }
  return out;
}
