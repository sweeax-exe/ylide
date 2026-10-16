// Main editor area. Monaco is loaded on demand: onboarding and the empty
// state never pay for it, and German UI strings are loaded into Monaco first.

import { FolderOpen } from 'lucide-react';
import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState, Spinner } from '../../components/ui';
import i18n, { monacoLanguage } from '../../i18n';
import { reportError } from '../../lib/errors';
import { pickFolder } from '../../lib/ipc';
import { useApp } from '../../state/app';
import s from './EditorArea.module.css';

// Monaco's own translations (menus, find widget, ...), where Monaco has one.
const MONACO_NLS: Record<string, () => Promise<unknown>> = {
  de: () => import('monaco-editor/nls/lang/de.js'),
  es: () => import('monaco-editor/nls/lang/es.js'),
  fr: () => import('monaco-editor/nls/lang/fr.js'),
  'pt-br': () => import('monaco-editor/nls/lang/pt-br.js'),
  'zh-cn': () => import('monaco-editor/nls/lang/zh-cn.js'),
  ja: () => import('monaco-editor/nls/lang/ja.js'),
  ko: () => import('monaco-editor/nls/lang/ko.js'),
  ru: () => import('monaco-editor/nls/lang/ru.js'),
};

let loader: Promise<{ default: ComponentType }> | null = null;

function loadEditor(): Promise<{ default: ComponentType }> {
  loader ??= (async () => {
    // Monaco reads its UI strings while its modules initialise.
    const nls = monacoLanguage(i18n.language);
    if (nls && MONACO_NLS[nls]) await MONACO_NLS[nls]();
    const m = await import('./EditorMain');
    return { default: m.EditorMain };
  })().catch((e: unknown) => {
    loader = null;
    throw e;
  });
  return loader;
}

// Replaced on retry: a lazy component that failed to load stays failed.
let EditorMain = lazy(loadEditor);

export function EditorArea() {
  const workspace = useApp((st) => st.workspace);
  const [attempt, setAttempt] = useState(0);
  if (!workspace) return <NoProject />;
  return (
    <EditorBoundary
      key={attempt}
      onRetry={() => {
        EditorMain = lazy(loadEditor);
        setAttempt((n) => n + 1);
      }}
    >
      <Suspense fallback={<Loading />}>
        <EditorMain />
      </Suspense>
    </EditorBoundary>
  );
}

function Loading() {
  const { t } = useTranslation('editor');
  return (
    <div className={s.center}>
      <Spinner label={t('loading')} />
    </div>
  );
}

function NoProject() {
  const { t } = useTranslation('editor');
  const openWorkspace = useApp((st) => st.openWorkspace);
  const lastProject = useApp((st) => st.settings?.lastProject ?? null);
  const [busy, setBusy] = useState(false);

  const open = async (choose: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const path = await choose();
      if (path) await openWorkspace(path);
    } catch (e) {
      reportError(e, t('errors.openFolder'));
    } finally {
      setBusy(false);
    }
  };

  const lastName = lastProject?.split(/[\\/]/).filter(Boolean).pop();
  return (
    <div className={s.center}>
      <EmptyState
        title={t('noProject.title')}
        body={t('noProject.body')}
        action={
          <div className={s.actions}>
            <Button variant="primary" icon={<FolderOpen size={15} />} loading={busy} onClick={() => void open(pickFolder)}>
              {t('common:actions.openFolder')}
            </Button>
            {lastProject && lastName && (
              <Button variant="ghost" disabled={busy} onClick={() => void open(async () => lastProject)} title={lastProject}>
                {t('noProject.reopen', { name: lastName })}
              </Button>
            )}
          </div>
        }
      />
    </div>
  );
}

class EditorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={s.center}>
        <EmptyState
          title={i18n.t('editor:failed.title')}
          body={i18n.t('editor:failed.body')}
          action={
            <Button variant="secondary" onClick={this.props.onRetry}>
              {i18n.t('common:actions.retry')}
            </Button>
          }
        />
      </div>
    );
  }
}
