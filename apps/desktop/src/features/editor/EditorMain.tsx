// The editor view once a project is open: tabs, disk-change banner, the
// Monaco editor (or a welcome when no file is open) and the close dialog.

import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/ui';
import { CodeEditor } from './CodeEditor';
import { cancelClose, closeDocument, cycleTab, keepMine, reloadDocument, requestClose, saveDocument, useDocuments, type DocTab } from './documents';
import s from './EditorMain.module.css';
import { basename } from './lib/paths';
import { TabStrip } from './Tabs';
import { Welcome } from './Welcome';

export function EditorMain() {
  const tabs = useDocuments((st) => st.tabs);
  const active = useDocuments((st) => st.active);
  const activeTab = tabs.find((tab) => tab.path === active) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const current = useDocuments.getState().active;
      const key = e.key.toLowerCase();
      if (key === 's' && !e.shiftKey) {
        e.preventDefault();
        if (current) void saveDocument(current);
      } else if (key === 'w' && !e.shiftKey) {
        e.preventDefault();
        if (current) requestClose(current);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        cycleTab(e.key === 'PageDown' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={s.area}>
      {tabs.length > 0 && <TabStrip />}
      {activeTab && activeTab.disk !== 'ok' && <DiskBanner tab={activeTab} />}
      {active ? <CodeEditor path={active} /> : <Welcome />}
      <CloseDialog />
    </div>
  );
}

function DiskBanner({ tab }: { tab: DocTab }) {
  const { t } = useTranslation('editor');
  const name = basename(tab.path);
  const deleted = tab.disk === 'deleted';
  return (
    <div className={s.banner} role="status">
      <TriangleAlert size={14} className={s.bannerIcon} aria-hidden />
      <span className={s.bannerText}>{deleted ? t('disk.deleted', { name }) : t('disk.changed', { name })}</span>
      {deleted ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => closeDocument(tab.path)}>
            {t('disk.close')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => keepMine(tab.path)}>
            {t('disk.keep')}
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" onClick={() => keepMine(tab.path)}>
            {t('disk.keepMine')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void reloadDocument(tab.path)}>
            {t('disk.reload')}
          </Button>
        </>
      )}
    </div>
  );
}

function CloseDialog() {
  const { t } = useTranslation('editor');
  const closing = useDocuments((st) => st.closing);
  const [saving, setSaving] = useState(false);
  const name = closing ? basename(closing) : '';

  const save = async () => {
    if (!closing) return;
    setSaving(true);
    const ok = await saveDocument(closing);
    setSaving(false);
    if (ok) closeDocument(closing);
  };

  return (
    <Dialog
      open={closing !== null}
      title={t('closeDialog.title', { name })}
      onClose={cancelClose}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => closing && closeDocument(closing)}>
            {t('closeDialog.discard')}
          </Button>
          <Button variant="secondary" onClick={cancelClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} data-autofocus>
            {t('closeDialog.save')}
          </Button>
        </>
      }
    >
      {t('closeDialog.body')}
    </Dialog>
  );
}
