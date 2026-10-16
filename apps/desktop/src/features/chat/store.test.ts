import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The chat store talks to the core only through lib/ipc.
const api = vi.hoisted(() => ({
  chat: { send: vi.fn(), cancel: vi.fn(async () => undefined) },
  chats: { list: vi.fn(), load: vi.fn(), save: vi.fn(), remove: vi.fn(async () => undefined), removeAll: vi.fn() },
}));
vi.mock('../../lib/ipc', () => ({ api, isTauri: false, IpcError: class extends Error {} }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('../../lib/errors', () => ({ reportError, errorText: String }));
type AppValue = {
  ready: boolean;
  reopening: boolean;
  workspace: null | { root: string };
  settings: { onboardingDone: boolean; lastProject: string | null; chat: { saveHistory: boolean } };
};
const appState = vi.hoisted(() => ({ value: {} as AppValue }));
const appListeners = vi.hoisted(() => [] as Array<(s: unknown) => void>);
vi.mock('../../state/app', () => ({
  useApp: {
    getState: () => appState.value,
    subscribe: (fn: (s: unknown) => void) => {
      appListeners.push(fn);
      return () => undefined;
    },
  },
}));

type SavedChat = { summary: { id: string; title: string; turns: number }; turns: Array<{ role: string; status?: string; content?: string }> };

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function summary(id: string, updated: number) {
  return { id, title: id, createdAtUnixMs: 1, updatedAtUnixMs: updated, turns: 2 };
}

function stored(id: string) {
  return { summary: summary(id, 1), format: 1, turns: [{ id: 'u', role: 'user', content: 'Hallo', mentions: [], context: null }] };
}

async function load() {
  vi.resetModules();
  appListeners.length = 0;
  const { useChat } = await import('./store');
  return useChat;
}

/** Lets the app store report a change (a project opened, a setting changed). */
function setApp(change: (v: AppValue) => void) {
  change(appState.value);
  for (const fn of appListeners) fn(appState.value);
}

/** Saves sent to the core: [project, chat]. */
const saves = () => api.chats.save.mock.calls.map((c) => [c[0], c[1]] as [string | null, SavedChat]);

beforeEach(() => {
  appState.value = { ready: true, reopening: false, workspace: null, settings: { onboardingDone: true, lastProject: null, chat: { saveHistory: true } } };
  api.chats.list.mockResolvedValue([]);
  api.chats.save.mockImplementation(async (_project: string | null, chat: { summary: unknown }) => chat.summary);
  api.chat.send.mockImplementation(async (_req: unknown, onEvent: (e: unknown) => void) => {
    onEvent({ type: 'delta', delta: { kind: 'content', text: 'Antwort' } });
    onEvent({ type: 'done', result: { message: { role: 'assistant', content: 'Antwort' }, finishReason: 'stop', usage: null, timings: null } });
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('saved chats', () => {
  it('saves after the question and after the answer, under one id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const useChat = await load();
    useChat.getState().setDraft('Was macht cart.js?');
    expect(useChat.getState().send()).toBe(true);
    await vi.runAllTimersAsync();
    expect(api.chats.save).toHaveBeenCalledTimes(2);
    const [[, first], [, second]] = saves();
    expect(first.summary.id).toBe(second.summary.id);
    expect(second.summary.title).toBe('Was macht cart.js?');
    expect(second.turns.at(-1)?.status).toBe('done');
    expect(useChat.getState().history.map((s) => s.id)).toEqual([second.summary.id]);
  });

  it('saves a finished answer right away, before the request settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const useChat = await load();
    useChat.getState().setDraft('Frage');
    useChat.getState().send();
    await vi.advanceTimersByTimeAsync(200);
    expect(saves().at(-1)?.[1].turns.at(-1)?.status).toBe('done');
    // Leaving the chat now keeps the answer; the settle step saves nothing more.
    const count = api.chats.save.mock.calls.length;
    useChat.getState().newChat();
    await vi.runAllTimersAsync();
    expect(api.chats.save).toHaveBeenCalledTimes(count);
  });

  it('refuses a question while the last project is being reopened', async () => {
    appState.value.settings.lastProject = 'D:/shop';
    appState.value.reopening = true;
    const useChat = await load();
    useChat.getState().setDraft('Frage');
    expect(useChat.getState().send()).toBe(false);
    expect(useChat.getState().draft).toBe('Frage');
    expect(api.chat.send).not.toHaveBeenCalled();
  });

  it('saves nothing while saving is switched off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    appState.value.settings.chat.saveHistory = false;
    const useChat = await load();
    useChat.getState().setDraft('Frage');
    useChat.getState().send();
    await vi.runAllTimersAsync();
    expect(api.chats.save).not.toHaveBeenCalled();
  });

  it('saves into the project the question was asked in, even when another one opened meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    appState.value.workspace = { root: 'D:/a' };
    const useChat = await load();
    useChat.getState().setDraft('Frage');
    useChat.getState().send();
    // The core switched to project B before the UI heard of it.
    appState.value.workspace = { root: 'D:/b' };
    await vi.runAllTimersAsync();
    expect(saves().map(([project]) => project)).toEqual(['D:/a', 'D:/a']);
  });

  it('shows the latest chat of a project when it opens', async () => {
    const useChat = await load();
    await flush();
    api.chats.list.mockResolvedValue([summary('new', 20), summary('old', 10)]);
    api.chats.load.mockResolvedValue({ ...stored('new'), summary: summary('new', 20) });
    setApp((v) => {
      v.workspace = { root: 'D:/shop' };
    });
    await flush();
    expect(api.chats.list).toHaveBeenLastCalledWith('D:/shop');
    expect(api.chats.load).toHaveBeenCalledWith('D:/shop', 'new');
    expect(useChat.getState().chatId).toBe('new');
    expect(useChat.getState().chatRoot).toBe('D:/shop');
    expect(useChat.getState().turns).toHaveLength(1);
    expect(useChat.getState().history.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('waits for the last project instead of showing chats without a project at startup', async () => {
    appState.value.settings.lastProject = 'D:/shop';
    appState.value.reopening = true;
    await load();
    await flush();
    expect(api.chats.list).not.toHaveBeenCalled();
    // The reopen failed (the folder is gone): the chats without a project count.
    setApp((v) => {
      v.reopening = false;
    });
    await flush();
    expect(api.chats.list).toHaveBeenCalledWith(null);
  });

  it('keeps what a running answer wrote when another chat is opened', async () => {
    let finishSend: () => void = () => undefined;
    api.chat.send.mockImplementation(
      (_req: unknown, onEvent: (e: unknown) => void) =>
        new Promise<void>((resolve) => {
          onEvent({ type: 'delta', delta: { kind: 'content', text: 'Halbe Antw' } });
          finishSend = resolve;
        }),
    );
    const useChat = await load();
    await flush();
    useChat.getState().setDraft('Lange Frage');
    useChat.getState().send();
    const first = useChat.getState().chatId;
    await flush();
    api.chats.load.mockResolvedValue(stored('other'));
    useChat.setState({ history: [summary('other', 1)] });
    await useChat.getState().openChat('other');
    const last = saves().at(-1)!;
    expect(last[1].summary.id).toBe(first);
    expect(last[1].turns.at(-1)).toMatchObject({ status: 'cancelled', content: 'Halbe Antw' });
    expect(useChat.getState().chatId).toBe('other');
    // When the stopped request settles, the chat now on screen is not saved again.
    const count = api.chats.save.mock.calls.length;
    finishSend();
    await new Promise((r) => setTimeout(r, 1600));
    expect(api.chats.save).toHaveBeenCalledTimes(count);
  });

  it('drops a chat that finishes loading after New chat', async () => {
    const useChat = await load();
    let resolveLoad: (v: unknown) => void = () => undefined;
    api.chats.load.mockReturnValue(new Promise((r) => (resolveLoad = r)));
    useChat.setState({ history: [summary('x', 1)] });
    const opening = useChat.getState().openChat('x');
    useChat.getState().newChat();
    resolveLoad(stored('x'));
    await opening;
    expect(useChat.getState().chatId).toBeNull();
    expect(useChat.getState().turns).toEqual([]);
  });

  it('does not take over a saved chat this version cannot read', async () => {
    const useChat = await load();
    api.chats.load.mockResolvedValue({ ...stored('future'), format: 99 });
    useChat.setState({ history: [summary('future', 1)] });
    await useChat.getState().openChat('future');
    expect(useChat.getState().chatId).toBeNull();
    // Hidden for this session; the file on disk stays as it is.
    expect(useChat.getState().history).toEqual([]);
    expect(api.chats.save).not.toHaveBeenCalled();
  });

  it('reports a failed save once per chat', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api.chats.save.mockRejectedValue(new Error('disk full'));
    const useChat = await load();
    useChat.getState().setDraft('Frage');
    useChat.getState().send();
    await vi.runAllTimersAsync();
    expect(api.chats.save).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('takes the open chat off the screen before deleting it', async () => {
    const useChat = await load();
    api.chats.load.mockResolvedValue(stored('x'));
    useChat.setState({ history: [summary('x', 1)] });
    await useChat.getState().openChat('x');
    let chatIdDuringDelete: string | null | undefined;
    api.chats.remove.mockImplementation(async () => {
      chatIdDuringDelete = useChat.getState().chatId;
    });
    await useChat.getState().deleteChat('x');
    expect(chatIdDuringDelete).toBeNull();
    expect(api.chats.remove).toHaveBeenCalledWith(null, 'x');
    expect(useChat.getState().turns).toEqual([]);
    expect(useChat.getState().history).toEqual([]);
  });

  it('keeps a chat in the list when it could not be deleted', async () => {
    const useChat = await load();
    useChat.setState({ history: [summary('x', 1)] });
    api.chats.remove.mockRejectedValue(new Error('in use'));
    await expect(useChat.getState().deleteChat('x')).rejects.toThrow('in use');
    expect(useChat.getState().history.map((s) => s.id)).toEqual(['x']);
  });

  it('drops a chat from the list when its file cannot be read', async () => {
    const useChat = await load();
    api.chats.load.mockRejectedValue(new Error('gone'));
    useChat.setState({ history: [summary('x', 1)] });
    await useChat.getState().openChat('x');
    expect(useChat.getState().history).toEqual([]);
  });
});
