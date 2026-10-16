// Parser for the unified diffs the core sends with file changes and edit
// approvals. Hunk headers drive the parsing, so content lines that happen to
// start with "---" or "+++" are not mistaken for file headers.

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content without the +/-/space prefix (the full header for hunks). */
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function cleanPath(raw: string): string | null {
  const path = raw.trim().split('\t')[0];
  if (path === '/dev/null' || path === '') return null;
  return path.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const current = (): DiffFile => {
    if (!file) {
      file = { oldPath: null, newPath: null, lines: [], additions: 0, deletions: 0 };
      files.push(file);
    }
    return file;
  };

  const rows = diff.replace(/\r\n/g, '\n').split('\n');
  if (rows[rows.length - 1] === '') rows.pop();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Hunk counts from some tools are off by one; a file or hunk header always wins.
    const header = (row.startsWith('--- ') && rows[i + 1]?.startsWith('+++ ') && HUNK.test(rows[i + 2] ?? '')) || HUNK.test(row) || row.startsWith('diff --git ');
    const inHunk = (oldLeft > 0 || newLeft > 0) && !header;
    if (!inHunk) {
      oldLeft = 0;
      newLeft = 0;
    }
    if (inHunk) {
      const f = current();
      const sign = row[0];
      if (sign === '+') {
        f.lines.push({ kind: 'add', text: row.slice(1), oldNo: null, newNo: newNo++ });
        f.additions++;
        newLeft--;
      } else if (sign === '-') {
        f.lines.push({ kind: 'del', text: row.slice(1), oldNo: oldNo++, newNo: null });
        f.deletions++;
        oldLeft--;
      } else if (sign === '\\') {
        f.lines.push({ kind: 'note', text: row.slice(1).trim(), oldNo: null, newNo: null });
      } else {
        // A context line; some tools strip the leading space of empty lines.
        f.lines.push({ kind: 'context', text: sign === ' ' ? row.slice(1) : row, oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (row.startsWith('\\')) {
      current().lines.push({ kind: 'note', text: row.slice(1).trim(), oldNo: null, newNo: null });
      continue;
    }
    if (row.startsWith('--- ')) {
      const f: DiffFile = { oldPath: cleanPath(row.slice(4)), newPath: null, lines: [], additions: 0, deletions: 0 };
      files.push(f);
      file = f;
      continue;
    }
    if (row.startsWith('+++ ')) {
      current().newPath = cleanPath(row.slice(4));
      continue;
    }
    const hunk = HUNK.exec(row);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      current().lines.push({ kind: 'hunk', text: row, oldNo: null, newNo: null });
      continue;
    }
    if (row.startsWith('diff ') || row.startsWith('index ') || row.startsWith('new file') || row.startsWith('deleted file') || row.startsWith('similarity') || row.startsWith('rename ')) continue;
    // Text outside any hunk (e.g. a diff without headers): keep it visible.
    const f = current();
    if (row.startsWith('+')) {
      f.lines.push({ kind: 'add', text: row.slice(1), oldNo: null, newNo: null });
      f.additions++;
    } else if (row.startsWith('-')) {
      f.lines.push({ kind: 'del', text: row.slice(1), oldNo: null, newNo: null });
      f.deletions++;
    } else {
      f.lines.push({ kind: 'context', text: row.startsWith(' ') ? row.slice(1) : row, oldNo: null, newNo: null });
    }
  }
  return files.filter((f) => f.lines.length > 0 || f.oldPath !== null || f.newPath !== null);
}

/** True if `text` looks like a unified diff (used for approval details). */
export function looksLikeDiff(text: string): boolean {
  return /^--- /m.test(text) && /^\+\+\+ /m.test(text) ? true : /^@@ -\d+/m.test(text);
}

/** First changed line in the new file, for "Open file" to jump to. */
export function firstChangedLine(files: DiffFile[]): number | undefined {
  for (const f of files) {
    // Where the next line of the new file would be; a deletion shows up there.
    let nextNew: number | null = null;
    for (const line of f.lines) {
      if (line.kind === 'hunk') {
        const m = HUNK.exec(line.text);
        nextNew = m ? Number(m[3]) : null;
      } else if (line.kind === 'add' && line.newNo !== null) {
        return line.newNo;
      } else if (line.kind === 'del') {
        const at = nextNew ?? line.oldNo;
        if (at !== null) return Math.max(1, at);
      } else if (line.newNo !== null) {
        nextNew = line.newNo + 1;
      }
    }
  }
  return undefined;
}

export function diffStats(files: DiffFile[]): { additions: number; deletions: number } {
  return files.reduce((acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }), { additions: 0, deletions: 0 });
}
