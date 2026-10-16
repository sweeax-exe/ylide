import { describe, expect, it } from 'vitest';
import type { DownloadJob } from '../../../bindings/DownloadJob';
import type { Model } from '../../../bindings/Model';
import type { NetworkLogEntry } from '../../../bindings/NetworkLogEntry';
import type { Recommendation } from '../../../bindings/Recommendation';
import { commandLine, prefixProblem, quoteArg } from './commands';
import { filterByRole, localized, modelMark, orderCatalog, recommendationMarks, selectionKey, splitUncensored, variantBytes } from './catalog';
import { fraction, jobFor, remainingSeconds, visibleDownloads } from './downloads';
import { formatLines, isHttpUrl, numberText, optionalText, parseLines, parseNumber, sameList } from './forms';
import { formatLogTime, mergeEntries, mergeLines, outcomeTone } from './logs';
import { isSelfReported, reasonParams } from './reasons';
import { createRole, roleIdProblem, sameRole, slugify, toggleTool, TOOLS, uniqueId } from './roles';
import { availablePlaceholders, insertText, placeholdersIn, TEMPLATE_KEYS, TEMPLATE_PLACEHOLDERS, templateIssues } from './templates';

describe('parseNumber', () => {
  it('parses integers and decimals, also with a decimal comma', () => {
    expect(parseNumber('14', { integer: true })).toEqual({ ok: true, value: 14 });
    expect(parseNumber('1,55', {})).toEqual({ ok: true, value: 1.55 });
    expect(parseNumber(' 24 000 ', { integer: true })).toEqual({ ok: true, value: 24000 });
  });
  it('treats an empty optional field as the default', () => {
    expect(parseNumber('', { optional: true })).toEqual({ ok: true, value: null });
    expect(parseNumber('  ', {})).toEqual({ ok: false, problem: 'required' });
  });
  it('reports why a value is rejected', () => {
    expect(parseNumber('abc', {})).toEqual({ ok: false, problem: 'notNumber' });
    expect(parseNumber('1.5', { integer: true })).toEqual({ ok: false, problem: 'notInteger' });
    expect(parseNumber('2', { min: 6 })).toEqual({ ok: false, problem: 'tooSmall' });
    expect(parseNumber('99', { max: 32 })).toEqual({ ok: false, problem: 'tooLarge' });
    expect(parseNumber('1e5', {})).toEqual({ ok: false, problem: 'notNumber' });
  });
  it('round-trips through numberText', () => {
    expect(numberText(null)).toBe('');
    expect(numberText(0.7)).toBe('0.7');
  });
});

describe('lines and text', () => {
  it('splits one entry per line and drops blanks', () => {
    expect(parseLines(' --jinja\r\n\n  -fa on \n')).toEqual(['--jinja', '-fa on']);
    expect(formatLines(['a', 'b'])).toBe('a\nb');
    expect(sameList(['a'], ['a'])).toBe(true);
    expect(sameList(['a'], ['a', 'b'])).toBe(false);
  });
  it('maps blank optional text to null', () => {
    expect(optionalText('  ')).toBeNull();
    expect(optionalText(' qwen ')).toBe('qwen');
  });
  it('accepts only http(s) URLs', () => {
    expect(isHttpUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isHttpUrl('https://example.org/models.json')).toBe(true);
    expect(isHttpUrl('ftp://example.org')).toBe(false);
    expect(isHttpUrl('localhost:8080')).toBe(false);
  });
});

describe('command prefixes', () => {
  it('rejects chaining, duplicates and empty prefixes', () => {
    expect(prefixProblem('cargo test', [])).toBeNull();
    expect(prefixProblem('  ', [])).toBe('empty');
    expect(prefixProblem('npm test && rm x', [])).toBe('chaining');
    expect(prefixProblem('cat a | grep', [])).toBe('chaining');
    expect(prefixProblem('cargo   test', ['cargo test'])).toBe('duplicate');
  });
  it('quotes arguments for display', () => {
    expect(quoteArg('-m')).toBe('-m');
    expect(quoteArg('C:/Program Files/x.gguf')).toBe('"C:/Program Files/x.gguf"');
    expect(quoteArg('')).toBe('""');
    expect(commandLine(['llama-server', '-c', '131072', '--alias', 'a "b"'])).toBe('llama-server -c 131072 --alias "a \\"b\\""');
  });
});

describe('roles', () => {
  it('slugifies names', () => {
    expect(slugify('Test writer')).toBe('test-writer');
    expect(slugify('Prüfer für Dokumentation')).toBe('pruefer-fuer-dokumentation');
    expect(slugify('  42 Docs! ')).toBe('docs');
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('x'.repeat(40))).toHaveLength(32);
  });
  it('finds a free id', () => {
    expect(uniqueId('coder', ['coder', 'coder-2'])).toBe('coder-3');
    expect(uniqueId('docs', ['coder'])).toBe('docs');
    expect(uniqueId('', [])).toBe('role');
  });
  it('validates ids', () => {
    expect(roleIdProblem('docs', ['coder'])).toBeNull();
    expect(roleIdProblem('', [])).toBe('empty');
    expect(roleIdProblem('Docs', [])).toBe('format');
    expect(roleIdProblem('2docs', [])).toBe('format');
    expect(roleIdProblem('coder', ['coder'])).toBe('taken');
  });
  it('creates custom roles from scratch or from a template', () => {
    const blank = createRole({ id: 'docs', name: ' Docs ', description: '' });
    expect(blank).toMatchObject({ id: 'docs', name: 'Docs', builtin: false, temperature: null, tools: ['list_dir', 'read_file', 'search', 'find_files', 'ask', 'finish'] });
    const copy = createRole({ id: 'c2', name: 'C2', description: 'd' }, { ...blank, systemPrompt: 'Be brief.', tools: ['read_file'], maxSteps: 7, builtin: true });
    expect(copy).toMatchObject({ systemPrompt: 'Be brief.', tools: ['read_file'], maxSteps: 7, builtin: false });
  });
  it('compares roles ignoring tool order', () => {
    const a = createRole({ id: 'x', name: 'X', description: '' });
    expect(sameRole(a, { ...a, tools: [...a.tools].reverse() })).toBe(true);
    expect(sameRole(a, { ...a, maxSteps: 1 })).toBe(false);
  });
  it('toggles tools in canonical order', () => {
    expect(toggleTool(['finish', 'read_file'], 'list_dir', true)).toEqual(['list_dir', 'read_file', 'finish']);
    expect(toggleTool(['read_file', 'custom_tool'], 'read_file', false)).toEqual(['custom_tool']);
    expect(TOOLS).toHaveLength(12);
  });
});

describe('templates', () => {
  it('lists placeholders like the core fill()', () => {
    expect(placeholdersIn('Task {task_id}: {task_title} {task_id} {"a": 1} {bad key}')).toEqual(['task_id', 'task_title']);
  });
  it('reports unknown and unused placeholders', () => {
    expect(templateIssues('Round {round}: {review} {extra}', TEMPLATE_PLACEHOLDERS.feedback)).toEqual({ unknown: ['extra'], missing: ['max_rounds'] });
    expect(templateIssues('Go on.', TEMPLATE_PLACEHOLDERS.continue)).toEqual({ unknown: [], missing: [] });
  });
  it('adds fields the shipped default uses', () => {
    expect(availablePlaceholders('feedback', 'Round {round} {new_field}')).toEqual(['round', 'max_rounds', 'review', 'new_field']);
    expect(availablePlaceholders('continue')).toEqual([]);
  });
  it('covers every template field', () => {
    expect(Object.keys(TEMPLATE_PLACEHOLDERS).sort()).toEqual([...TEMPLATE_KEYS].sort());
  });
  it('inserts at the caret', () => {
    expect(insertText('ab', 1, 1, '{x}')).toEqual({ text: 'a{x}b', caret: 4 });
    expect(insertText('abc', 1, 2, 'Z')).toEqual({ text: 'aZc', caret: 2 });
  });
});

const model = (id: string, roles: Model['roles'], quants: string[]): Model =>
  ({ id, name: id, roles, description: { en: `en ${id}`, de: `de ${id}` }, variants: quants.map((q) => ({ quant: q, bitsPerWeight: 4, qualityPenalty: 0, files: [{ path: `${q}.gguf`, sizeBytes: 100, sha256: '' }, { path: `${q}-2.gguf`, sizeBytes: 50, sha256: '' }] })) }) as unknown as Model;

describe('catalog', () => {
  const models = [model('a', ['chat'], ['Q4']), model('b', ['chat', 'agent'], ['Q4', 'Q8']), model('c', ['fim'], ['Q8'])];
  const candidate = (modelId: string, quant: string) => ({ modelId, quant }) as Recommendation['alternatives'][number]['candidate'];
  const rec = { primary: candidate('b', 'Q8'), alternatives: [{ kind: 'faster', candidate: candidate('b', 'Q4') }, { kind: 'lighter', candidate: candidate('a', 'Q4') }], autocomplete: candidate('c', 'Q8'), embedding: null } as unknown as Recommendation;

  it('filters by role', () => {
    expect(filterByRole(models, 'agent').map((m) => m.id)).toEqual(['b']);
    expect(filterByRole(models, 'all')).toHaveLength(3);
  });
  it('sums split files', () => {
    expect(variantBytes(models[0].variants[0])).toBe(150);
  });
  it('marks recommended configurations', () => {
    const marks = recommendationMarks(rec);
    expect(marks.get(selectionKey('b', 'Q8'))).toEqual({ kind: 'primary' });
    expect(marks.get(selectionKey('b', 'Q4'))).toEqual({ kind: 'alternative', alternative: 'faster' });
    expect(modelMark(marks, models[1])).toEqual({ kind: 'primary' });
    expect(modelMark(marks, models[2])).toEqual({ kind: 'autocomplete' });
    expect(recommendationMarks(null).size).toBe(0);
  });
  it('orders recommended models first', () => {
    expect(orderCatalog(models, recommendationMarks(rec)).map((m) => m.id)).toEqual(['b', 'a', 'c']);
  });
  it('puts uncensored variants in their own group, in catalog order', () => {
    const variants = [{ ...model('a-free', ['chat'], ['Q4']), uncensored: true }, { ...model('c-free', ['fim'], ['Q8']), uncensored: true }];
    const all = [variants[1], ...models, variants[0]];
    const { normal, uncensored } = splitUncensored(orderCatalog(all, recommendationMarks(rec)));
    expect(normal.map((m) => m.id)).toEqual(['b', 'a', 'c']);
    expect(uncensored.map((m) => m.id)).toEqual(['c-free', 'a-free']);
    // A recommendation mark (the core never sets one) does not move a variant into the normal group.
    const marked = { ...rec, primary: candidate('a-free', 'Q4') } as Recommendation;
    expect(splitUncensored(orderCatalog(all, recommendationMarks(marked))).uncensored.map((m) => m.id)).toEqual(['a-free', 'c-free']);
    expect(splitUncensored(filterByRole(all, 'agent'))).toEqual({ normal: [models[1]], uncensored: [] });
  });
  it('localizes with fallback', () => {
    expect(localized({ en: 'x', de: 'y' }, 'de')).toBe('y');
    expect(localized({ en: 'x' }, 'de')).toBe('x');
    expect(localized({ fr: 'z' }, 'de')).toBe('z');
    expect(localized({}, 'de')).toBe('');
  });
});

describe('downloads', () => {
  const job = (jobId: string, state: DownloadJob['state'], downloaded = 0, bps = 0): DownloadJob => ({
    jobId,
    modelId: jobId,
    quant: 'Q4',
    name: jobId,
    state,
    totalBytes: 1000,
    progress: downloaded ? { jobId, phase: 'downloading', fileIndex: 0, fileCount: 1, downloadedBytes: downloaded, totalBytes: 1000, bytesPerSecond: bps } : null,
  });
  const jobs = { a: job('a', { state: 'running' }, 250, 50), b: job('b', { state: 'completed' }), c: job('c', { state: 'failed', message: 'x' }), d: job('d', { state: 'cancelled' }) };

  it('shows only running, paused and failed jobs', () => {
    expect(visibleDownloads(jobs).map((j) => j.jobId)).toEqual(['a', 'c']);
    expect(jobFor(jobs, 'a', 'Q4')?.jobId).toBe('a');
    expect(jobFor(jobs, 'b', 'Q4')).toBeUndefined();
  });
  it('computes progress and time left', () => {
    expect(fraction(jobs.a)).toBe(0.25);
    expect(fraction(jobs.c)).toBe(0);
    expect(remainingSeconds(jobs.a.progress)).toBe(15);
    expect(remainingSeconds(null)).toBeNull();
    expect(remainingSeconds({ ...jobs.a.progress!, bytesPerSecond: 0 })).toBeNull();
  });
});

describe('logs', () => {
  it('merges a snapshot with live lines without duplicates', () => {
    expect(mergeLines(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
    expect(mergeLines(['a', 'b'], ['x'])).toEqual(['a', 'b', 'x']);
    expect(mergeLines([], ['x'])).toEqual(['x']);
    expect(mergeLines(['1', '2', '3'], ['4'], 2)).toEqual(['3', '4']);
  });
  it('merges network entries newest first', () => {
    const e = (at: number, url = 'u'): NetworkLogEntry => ({ atUnixMs: at, purpose: 'registry', url, outcome: '304' });
    expect(mergeEntries([e(1), e(2)], [e(2), e(3)]).map((x) => x.atUnixMs)).toEqual([3, 2, 1]);
  });
  it('keeps the same number of network entries as the core', () => {
    const many = Array.from({ length: 520 }, (_, i): NetworkLogEntry => ({ atUnixMs: i, purpose: 'registry', url: 'u', outcome: '304' }));
    const merged = mergeEntries(many, []);
    expect(merged).toHaveLength(500);
    expect(merged[0].atUnixMs).toBe(519);
    expect(mergeEntries(many, [], 3).map((x) => x.atUnixMs)).toEqual([519, 518, 517]);
  });
  it('classifies outcomes', () => {
    expect(outcomeTone('200')).toBe('success');
    expect(outcomeTone('304')).toBe('success');
    expect(outcomeTone('completed, checksum verified')).toBe('success');
    expect(outcomeTone('installed, checksums verified')).toBe('success');
    expect(outcomeTone('404 Not Found')).toBe('danger');
    expect(outcomeTone('failed: timeout')).toBe('danger');
    expect(outcomeTone('failed: checksum mismatch')).toBe('danger');
    expect(outcomeTone('refused: the signed installer is not Ylide_0.2.0_x64-setup.exe')).toBe('danger');
    expect(outcomeTone('requested')).toBe('neutral');
  });
  it('formats times with the date only for other days', () => {
    const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
    expect(formatLogTime(new Date(2026, 9, 15, 9, 5, 7).getTime(), 'de-DE', now)).toBe('09:05:07');
    expect(formatLogTime(new Date(2026, 9, 14, 9, 5, 7).getTime(), 'de-DE', now)).toBe('14.10. 09:05:07');
  });
});

describe('reasons', () => {
  const fmt = { level: (l: string) => `L:${l}`, tokens: (n: number) => `${n / 1024}K` };
  it('formats level and tokens and keeps other params', () => {
    expect(reasonParams({ code: 'toolCalling', params: { level: 'good' } }, fmt)).toEqual({ level: 'L:good' });
    expect(reasonParams({ code: 'longContext', params: { tokens: '131072' } }, fmt)).toEqual({ tokens: '128K' });
    expect(reasonParams({ code: 'fitsInVram', params: { vramGb: '9.5' } }, fmt)).toEqual({ vramGb: '9.5' });
  });
  it('detects self-reported benchmarks', () => {
    expect(isSelfReported({ code: 'benchmark', params: { selfReported: 'true' } })).toBe(true);
    expect(isSelfReported({ code: 'benchmark', params: { selfReported: 'false' } })).toBe(false);
    expect(isSelfReported({ code: 'speedEstimate', params: {} })).toBe(false);
  });
});
