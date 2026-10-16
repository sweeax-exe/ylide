// Offline Monaco: the ESM build with workers bundled by Vite, Ylide themes,
// and language defaults that suit single files without a project service.

import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { resolveTheme, type ThemeChoice } from '../../../design/applyTheme';
import { monacoTheme, toMonacoColor } from '../../../design/monacoTheme';
import { darkTheme, lightTheme, type Theme } from '../../../design/themes';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

/** The shared editor theme plus the colours of Monaco's own menus and pickers. */
function fullTheme(theme: Theme): monaco.editor.IStandaloneThemeData {
  const base = monacoTheme(theme);
  const c = theme.colors;
  const color = (v: string) => toMonacoColor(v);
  return {
    ...base,
    colors: {
      ...base.colors,
      'menu.background': color(c.bgRaised),
      'menu.foreground': color(c.text1),
      'menu.border': color(c.border),
      'menu.selectionBackground': color(c.bgActive),
      'menu.selectionForeground': color(c.text1),
      'menu.separatorBackground': color(c.border),
      'widget.border': color(c.border),
      'editorWidget.foreground': color(c.text1),
      'quickInput.background': color(c.bgRaised),
      'quickInput.foreground': color(c.text1),
      'input.background': color(c.bgSunken),
      'input.foreground': color(c.text1),
      'input.border': color(c.border),
      'list.hoverBackground': color(c.bgHover),
      'list.activeSelectionBackground': color(c.bgActive),
      'list.activeSelectionForeground': color(c.text1),
      'list.inactiveSelectionBackground': color(c.bgHover),
      'list.highlightForeground': color(c.accent),
      'list.focusOutline': color(c.focus),
      'quickInputList.focusBackground': color(c.bgActive),
      'quickInputList.focusForeground': color(c.text1),
      'pickerGroup.foreground': color(c.text3),
      'pickerGroup.border': color(c.border),
      'diffEditor.unchangedRegionBackground': color(c.bgApp),
      'diffEditor.unchangedRegionForeground': color(c.text3),
    },
  };
}

monaco.editor.defineTheme(darkTheme.id, fullTheme(darkTheme));
monaco.editor.defineTheme(lightTheme.id, fullTheme(lightTheme));

// Files are opened one by one without the project's tsconfig or node_modules,
// so semantic checks would flag every import. Syntax errors stay visible.
const ts = monaco.typescript;
for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true });
  defaults.setCompilerOptions({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
  });
  defaults.setEagerModelSync(true);
}
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, enableSchemaRequest: false, schemaValidation: 'ignore' });

/**
 * Rainbow brackets would add colours outside the palette. Editors read the
 * nested option. Models read Monaco's shared configuration, which only takes
 * option names from its schema: the dotted name is in it, the nested object is
 * not. Without the dotted name, a later configuration change (for example from
 * the diff editor) switches the colours back on for every open model.
 */
export const noBracketColours = {
  bracketPairColorization: { enabled: false },
  'bracketPairColorization.enabled': false,
} as monaco.editor.IEditorOptions;

/** Applies the app theme to every Monaco editor ("system" follows the OS). */
export function applyMonacoTheme(choice: ThemeChoice): void {
  monaco.editor.setTheme(resolveTheme(choice).id);
}

let fontsMeasured = false;
/** Monaco measures glyphs once; measure again after the variable code font has loaded. */
export function remeasureWhenFontsLoad(fontSize: number, fontFamily: string): void {
  if (fontsMeasured || typeof document === 'undefined' || !document.fonts) return;
  fontsMeasured = true;
  void document.fonts
    .load(`${fontSize}px ${fontFamily}`)
    .catch(() => undefined)
    .then(() => document.fonts.ready)
    .then(() => monaco.editor.remeasureFonts());
}

// Every standalone editor registers process-wide helpers (hover delegates for
// menus, the code block renderer for hovers) bound to its own services. When
// the editor created last is disposed, those helpers point at disposed
// services and the context menu stops opening. A detached, model-less editor
// takes over the registration whenever a visible editor goes away.
let anchor: monaco.editor.IStandaloneCodeEditor | null = null;

/** Call after disposing an editor or diff editor. */
export function reanchorEditorServices(): void {
  const previous = anchor;
  anchor = monaco.editor.create(document.createElement('div'), { ...noBracketColours, model: null, automaticLayout: false, ariaLabel: '' });
  previous?.dispose();
}

export { monaco };
