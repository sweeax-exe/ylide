// One Monaco editor that shows the active document. Models are swapped per
// tab, with the view state (cursor, scroll, folding) kept per file.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorSettings } from '../../bindings/EditorSettings';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { useLayout } from '../../state/layout';
import s from './CodeEditor.module.css';
import { getModel, getViewState, registerViewStateCapture, saveDocument, setViewState, useDocuments } from './documents';
import { InlineEdit, type InlineEditHandle } from './InlineEdit';
import { tabElementId } from './lib/paths';
import { selectedLines } from './lib/text';
import { applyMonacoTheme, monaco, noBracketColours, reanchorEditorServices, remeasureWhenFontsLoad } from './monaco/setup';
import { focusIsPreserved } from './pathEvents';

/** Editor options from the settings. The bracket colour switch travels with every update (see noBracketColours). */
export function editorOptions(e: EditorSettings | undefined): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  if (!e) return { ...noBracketColours };
  return {
    ...noBracketColours,
    fontSize: e.fontSize,
    fontFamily: e.fontFamily,
    lineHeight: e.lineHeight,
    tabSize: e.tabSize,
    wordWrap: e.wordWrap ? 'on' : 'off',
    minimap: { enabled: e.minimap },
  };
}

const baseOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fixedOverflowWidgets: true,
  scrollBeyondLastLine: false,
  smoothScrolling: false,
  cursorSmoothCaretAnimation: 'off',
  fontLigatures: false,
  guides: { indentation: true, bracketPairs: false },
  renderLineHighlight: 'line',
  renderWhitespace: 'selection',
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  padding: { top: 8, bottom: 8 },
  scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  stickyScroll: { enabled: true },
};

/** Sends the selection (or the whole file when nothing is selected) to the chat composer. */
function addSelectionToChat(editor: monaco.editor.ICodeEditor, path: string) {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;
  const bridge = useEditorBridge.getState();
  if (sel.isEmpty()) {
    bridge.sendToChat([{ type: 'file', path }]);
  } else {
    const { startLine, endLine } = selectedLines(sel);
    bridge.sendToChat([{ type: 'selection', path, startLine, endLine, text: model.getValueInRange(sel) }]);
  }
  useLayout.getState().setRight('chat');
}

// Reveal and focus requests are applied once, even if the editor is mounted again later.
let appliedReveal = 0;
let appliedFocus = 0;

export function CodeEditor({ path }: { path: string }) {
  const { t } = useTranslation('editor');
  const container = useRef<HTMLDivElement>(null);
  const pathRef = useRef(path);
  const inline = useRef<InlineEditHandle>(null);
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorSettings = useApp((st) => st.settings?.editor);
  const themeChoice = useApp((st) => st.settings?.theme ?? 'dark');
  const reveal = useDocuments((st) => st.reveal);
  const focusSeq = useDocuments((st) => st.focusSeq);

  useEffect(() => {
    const settings = useApp.getState().settings?.editor;
    const instance = monaco.editor.create(container.current!, { ...baseOptions, ...editorOptions(settings), model: null });
    if (settings) remeasureWhenFontsLoad(settings.fontSize, settings.fontFamily);
    registerViewStateCapture(() => instance.saveViewState());
    setEditor(instance);
    return () => {
      setViewState(pathRef.current, instance.saveViewState());
      registerViewStateCapture(null);
      instance.dispose();
      reanchorEditorServices();
    };
  }, []);

  useEffect(() => {
    applyMonacoTheme(themeChoice);
    if (themeChoice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const follow = () => applyMonacoTheme('system');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [themeChoice]);

  useEffect(() => {
    editor?.updateOptions(editorOptions(editorSettings));
  }, [editor, editorSettings]);

  useEffect(() => {
    editor?.updateOptions({ ariaLabel: t('editorLabel', { path }) });
  }, [editor, path, t]);

  // Show the active document; save the outgoing one's view state.
  useEffect(() => {
    if (!editor) return;
    const model = getModel(path);
    if (!model) return;
    pathRef.current = path;
    if (editor.getModel() !== model) {
      editor.setModel(model);
      const state = getViewState(path);
      if (state) editor.restoreViewState(state);
    }
    if (!focusIsPreserved()) editor.focus();
    return () => setViewState(path, editor.getModel() === model ? editor.saveViewState() : getViewState(path));
  }, [editor, path]);

  useEffect(() => {
    if (!editor || focusSeq <= appliedFocus) return;
    appliedFocus = focusSeq;
    editor.focus();
  }, [editor, focusSeq]);

  // Reveal a requested line (search results, quick open, chat references).
  useEffect(() => {
    if (!editor || !reveal || reveal.path !== path || reveal.seq <= appliedReveal) return;
    const model = editor.getModel();
    if (!model || model !== getModel(path)) return;
    appliedReveal = reveal.seq;
    const line = Math.max(1, Math.min(reveal.line, model.getLineCount()));
    editor.setPosition({ lineNumber: line, column: Math.max(1, model.getLineFirstNonWhitespaceColumn(line)) });
    editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Immediate);
    const flash = editor.createDecorationsCollection([{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: s.revealedLine } }]);
    const timer = window.setTimeout(() => flash.clear(), 1400);
    if (!focusIsPreserved()) editor.focus();
    return () => {
      window.clearTimeout(timer);
      flash.clear();
    };
  }, [editor, path, reveal]);

  // Publish the selection to the bridge for chat and agents.
  useEffect(() => {
    if (!editor) return;
    let timer: number | undefined;
    const publish = () => {
      const model = editor.getModel();
      const sel = editor.getSelection();
      const bridge = useEditorBridge.getState();
      if (!model || !sel || sel.isEmpty()) {
        if (bridge.selection) bridge.setSelection(null);
        return;
      }
      const { startLine, endLine } = selectedLines(sel);
      bridge.setSelection({ path: pathRef.current, startLine, endLine, text: model.getValueInRange(sel), language: model.getLanguageId() });
    };
    const onSelection = editor.onDidChangeCursorSelection(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(publish, 120);
    });
    const onModel = editor.onDidChangeModel(publish);
    return () => {
      window.clearTimeout(timer);
      onSelection.dispose();
      onModel.dispose();
    };
  }, [editor]);

  // Editor commands. They also override Monaco defaults on the same keys
  // (Ctrl+L expands the line selection, Ctrl+Shift+L selects all occurrences).
  useEffect(() => {
    if (!editor) return;
    const { KeyMod, KeyCode } = monaco;
    const actions = [
      editor.addAction({
        id: 'ylide.inlineEdit',
        label: t('inline.action'),
        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyK],
        contextMenuGroupId: '0_ylide',
        contextMenuOrder: 1,
        run: () => inline.current?.open(),
      }),
      editor.addAction({
        id: 'ylide.addSelectionToChat',
        label: t('commands.addSelectionToChat'),
        keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL],
        contextMenuGroupId: '0_ylide',
        contextMenuOrder: 2,
        run: (ed) => addSelectionToChat(ed, pathRef.current),
      }),
      editor.addAction({
        id: 'ylide.openChat',
        label: t('commands.openChat'),
        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyL],
        run: () => useLayout.getState().setRight('chat'),
      }),
      editor.addAction({
        id: 'ylide.save',
        label: t('commands.save'),
        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
        run: () => void saveDocument(pathRef.current),
      }),
    ];
    return () => actions.forEach((a) => a.dispose());
  }, [editor, t]);

  // Monaco treats Ctrl+K as the start of key chords and would swallow it, so
  // the inline edit shortcut is taken before the event reaches the editor.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return;
    if (!container.current?.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    inline.current?.open();
  };

  return (
    <div className={s.host} role="tabpanel" aria-labelledby={tabElementId(path)} onKeyDownCapture={onKeyDownCapture}>
      {/* `monaco-component` lets Monaco's menus, which render next to the editor, inherit its theme colours. */}
      <div ref={container} className={`${s.monaco} monaco-component`} />
      {editor && <InlineEdit key={path} ref={inline} editor={editor} path={path} />}
    </div>
  );
}
