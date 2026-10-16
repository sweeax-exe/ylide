import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { activate, focusEditor, requestClose, useDocuments, type DocTab } from './documents';
import { FileIcon } from './FileIcon';
import { tabElementId as tabId, tabLabels, type TabLabel } from './lib/paths';
import s from './Tabs.module.css';

export function TabStrip() {
  const { t } = useTranslation('editor');
  const tabs = useDocuments((st) => st.tabs);
  const active = useDocuments((st) => st.active);
  const strip = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => tabLabels(tabs.map((tab) => tab.path)), [tabs]);

  useEffect(() => {
    if (!active) return;
    document.getElementById(tabId(active))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number) => {
    const move = (to: number) => {
      const target = tabs[(to + tabs.length) % tabs.length];
      activate(target.path);
      document.getElementById(tabId(target.path))?.focus();
    };
    if (e.key === 'ArrowRight') move(index + 1);
    else if (e.key === 'ArrowLeft') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(tabs.length - 1);
    else if (e.key === 'Delete') requestClose(tabs[index].path);
    else if (e.key === 'Enter' || e.key === ' ') focusEditor();
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={strip}
      className={s.strip}
      role="tablist"
      aria-label={t('tabs.label')}
      data-preserve-focus
      onWheel={(e) => {
        if (strip.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((tab, i) => (
        <Tab key={tab.path} tab={tab} label={labels[tab.path]} active={tab.path === active} onKeyDown={(e) => onKeyDown(e, i)} />
      ))}
    </div>
  );
}

function Tab({ tab, label, active, onKeyDown }: { tab: DocTab; label: TabLabel; active: boolean; onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void }) {
  const { t } = useTranslation('editor');
  const state = tab.disk === 'deleted' ? t('tabs.deleted') : tab.dirty ? t('tabs.unsaved') : null;
  return (
    <div
      id={tabId(tab.path)}
      role="tab"
      aria-selected={active}
      aria-label={state ? `${label.name}, ${state}` : label.name}
      tabIndex={active ? 0 : -1}
      title={tab.path}
      className={[s.tab, active && s.active, tab.dirty && s.dirty, tab.disk === 'deleted' && s.deleted].filter(Boolean).join(' ')}
      onClick={() => {
        activate(tab.path);
        focusEditor();
      }}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        requestClose(tab.path);
      }}
      onKeyDown={onKeyDown}
    >
      <FileIcon name={label.name} className={s.icon} />
      <span className={s.name}>{label.name}</span>
      {label.hint && <span className={s.hint}>{label.hint}</span>}
      <button
        type="button"
        className={s.close}
        tabIndex={-1}
        aria-label={t('tabs.close', { name: label.name })}
        title={t('tabs.close', { name: label.name })}
        onClick={(e) => {
          e.stopPropagation();
          requestClose(tab.path);
        }}
      >
        <span className={s.dot} aria-hidden />
        <X size={13} className={s.x} aria-hidden />
      </button>
    </div>
  );
}
