import { Bot, ChevronDown, Copy, FolderOpen, Files, MessageSquare, Minus, Search, Settings, Square, X, Cpu } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Braid, LogoMark } from '../components/Braid';
import { Kbd } from '../components/ui';
import { AgentAttention, AgentsPanel } from '../features/agents/AgentsPanel';
import { ChatPanel } from '../features/chat/ChatPanel';
import { EditorArea } from '../features/editor/EditorArea';
import { FileTreePanel } from '../features/editor/FileTreePanel';
import { QuickOpen } from '../features/editor/QuickOpen';
import { SearchPanel } from '../features/editor/SearchPanel';
import { ModelsView } from '../features/settings/ModelsView';
import { SettingsView } from '../features/settings/SettingsView';
import { reportError } from '../lib/errors';
import { formatTokens } from '../lib/format';
import { pickFolder } from '../lib/ipc';
import { readStored } from '../lib/storage';
import { useApp } from '../state/app';
import { useLayout } from '../state/layout';
import { Splitter } from './Splitter';
import s from './Workbench.module.css';
import { useMaximized, windowControls } from './window';

const SIZES_KEY = 'ylide.panelSizes';
// Key used before the product was renamed; read once and migrated.
const LEGACY_SIZES_KEY = 'anyon.panelSizes';

function loadSizes(): { sidebar: number; right: number } {
  try {
    return { sidebar: 264, right: 420, ...JSON.parse(readStored(SIZES_KEY, LEGACY_SIZES_KEY) ?? '{}') };
  } catch {
    return { sidebar: 264, right: 420 };
  }
}

export function Workbench() {
  const { t } = useTranslation();
  const layout = useLayout();
  const workspace = useApp((st) => st.workspace);
  const [sizes, setSizes] = useState(loadSizes);

  useEffect(() => {
    try {
      localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
    } catch {
      // ignore: sizes reset next start
    }
  }, [sizes]);

  useEffect(() => {
    void windowControls.setTitle(workspace ? `${workspace.name} · Ylide` : 'Ylide');
  }, [workspace]);

  // Global shortcuts (the editor handles its own, e.g. Ctrl+K and Ctrl+S).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'p' && !e.shiftKey) {
        e.preventDefault();
        layout.setQuickOpen(true);
      } else if (key === 'f' && e.shiftKey) {
        e.preventDefault();
        layout.setSidebar('search');
      } else if (key === 'b' && !e.shiftKey) {
        e.preventDefault();
        layout.setSidebar(layout.sidebar ? null : 'explorer');
      } else if (key === 'l' && !e.shiftKey) {
        e.preventDefault();
        layout.setRight('chat');
      } else if (key === 'a' && e.shiftKey) {
        e.preventDefault();
        layout.setRight('agents');
      } else if (key === ',') {
        e.preventDefault();
        layout.setMain(layout.main === 'settings' ? 'editor' : 'settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout]);

  return (
    <div className={s.workbench}>
      <TitleBar />
      <div className={s.middle}>
        <ActivityRail />
        {layout.sidebar && (
          <>
            <aside className={s.sidebar} style={{ width: sizes.sidebar }} aria-label={t(`rail.${layout.sidebar}`)}>
              {layout.sidebar === 'explorer' ? <FileTreePanel /> : <SearchPanel />}
            </aside>
            <Splitter width={sizes.sidebar} min={180} max={560} direction={1} label={t(`rail.${layout.sidebar}`)} onResize={(w) => setSizes((v) => ({ ...v, sidebar: w }))} />
          </>
        )}
        <main className={s.main}>
          {layout.main === 'settings' ? <SettingsView /> : layout.main === 'models' ? <ModelsView /> : <EditorArea />}
        </main>
        {layout.right && (
          <>
            <Splitter width={sizes.right} min={320} max={760} direction={-1} label={t(`rail.${layout.right}`)} onResize={(w) => setSizes((v) => ({ ...v, right: w }))} />
            <aside className={s.right} style={{ width: sizes.right }} aria-label={t(`rail.${layout.right}`)}>
              {layout.right === 'chat' ? <ChatPanel /> : <AgentsPanel />}
            </aside>
          </>
        )}
      </div>
      <StatusBar />
      {layout.quickOpen && <QuickOpen onClose={() => layout.setQuickOpen(false)} />}
      <AgentAttention />
    </div>
  );
}

function TitleBar() {
  const { t } = useTranslation();
  const workspace = useApp((st) => st.workspace);
  const openWorkspace = useApp((st) => st.openWorkspace);
  const setQuickOpen = useLayout((st) => st.setQuickOpen);
  const setMain = useLayout((st) => st.setMain);
  const maximized = useMaximized();

  const open = async () => {
    const path = await pickFolder();
    if (path) await openWorkspace(path).catch(reportError);
  };

  return (
    // Tauri toggles maximize itself on a double click in a drag region.
    <header className={s.titleBar} data-tauri-drag-region>
      <div className={s.brand} data-tauri-drag-region>
        <LogoMark size={20} />
      </div>
      <button className={`${s.projectButton} ${workspace ? '' : s.muted}`} onClick={open} title={workspace?.root ?? t('actions.openFolder')}>
        <FolderOpen size={14} />
        {workspace?.name ?? t('titlebar.noProject')}
        <ChevronDown size={12} />
      </button>
      <div className={s.titleCenter} data-tauri-drag-region>
        <button className={s.quickOpen} onClick={() => setQuickOpen(true)} disabled={!workspace}>
          <span>
            <Search size={12} style={{ marginRight: 6, verticalAlign: -2 }} />
            {t('titlebar.quickOpen')}
          </span>
          <span>
            <Kbd>{t('keys.ctrl')}</Kbd> <Kbd>P</Kbd>
          </span>
        </button>
      </div>
      <ModelPill onClick={() => setMain('models')} />
      <div className={s.windowControls}>
        <button className={s.windowButton} aria-label={t('window.minimize')} onClick={() => void windowControls.minimize()}>
          <Minus size={14} />
        </button>
        <button className={s.windowButton} aria-label={t(maximized ? 'window.restore' : 'window.maximize')} onClick={() => void windowControls.toggleMaximize()}>
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button className={`${s.windowButton} ${s.closeButton}`} aria-label={t('window.close')} onClick={() => void windowControls.close()}>
          <X size={15} />
        </button>
      </div>
    </header>
  );
}

function ModelPill({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  const server = useApp((st) => st.server);
  const state = server?.status.state;
  const busy = state === 'starting' || state === 'loading';
  const label = !server
    ? t('server.none')
    : state === 'ready'
      ? t('server.ready', { model: server.modelName })
      : state === 'crashed'
        ? t('server.crashed')
        : busy
          ? t(state === 'starting' ? 'server.starting' : 'server.loading', { model: server.modelName })
          : t('server.stopped');
  const dot = state === 'ready' ? s.ready : busy ? s.loading : state === 'crashed' ? s.crashed : '';
  return (
    <button className={s.modelPill} onClick={onClick} title={t('titlebar.modelMenu')}>
      {busy ? <Braid active size={12} /> : <span className={`${s.dot} ${dot}`} />}
      <span>{label}</span>
      <ChevronDown size={12} />
    </button>
  );
}

function ActivityRail() {
  const { t } = useTranslation();
  const layout = useLayout();
  const item = (pressed: boolean, label: string, icon: React.ReactNode, onClick: () => void) => (
    <button className={s.railButton} aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
      {icon}
    </button>
  );
  return (
    <nav className={s.rail} aria-label="Ylide">
      {item(layout.main === 'editor' && layout.sidebar === 'explorer', t('rail.explorer'), <Files size={19} />, () => layout.toggleSidebar('explorer'))}
      {item(layout.main === 'editor' && layout.sidebar === 'search', t('rail.search'), <Search size={19} />, () => layout.toggleSidebar('search'))}
      {item(layout.right === 'chat', t('rail.chat'), <MessageSquare size={19} />, () => layout.toggleRight('chat'))}
      {item(layout.right === 'agents', t('rail.agents'), <Bot size={19} />, () => layout.toggleRight('agents'))}
      <div className={s.railSpacer} />
      {item(layout.main === 'models', t('rail.models'), <Cpu size={19} />, () => layout.setMain(layout.main === 'models' ? 'editor' : 'models'))}
      {item(layout.main === 'settings', t('rail.settings'), <Settings size={19} />, () => layout.setMain(layout.main === 'settings' ? 'editor' : 'settings'))}
    </nav>
  );
}

function StatusBar() {
  const { t } = useTranslation();
  const server = useApp((st) => st.server);
  const lastNetwork = useApp((st) => st.lastNetwork);
  const recent = lastNetwork && Date.now() - lastNetwork.atUnixMs < 60_000;
  return (
    <footer className={s.statusBar}>
      <span className={`${s.statusItem} ${s.local}`} title={t('status.offline')}>
        <span className={s.dot} style={{ background: 'var(--metal)' }} />
        {recent ? t('status.networkActivity', { purpose: t(`netPurpose.${lastNetwork.purpose}`) }) : t('status.offline')}
      </span>
      <span className={s.statusGrow} />
      {server && (
        <>
          <span className={s.statusItem}>{t('status.runtime', { name: server.device ? `${server.runtime} · ${server.device}` : server.runtime })}</span>
          <span className={s.statusItem}>{t('status.context', { tokens: formatTokens(server.context) })}</span>
        </>
      )}
    </footer>
  );
}
