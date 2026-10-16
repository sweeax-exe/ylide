import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { useLayout } from '../../state/layout';

const BUILTIN_ROLES = new Set(['orchestrator', 'coder', 'reviewer']);

/** Display name of an agent or role id ("user" is the person at the keyboard). */
export function useRoleName(): (id: string) => string {
  const { t } = useTranslation('agents');
  const roles = useApp((s) => s.settings?.agent.roles);
  return useCallback(
    (id: string) => {
      if (id === 'user') return t('roles.user');
      if (BUILTIN_ROLES.has(id)) return t(`roles.${id}`);
      const name = roles?.find((r) => r.id === id)?.name?.trim();
      return name || id;
    },
    [t, roles],
  );
}

/** Current time, refreshed every `interval` ms while `active`. */
export function useNow(active: boolean, interval = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [active, interval]);
  return now;
}

/** Shows a file in the editor (switching away from models/settings if needed). */
export function openInEditor(path: string, line?: number): void {
  useLayout.getState().setMain('editor');
  useEditorBridge.getState().open(path, line);
}
