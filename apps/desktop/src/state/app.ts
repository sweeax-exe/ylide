// App-wide state: settings, hardware, registry, models, runtime and the open
// project. Kept in sync with the core through events.

import { create } from 'zustand';
import type { AppInfo } from '../bindings/AppInfo';
import type { DownloadJob } from '../bindings/DownloadJob';
import type { HardwareProfile } from '../bindings/HardwareProfile';
import type { InstalledModel } from '../bindings/InstalledModel';
import type { NetworkLogEntry } from '../bindings/NetworkLogEntry';
import type { Registry } from '../bindings/Registry';
import type { RegistryOrigin } from '../bindings/RegistryOrigin';
import type { RuntimeInstall } from '../bindings/RuntimeInstall';
import type { RuntimeStatus } from '../bindings/RuntimeStatus';
import type { ServerInfo } from '../bindings/ServerInfo';
import type { Settings } from '../bindings/Settings';
import type { WorkspaceInfo } from '../bindings/WorkspaceInfo';
import { applyTheme, resolveTheme } from '../design/applyTheme';
import i18n, { setLanguage } from '../i18n';
import { errorText } from '../lib/errors';
import { api, onEvent } from '../lib/ipc';
import { useConfirm } from './confirm';
import { useEditorBridge } from './editorBridge';
import { useUpdates } from './updates';

interface AppState {
  ready: boolean;
  /** The last project is being reopened at startup (until that open succeeds or fails). */
  reopening: boolean;
  info: AppInfo | null;
  settings: Settings | null;
  hardware: HardwareProfile | null;
  registry: Registry | null;
  registryOrigin: RegistryOrigin | null;
  installed: InstalledModel[];
  downloads: Record<string, DownloadJob>;
  runtime: RuntimeStatus | null;
  runtimeInstall: RuntimeInstall | null;
  server: ServerInfo | null;
  serverLog: string[];
  workspace: WorkspaceInfo | null;
  lastNetwork: NetworkLogEntry | null;

  /** Set when the runtime status could not be read (shown by the model views). */
  runtimeError: string | null;

  init(): Promise<void>;
  /**
   * Saves a modified copy of the settings and applies theme/language. Calls
   * are queued: each change is applied to the settings saved by the previous
   * call, so overlapping saves from different features never drop a change.
   */
  updateSettings(change: (draft: Settings) => void): Promise<void>;
  refreshModels(): Promise<void>;
  refreshRuntime(): Promise<void>;
  /**
   * Opens a project folder. If the editor has unsaved changes and the folder
   * differs from the open one, the user is asked first; declining keeps (and
   * returns) the current project.
   */
  openWorkspace(path: string): Promise<WorkspaceInfo>;
}

const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The running or finished `init()`. */
let initRun: Promise<void> | null = null;

/** Tail of the settings save queue (see `updateSettings`). */
let settingsQueue: Promise<unknown> = Promise.resolve();

/** Runs `task` after every earlier settings change has finished. */
function queueSettings<T>(task: () => Promise<T>): Promise<T> {
  const next = settingsQueue.then(task, task);
  settingsQueue = next.catch(() => undefined);
  return next;
}

function applyLook(settings: Settings) {
  applyTheme(resolveTheme(settings.theme));
  setLanguage(settings.language);
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  reopening: false,
  info: null,
  settings: null,
  hardware: null,
  registry: null,
  registryOrigin: null,
  installed: [],
  downloads: {},
  runtime: null,
  runtimeInstall: null,
  server: null,
  serverLog: [],
  workspace: null,
  lastNetwork: null,
  runtimeError: null,

  init() {
    // One run for all callers (React StrictMode runs effects twice in development).
    initRun ??= (async () => {
      const [info, settings, registry, installed, downloads, server, workspace] = await Promise.all([
        api.appInfo(),
        api.settings.get(),
        api.registry.info(),
        api.models.installed(),
        api.models.downloads(),
        api.server.info(),
        api.workspace.current(),
      ]);
      applyLook(settings);
      const reopen = !workspace && settings.onboardingDone && settings.lastProject ? settings.lastProject : null;
      set({
        reopening: reopen !== null,
        info,
        settings,
        registry: registry.registry,
        registryOrigin: registry.origin,
        installed,
        downloads: Object.fromEntries(downloads.map((d) => [d.jobId, d])),
        server,
        workspace,
        ready: true,
      });
      // Reopen the last project (the core keeps an open one across web view
      // reloads). Like every open it runs in the settings queue, so a folder the
      // user picks meanwhile is opened after it and wins. Skipped during
      // onboarding, whose settings saves must not wait for the folder walk.
      if (reopen !== null) {
        void get()
          .openWorkspace(reopen)
          .catch((e) => console.warn('could not reopen the last project', e))
          .finally(() => set({ reopening: false }));
      }
      // One update check per start, after onboarding (the core skips it when
      // the user switched update checks off).
      if (settings.onboardingDone) void useUpdates.getState().check({ startup: true });
      void onEvent('models://job', (job) => {
        set((s) => ({ downloads: { ...s.downloads, [job.jobId]: job } }));
        if (job.state.state === 'completed') void get().refreshModels();
      });
      void onEvent('runtime://server', (server) => set({ server }));
      void onEvent('runtime://install', (runtimeInstall) => {
        set({ runtimeInstall });
        if (runtimeInstall.state.state === 'done') void get().refreshRuntime();
      });
      void onEvent('runtime://log', (line) => set((s) => ({ serverLog: [...s.serverLog.slice(-1999), line] })));
      void onEvent('network://log', (entry) => set({ lastNetwork: entry }));
      void onEvent('registry://updated', async () => {
        const r = await api.registry.info();
        set({ registry: r.registry, registryOrigin: r.origin });
      });
      // Follow the system theme while "system" is selected.
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        const s = get().settings;
        if (s?.theme === 'system') applyLook(s);
      });
      void api.hardware
        .probe()
        .then((hardware) => set({ hardware }))
        .catch((e) => console.error('hardware probe failed', e))
        .finally(() => void get().refreshRuntime().catch(() => undefined));
    })().catch((e: unknown) => {
      initRun = null;
      throw e;
    });
    return initRun;
  },

  updateSettings(change) {
    return queueSettings(async () => {
      const current = get().settings;
      if (!current) return;
      const draft = structuredClone(current);
      change(draft);
      const saved = await api.settings.set(draft);
      applyLook(saved);
      set({ settings: saved });
    });
  },

  async refreshModels() {
    set({ installed: await api.models.installed() });
  },

  async refreshRuntime() {
    try {
      set({ runtime: await api.runtime.status(), runtimeError: null });
    } catch (e) {
      set({ runtimeError: errorText(e) });
      throw e;
    }
  },

  openWorkspace(path) {
    // The core records the folder as `lastProject` in the settings file. The
    // open runs in the save queue and the store's copy is updated with it, so
    // a save of an older copy cannot erase it again. The unsaved-changes check
    // runs inside the queue too, so an open that waited behind another one
    // sees the project and buffers of that moment.
    return queueSettings(async () => {
      const current = get().workspace;
      const dirty = useEditorBridge.getState().dirtyPaths;
      if (current && dirty.length > 0 && normalizePath(current.root) !== normalizePath(path)) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
        const ok = await useConfirm.getState().ask({
          title: i18n.t('common:switchProject.title'),
          body: i18n.t('common:switchProject.body', { count: dirty.length, name }),
          confirmLabel: i18n.t('common:switchProject.confirm'),
          danger: true,
        });
        if (!ok) return current;
      }
      const workspace = await api.workspace.open(path);
      const settings = get().settings;
      set({ workspace, settings: settings ? { ...settings, lastProject: workspace.root } : settings });
      return workspace;
    });
  },
}));

/** Display name of a registry model id. */
export function modelName(registry: Registry | null, id: string): string {
  return registry?.models.find((m) => m.id === id)?.name ?? id;
}
