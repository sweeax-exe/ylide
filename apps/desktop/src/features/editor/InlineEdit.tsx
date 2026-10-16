// Inline edit (Ctrl+K): a prompt anchored above the selection, a streamed
// answer, then a diff review. The prompt lives in a view zone (Monaco keeps
// the space free and moves it with the code) and is drawn as an overlay next
// to Monaco's DOM, so its keyboard input never reaches the editor.

import { Square, WandSparkles, X } from 'lucide-react';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Braid } from '../../components/Braid';
import { Button, IconButton, Kbd } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { api, IpcError } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useLayout } from '../../state/layout';
import { DiffReview } from './DiffReview';
import s from './InlineEdit.module.css';
import { inlineTarget, minimalEdit, spliceLines } from './lib/text';
import { monaco } from './monaco/setup';

export interface InlineEditHandle {
  open(): void;
}

/** What the edit does with the tracked range: rewrite whole lines, fill a blank line, or insert above a line. */
type TargetKind = 'rewrite' | 'fillBlank' | 'insertAbove';

type Problem = { kind: 'noModel' } | { kind: 'noChange' } | { kind: 'error'; message: string };

type Phase =
  | { kind: 'closed' }
  | { kind: 'prompt'; problem: Problem | null }
  | { kind: 'streaming'; id: string; text: string }
  | { kind: 'review'; replacement: string; original: string; modified: string };

interface Session {
  target: TargetKind;
  decorations: monaco.editor.IEditorDecorationsCollection;
  zone: monaco.editor.IViewZone;
  zoneId: string;
}

let lastInstruction = '';

function linesOf(target: TargetKind, range: monaco.IRange): { startLine: number; endLine: number } {
  if (target === 'rewrite') return { startLine: range.startLineNumber, endLine: range.endLineNumber };
  if (target === 'fillBlank') return { startLine: range.startLineNumber, endLine: range.startLineNumber };
  return { startLine: range.startLineNumber, endLine: range.startLineNumber - 1 };
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `inline-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function InlineEdit({ ref, editor, path }: { ref: Ref<InlineEditHandle>; editor: monaco.editor.IStandaloneCodeEditor; path: string }) {
  const { t } = useTranslation('editor');
  const [phase, setPhase] = useState<Phase>({ kind: 'closed' });
  const [instruction, setInstruction] = useState('');
  const [box, setBox] = useState({ left: 0, width: 480 });
  const server = useApp((st) => st.server);
  const phaseRef = useRef(phase);
  const session = useRef<Session | null>(null);
  const requestId = useRef<string | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLPreElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const zoneTop = useRef(-1e6);
  const contextKey = useRef<monaco.editor.IContextKey<boolean> | null>(null);
  // Streamed text is collected here and shown once per frame, not once per token.
  const streamed = useRef('');
  const frame = useRef(0);

  useLayoutEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const modelMissing = !server || server.status.state === 'stopped' || server.status.state === 'crashed';

  const endSession = () => {
    const current = session.current;
    session.current = null;
    if (current) {
      current.decorations.clear();
      editor.changeViewZones((acc) => acc.removeZone(current.zoneId));
    }
    contextKey.current?.set(false);
  };

  const stopRequest = () => {
    const id = requestId.current;
    requestId.current = null;
    if (id) void api.chat.cancel(id).catch(() => undefined);
  };

  const cancel = () => {
    stopRequest();
    endSession();
    setPhase({ kind: 'closed' });
    editor.focus();
  };

  const open = () => {
    if (session.current) {
      if (phaseRef.current.kind === 'prompt') input.current?.focus();
      return;
    }
    const model = editor.getModel();
    const sel = editor.getSelection();
    if (!model || !sel) return;
    const target = inlineTarget(sel, (line) => model.getLineContent(line));
    const kind: TargetKind = target.mode === 'rewrite' ? 'rewrite' : target.endLine >= target.startLine ? 'fillBlank' : 'insertAbove';
    const endLine = Math.max(target.startLine, target.endLine);
    const range =
      kind === 'insertAbove' ? new monaco.Range(target.startLine, 1, target.startLine, 1) : new monaco.Range(target.startLine, 1, endLine, model.getLineMaxColumn(endLine));
    const decorations = editor.createDecorationsCollection([
      {
        range,
        options: {
          isWholeLine: kind !== 'insertAbove',
          className: kind === 'insertAbove' ? undefined : s.targetLines,
          linesDecorationsClassName: kind === 'insertAbove' ? undefined : s.targetGutter,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      },
    ]);
    const zone: monaco.editor.IViewZone = {
      afterLineNumber: target.startLine - 1,
      heightInPx: 56,
      domNode: document.createElement('div'),
      suppressMouseDown: true,
      onDomNodeTop: (top) => {
        zoneTop.current = top;
        if (overlay.current) overlay.current.style.top = `${top}px`;
      },
    };
    let zoneId = '';
    editor.changeViewZones((acc) => {
      zoneId = acc.addZone(zone);
    });
    session.current = { target: kind, decorations, zone, zoneId };
    contextKey.current?.set(true);
    editor.revealLinesInCenterIfOutsideViewport(Math.max(1, target.startLine - 1), endLine, monaco.editor.ScrollType.Immediate);
    setInstruction('');
    setPhase({ kind: 'prompt', problem: null });
  };

  useImperativeHandle(ref, () => ({ open }));

  const cancelRef = useRef(cancel);
  useLayoutEffect(() => {
    cancelRef.current = cancel;
  });

  // Escape in the editor closes the prompt while it is open (scoped by the context key).
  useEffect(() => {
    const key = editor.createContextKey<boolean>('ylideInlineOpen', false);
    contextKey.current = key;
    const escape = editor.addAction({
      id: 'ylide.inlineEdit.cancel',
      label: t('inline.cancel'),
      keybindings: [monaco.KeyCode.Escape],
      precondition: 'ylideInlineOpen',
      keybindingContext: 'ylideInlineOpen',
      run: () => cancelRef.current(),
    });
    return () => {
      escape.dispose();
      cancelAnimationFrame(frame.current);
      stopRequest();
      endSession();
      key.set(false);
    };
  }, [editor]);

  // Horizontal placement follows the editor layout (gutter width, scrollbar).
  useEffect(() => {
    const place = () => {
      const info = editor.getLayoutInfo();
      const available = info.contentWidth - info.verticalScrollbarWidth - 24;
      setBox({ left: info.contentLeft, width: Math.max(260, Math.min(680, available)) });
    };
    place();
    const sub = editor.onDidLayoutChange(place);
    return () => sub.dispose();
  }, [editor]);

  const visible = phase.kind === 'prompt' || phase.kind === 'streaming';

  // The view zone reserves exactly the overlay's height, so no code is hidden.
  useLayoutEffect(() => {
    const el = overlay.current;
    if (!visible || !el) return;
    el.style.top = `${zoneTop.current}px`;
    const fit = () => {
      const current = session.current;
      if (!current) return;
      const height = Math.ceil(el.offsetHeight) + 10;
      if (current.zone.heightInPx === height) return;
      current.zone.heightInPx = height;
      editor.changeViewZones((acc) => acc.layoutZone(current.zoneId));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, editor]);

  // Keep focus inside the widget so Escape and Enter keep working in every phase.
  useEffect(() => {
    if (phase.kind === 'prompt') input.current?.focus();
    if (phase.kind === 'streaming') stopButton.current?.focus();
  }, [phase.kind]);

  useEffect(() => {
    if (phase.kind === 'streaming' && preview.current) preview.current.scrollTop = preview.current.scrollHeight;
  }, [phase]);

  const finish = (id: string, replacement: string) => {
    const current = session.current;
    const model = editor.getModel();
    const range = current?.decorations.getRange(0);
    if (requestId.current !== id || !current || !model || !range) return;
    requestId.current = null;
    const original = model.getValue(monaco.editor.EndOfLinePreference.LF);
    const { startLine, endLine } = linesOf(current.target, range);
    const modified = spliceLines(original.split('\n'), startLine, endLine, replacement).join('\n');
    setPhase(modified === original ? { kind: 'prompt', problem: { kind: 'noChange' } } : { kind: 'review', replacement, original, modified });
  };

  const onDelta = (id: string, text: string) => {
    streamed.current += text;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const all = streamed.current;
      setPhase((p) => (p.kind === 'streaming' && p.id === id ? { ...p, text: all } : p));
    });
  };

  const fail = (id: string, e: unknown) => {
    if (requestId.current !== id) return;
    requestId.current = null;
    const noModel = e instanceof IpcError && e.code === 'no_model';
    setPhase({ kind: 'prompt', problem: noModel ? { kind: 'noModel' } : { kind: 'error', message: errorText(e) } });
  };

  const submit = async () => {
    const text = instruction.trim();
    const current = session.current;
    const model = editor.getModel();
    const range = current?.decorations.getRange(0);
    if (!text || !current || !model || !range) return;
    lastInstruction = text;
    const id = newId();
    requestId.current = id;
    streamed.current = '';
    setPhase({ kind: 'streaming', id, text: '' });
    const { startLine, endLine } = linesOf(current.target, range);
    try {
      await api.inline.edit(
        { id, path, language: model.getLanguageId(), content: model.getValue(monaco.editor.EndOfLinePreference.LF), startLine, endLine, instruction: text },
        (event) => {
          if (requestId.current !== id) return;
          if (event.type === 'delta') onDelta(id, event.text);
          else if (event.type === 'done') finish(id, event.replacement);
          else fail(id, new IpcError(event.error));
        },
      );
      // Streamed events can trail the command's response by a moment.
      window.setTimeout(() => fail(id, new IpcError({ code: 'generic', message: t('inline.noResult') })), 1500);
    } catch (e) {
      fail(id, e);
    }
  };

  const stop = () => {
    stopRequest();
    setPhase({ kind: 'prompt', problem: null });
  };

  const accept = () => {
    const current = session.current;
    const model = editor.getModel();
    const range = current?.decorations.getRange(0);
    const p = phaseRef.current;
    if (!current || !model || !range || p.kind !== 'review') return;
    const { startLine, endLine } = linesOf(current.target, range);
    const after = spliceLines(model.getLinesContent(), startLine, endLine, p.replacement).join(model.getEOL());
    const edit = minimalEdit(model.getValue(), after);
    endSession();
    setPhase({ kind: 'closed' });
    if (edit) {
      const a = model.getPositionAt(edit.start);
      const b = model.getPositionAt(edit.end);
      editor.pushUndoStop();
      editor.executeEdits('ylide.inlineEdit', [{ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: edit.text, forceMoveMarkers: true }]);
      editor.pushUndoStop();
      const lastLine = Math.min(model.getLineCount(), startLine + p.replacement.split('\n').length - 1);
      editor.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) });
      editor.revealLineInCenterIfOutsideViewport(lastLine);
    }
    editor.focus();
  };

  const retry = () => setPhase({ kind: 'prompt', problem: null });

  if (phase.kind === 'closed') return null;

  if (phase.kind === 'review') {
    return (
      <DiffReview
        language={editor.getModel()?.getLanguageId() ?? 'plaintext'}
        original={phase.original}
        modified={phase.modified}
        instruction={instruction.trim()}
        onAccept={accept}
        onReject={cancel}
        onRetry={retry}
      />
    );
  }

  const range = session.current?.decorations.getRange(0);
  const lines = session.current && range ? linesOf(session.current.target, range) : null;
  const scope = !lines ? '' : lines.endLine < lines.startLine || session.current?.target === 'fillBlank' ? t('inline.scopeInsert', { line: lines.startLine }) : lines.startLine === lines.endLine ? t('inline.scopeLine', { line: lines.startLine }) : t('inline.scopeLines', { start: lines.startLine, end: lines.endLine });
  const problem = phase.kind === 'prompt' ? (phase.problem ?? (modelMissing ? ({ kind: 'noModel' } as const) : null)) : null;

  return (
    <div
      ref={overlay}
      className={s.widget}
      style={{ left: box.left, width: box.width }}
      role="group"
      aria-label={t('inline.title')}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        cancel();
      }}
    >
      {phase.kind === 'prompt' ? (
        <div className={s.row}>
          <WandSparkles size={14} className={s.icon} aria-hidden />
          <input
            ref={input}
            className={s.input}
            value={instruction}
            placeholder={t('inline.placeholder')}
            aria-label={t('inline.instructionLabel', { scope })}
            spellCheck={false}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              } else if (e.key === 'ArrowUp' && !instruction && lastInstruction) {
                e.preventDefault();
                setInstruction(lastInstruction);
              }
            }}
          />
          <span className={s.scope}>{scope}</span>
          <span className={s.keys} aria-hidden>
            <Kbd>{t('keys.enter')}</Kbd>
          </span>
          <IconButton label={t('inline.cancel')} onClick={cancel} className={s.close}>
            <X size={14} />
          </IconButton>
        </div>
      ) : (
        <>
          <div className={s.row}>
            <Braid active size={12} />
            <span className={s.status} role="status" aria-live="polite">
              {t('inline.streaming')}
            </span>
            <span className={s.instruction} title={instruction}>
              {instruction}
            </span>
            <Button ref={stopButton} size="sm" variant="secondary" icon={<Square size={11} />} onClick={stop}>
              {t('common:actions.stop')}
            </Button>
          </div>
          {phase.text && (
            <pre ref={preview} className={s.preview} aria-hidden>
              {phase.text}
            </pre>
          )}
        </>
      )}
      {problem && (
        <div className={`${s.problem} ${problem.kind === 'error' ? s.danger : ''}`} role={problem.kind === 'error' ? 'alert' : 'status'}>
          {problem.kind === 'noModel' && (
            <>
              <span>{t('inline.noModel')}</span>
              <Button size="sm" variant="secondary" onClick={() => useLayout.getState().setMain('models')}>
                {t('inline.openModels')}
              </Button>
            </>
          )}
          {problem.kind === 'noChange' && <span>{t('inline.noChange')}</span>}
          {problem.kind === 'error' && <span>{problem.message}</span>}
        </div>
      )}
    </div>
  );
}
