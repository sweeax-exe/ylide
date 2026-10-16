import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store talks to the core only through lib/ipc; everything else that
// touches the browser is stubbed so the store runs under node.
const api = vi.hoisted(() => ({
  appInfo: vi.fn(),
  settings: { get: vi.fn(), set: vi.fn() },
  registry: { info: vi.fn() },
  models: { installed: vi.fn(), downloads: vi.fn() },
  server: { info: vi.fn() },
  workspace: { current: vi.fn(), open: vi.fn() },
  hardware: { probe: vi.fn() },
  runtime: { status: vi.fn() },
  updates: { check: vi.fn(async () => ({ result: 'upToDate' })), install: vi.fn() },
}));
vi.mock('../lib/ipc', () => ({ api, onEvent: vi.fn(async () => () => undefined), isTauri: false, IpcError: Error }));
vi.mock('../design/applyTheme', () => ({ applyTheme: vi.fn(), resolveTheme: vi.fn(() => 'dark') }));
vi.mock('../i18n', () => ({ default: { t: (key: string) => key, exists: () => false }, setLanguage: vi.fn() }));

const info = (root: string) => ({ root, name: root.split('/').pop() ?? root });

function settings(overrides: Record<string, unknown> = {}) {
  return { onboardingDone: true, lastProject: 'D:/a', theme: 'dark', language: null, ...overrides };
}

/** A promise that the test resolves by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

async function load(options: { settings?: Record<string, unknown>; current?: ReturnType<typeof info> | null } = {}) {
  vi.resetModules();
  api.appInfo.mockResolvedValue({});
  api.settings.get.mockResolvedValue(settings(options.settings));
  api.settings.set.mockImplementation(async (s: unknown) => structuredClone(s));
  api.registry.info.mockResolvedValue({ registry: null, origin: 'bundled' });
  api.models.installed.mockResolvedValue([]);
  api.models.downloads.mockResolvedValue([]);
  api.server.info.mockResolvedValue(null);
  api.workspace.current.mockResolvedValue(options.current ?? null);
  api.workspace.open.mockImplementation(async (path: string) => info(path));
  api.hardware.probe.mockResolvedValue({});
  api.runtime.status.mockResolvedValue({});
  const { useApp } = await import('./app');
  const { useEditorBridge } = await import('./editorBridge');
  const { useConfirm } = await import('./confirm');
  return { useApp, useEditorBridge, useConfirm };
}

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ addEventListener: () => undefined }) });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('project reopen at startup', () => {
  it('reopens the last project once, even when init runs twice at the same time', async () => {
    const { useApp } = await load();
    await Promise.all([useApp.getState().init(), useApp.getState().init()]);
    await flush();
    expect(api.workspace.open).toHaveBeenCalledTimes(1);
    expect(api.workspace.open).toHaveBeenCalledWith('D:/a');
    expect(useApp.getState().workspace?.root).toBe('D:/a');
    expect(useApp.getState().settings?.lastProject).toBe('D:/a');
  });

  it.each([
    ['during onboarding', { settings: { onboardingDone: false } }],
    ['without a last project', { settings: { lastProject: null } }],
    ['when the core already has a project open', { current: info('D:/open') }],
  ])('does not reopen %s', async (_label, options) => {
    const { useApp } = await load(options);
    await useApp.getState().init();
    await flush();
    expect(api.workspace.open).not.toHaveBeenCalled();
  });

  it('only logs a failed reopen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { useApp } = await load();
    api.workspace.open.mockRejectedValueOnce(new Error('gone'));
    await useApp.getState().init();
    await flush();
    expect(useApp.getState().workspace).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('opens a folder picked during the reopen afterwards, and later saves keep it', async () => {
    const { useApp } = await load();
    const reopen = deferred<ReturnType<typeof info>>();
    api.workspace.open.mockImplementationOnce(() => reopen.promise);
    await useApp.getState().init();
    const picked = useApp.getState().openWorkspace('D:/b');
    reopen.resolve(info('D:/a'));
    await picked;
    expect(api.workspace.open.mock.calls.map((c) => c[0])).toEqual(['D:/a', 'D:/b']);
    expect(useApp.getState().workspace?.root).toBe('D:/b');
    await useApp.getState().updateSettings((s) => {
      s.theme = 'light';
    });
    expect(api.settings.set).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'light', lastProject: 'D:/b' }));
  });

  it('asks about unsaved files that appeared while a queued open was waiting', async () => {
    const { useApp, useEditorBridge, useConfirm } = await load();
    const reopen = deferred<ReturnType<typeof info>>();
    api.workspace.open.mockImplementationOnce(() => reopen.promise);
    await useApp.getState().init();
    // No project is open yet, so a check before queueing would see nothing to lose.
    const picked = useApp.getState().openWorkspace('D:/b');
    useEditorBridge.getState().setDirtyPaths(['src/main.rs']);
    reopen.resolve(info('D:/a'));
    await flush();
    expect(useConfirm.getState().current).not.toBeNull();
    useConfirm.getState().settle(false);
    expect((await picked).root).toBe('D:/a');
    expect(api.workspace.open).toHaveBeenCalledTimes(1);
  });
});
