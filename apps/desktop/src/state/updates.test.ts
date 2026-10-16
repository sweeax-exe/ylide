import { afterEach, describe, expect, it, vi } from 'vitest';

// The store talks to the core only through lib/ipc; i18n returns keys.
const api = vi.hoisted(() => ({ updates: { check: vi.fn(), download: vi.fn(), launch: vi.fn() } }));
vi.mock('../lib/ipc', () => ({ api, isTauri: false, IpcError: class extends Error {} }));
vi.mock('../i18n', () => ({ default: { t: (key: string) => key, exists: () => false } }));
const agentPhase = vi.hoisted(() => ({ value: 'idle' }));
vi.mock('../features/agents/store', () => ({ useAgentRun: { getState: () => ({ phase: agentPhase.value }) } }));

async function load() {
  vi.resetModules();
  const { useUpdates } = await import('./updates');
  const { useToasts } = await import('./toasts');
  const { useConfirm } = await import('./confirm');
  const { useEditorBridge } = await import('./editorBridge');
  return { useUpdates, useToasts, useConfirm, useEditorBridge };
}

const available = { result: 'available', version: '0.2.0', notes: null, date: null } as const;

/** Answers every confirm dialog with `ok` and returns what was asked. */
function answerConfirm(useConfirm: Awaited<ReturnType<typeof load>>['useConfirm'], ok: boolean) {
  const asked: Array<Record<string, unknown>> = [];
  vi.spyOn(useConfirm.getState(), 'ask').mockImplementation(async (request) => {
    asked.push(request as unknown as Record<string, unknown>);
    return ok;
  });
  return asked;
}

afterEach(() => {
  vi.clearAllMocks();
  agentPhase.value = 'idle';
});

describe('update check', () => {
  it('offers a newer version found at startup in a notice with an install button', async () => {
    const { useUpdates, useToasts } = await load();
    api.updates.check.mockResolvedValue(available);
    await useUpdates.getState().check({ startup: true });
    expect(api.updates.check).toHaveBeenCalledWith(true);
    expect(useUpdates.getState().outcome).toEqual(available);
    const [toast] = useToasts.getState().toasts;
    expect(toast.title).toBe('common:update.availableTitle');
    expect(toast.duration).toBe(0);
    expect(toast.action?.label).toBe('common:update.install');
  });

  it('stays silent at startup when nothing is newer, switched off or unreachable', async () => {
    const { useUpdates, useToasts } = await load();
    for (const outcome of [{ result: 'upToDate' }, { result: 'disabled' }, { result: 'failed', message: 'dns' }]) {
      api.updates.check.mockResolvedValueOnce(outcome);
      await useUpdates.getState().check({ startup: true });
      expect(useUpdates.getState().outcome).toEqual(outcome);
    }
    api.updates.check.mockRejectedValueOnce(new Error('ipc broke'));
    await useUpdates.getState().check({ startup: true });
    expect(useUpdates.getState().outcome?.result).toBe('failed');
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('asks the core directly for a check by hand and shows no notice', async () => {
    const { useUpdates, useToasts } = await load();
    api.updates.check.mockResolvedValue(available);
    await useUpdates.getState().check();
    expect(api.updates.check).toHaveBeenCalledWith(false);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('runs one check at a time', async () => {
    const { useUpdates } = await load();
    let finish!: (v: unknown) => void;
    api.updates.check.mockReturnValue(new Promise((r) => (finish = r)));
    const first = useUpdates.getState().check();
    await useUpdates.getState().check();
    expect(api.updates.check).toHaveBeenCalledTimes(1);
    finish({ result: 'upToDate' });
    await first;
    expect(useUpdates.getState().phase).toBe('idle');
  });
});

describe('update install', () => {
  async function withUpdate() {
    const loaded = await load();
    api.updates.check.mockResolvedValue(available);
    await loaded.useUpdates.getState().check();
    return loaded;
  }

  it('downloads first and asks only before Ylide closes', async () => {
    const { useUpdates, useConfirm } = await withUpdate();
    const order: string[] = [];
    api.updates.download.mockImplementation(async (onProgress: (p: unknown) => void) => {
      order.push('download');
      onProgress({ downloaded: 10, total: 100 });
      expect(useUpdates.getState().phase).toBe('downloading');
      expect(useUpdates.getState().progress).toEqual({ downloaded: 10, total: 100 });
    });
    vi.spyOn(useConfirm.getState(), 'ask').mockImplementation(async () => {
      order.push('ask');
      expect(useUpdates.getState().phase).toBe('ready');
      return true;
    });
    api.updates.launch.mockImplementation(async () => {
      order.push('launch');
    });
    await useUpdates.getState().install();
    expect(order).toEqual(['download', 'ask', 'launch']);
    expect(useUpdates.getState().phase).toBe('handedOver');
  });

  it('checks unsaved files and agents after the download, not before', async () => {
    const { useUpdates, useConfirm, useEditorBridge } = await withUpdate();
    api.updates.download.mockImplementation(async () => {
      // The user keeps working while the update downloads.
      useEditorBridge.setState({ dirtyPaths: ['src/a.ts', 'src/b.ts'] });
      agentPhase.value = 'running';
    });
    const asked = answerConfirm(useConfirm, false);
    await useUpdates.getState().install();
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toContain('common:update.confirmDirty');
    expect(asked[0].body).toContain('common:update.confirmAgent');
    expect(asked[0].danger).toBe(true);
    expect(api.updates.launch).not.toHaveBeenCalled();
  });

  it('keeps a declined update ready and installs it later without downloading again', async () => {
    const { useUpdates, useConfirm } = await withUpdate();
    answerConfirm(useConfirm, false);
    await useUpdates.getState().install();
    expect(useUpdates.getState().phase).toBe('ready');
    answerConfirm(useConfirm, true);
    await useUpdates.getState().install();
    expect(api.updates.download).toHaveBeenCalledTimes(1);
    expect(api.updates.launch).toHaveBeenCalledTimes(1);
    expect(useUpdates.getState().phase).toBe('handedOver');
  });

  it('shows why a download failed and allows another try', async () => {
    const { useUpdates, useConfirm, useToasts } = await withUpdate();
    const asked = answerConfirm(useConfirm, true);
    api.updates.download.mockRejectedValueOnce(new Error('signature'));
    await useUpdates.getState().install();
    expect(useUpdates.getState().phase).toBe('idle');
    expect(useUpdates.getState().installError).toBeTruthy();
    expect(useToasts.getState().toasts[0].tone).toBe('danger');
    expect(asked).toHaveLength(0);
    await useUpdates.getState().install();
    expect(api.updates.download).toHaveBeenCalledTimes(2);
  });

  it('stays ready when the installer cannot be started', async () => {
    const { useUpdates, useConfirm, useToasts } = await withUpdate();
    answerConfirm(useConfirm, true);
    api.updates.launch.mockRejectedValueOnce(new Error('blocked'));
    await useUpdates.getState().install();
    expect(useUpdates.getState().phase).toBe('ready');
    expect(useToasts.getState().toasts[0].tone).toBe('danger');
  });

  it('does nothing without an available update', async () => {
    const { useUpdates, useConfirm } = await load();
    const asked = answerConfirm(useConfirm, true);
    await useUpdates.getState().install();
    expect(asked).toHaveLength(0);
    expect(api.updates.download).not.toHaveBeenCalled();
  });
});
