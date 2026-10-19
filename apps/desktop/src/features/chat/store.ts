// Chat state lives outside the panel component so the conversation and the
// draft survive closing and reopening the panel. Each conversation is saved
// per project (see history.ts and the core's chats.rs) after every question
// and answer, and the latest one comes back when the project opens.

import { create } from 'zustand';
import type { AppError } from '../../bindings/AppError';
import type { ChatEvent } from '../../bindings/ChatEvent';
import type { ChatSummary } from '../../bindings/ChatSummary';
import type { Mention } from '../../bindings/Mention';
import i18n from '../../i18n';
import { reportError } from '../../lib/errors';
import type { DraftImage } from '../../lib/images';
import { api, IpcError } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { useLayout } from '../../state/layout';
import { applyChatEvent, assistantTurn, markCancelled, markFailed, markFinished, prepareRetry, requestMessages, userTurn, type Turn, type UserTurn } from './conversation';
import { fromStored, toStored, upsertSummary } from './history';
import { mentionKey, mergeMentions } from './mentions';

interface ChatState {
  turns: Turn[];
  /** Request that is currently streaming, if any. */
  activeRequestId: string | null;
  draft: string;
  draftMentions: Mention[];
  /** Images for the next question, already scaled down. */
  draftImages: DraftImage[];
  /** Id of the conversation on screen in the saved history; null until its first question. */
  chatId: string | null;
  /** Project the conversation on screen belongs to (null: none was open). */
  chatRoot: string | null;
  createdAt: number;
  /** Saved chats of the project `historyRoot`, newest first. */
  history: ChatSummary[];
  historyRoot: string | null;

  setDraft(text: string): void;
  addMentions(mentions: Mention[]): void;
  removeMention(key: string): void;
  setDraftImages(images: DraftImage[]): void;
  /** Sends the draft (text, images or both). Returns false if there was nothing to send or a request is running. */
  send(): boolean;
  /** Sends a suggested next step as the next question; the draft stays. */
  sendSuggestion(text: string): boolean;
  stop(): void;
  retry(answerId: string): void;
  newChat(): void;
  /** Reads the open project's saved chats; with `restoreLatest`, shows the newest one if the panel is empty. */
  loadHistory(options?: { restoreLatest?: boolean }): Promise<void>;
  /** Shows a saved chat of the listed project (a running answer is stopped and saved first). */
  openChat(id: string, options?: { onlyIfEmpty?: boolean }): Promise<void>;
  deleteChat(id: string): Promise<void>;
  /** Before all saved chats are deleted: empty list and a fresh conversation. */
  forgetHistory(): void;
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toAppError(e: unknown): AppError {
  return e instanceof IpcError ? { code: e.code, message: e.detail } : { code: 'generic', message: String(e) };
}

const savingAllowed = () => useApp.getState().settings?.chat.saveHistory ?? false;
const openRoot = () => useApp.getState().workspace?.root ?? null;
/** Chat whose last save failed; reported once, not on every later save. */
let saveFailedFor: string | null = null;
/** Counts chat opens; a load that finishes after a newer open, New chat or project switch is dropped. */
let openSeq = 0;

// Tokens arrive far faster than the screen needs them; events are queued and
// applied in batches so Markdown is re-parsed at most once per batch. Long
// answers cost more to parse, so their batches get longer.
function flushDelay(answerLength: number): number {
  if (answerLength > 12_000) return 160;
  if (answerLength > 4_000) return 80;
  return 32;
}
// After the command returns, its last channel messages may still be in
// flight; only then is an answer without a `done` event closed.
const SETTLE_MS = 1500;

const queue: Array<{ requestId: string; event: ChatEvent }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Requests the user stopped (Stop or New chat) that may still be running in the core. */
const stopped = new Set<string>();
const cancelResent = new Set<string>();

function cancelRequest(requestId: string) {
  stopped.add(requestId);
  void api.chat.cancel(requestId).catch(() => undefined);
}

export const useChat = create<ChatState>((set, get) => {
  function flush() {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    if (!queue.length) return;
    const events = queue.splice(0);
    const now = Date.now();
    let turns = get().turns;
    let active = get().activeRequestId;
    let ended = false;
    for (const { requestId, event } of events) {
      // A stopped request still produces tokens: the cancel reached the core
      // before it registered the request (it does so only after resolving the
      // context). Deltas come after registration, so a second cancel lands.
      if (event.type === 'delta' && stopped.has(requestId) && !cancelResent.has(requestId)) {
        cancelResent.add(requestId);
        void api.chat.cancel(requestId).catch(() => undefined);
      }
      turns = applyChatEvent(turns, requestId, event, now);
      if (event.type === 'done' || event.type === 'error') {
        if (active === requestId) active = null;
        if (turns.some((t) => t.role === 'assistant' && t.requestId === requestId)) ended = true;
      }
    }
    set({ turns, activeRequestId: active });
    // Saved as soon as the answer is complete: the user may leave the chat
    // before finish() runs.
    if (ended) persist();
  }

  function enqueue(requestId: string, event: ChatEvent) {
    queue.push({ requestId, event });
    if (flushTimer !== null) return;
    const answer = get().turns.findLast((t) => t.role === 'assistant' && t.requestId === requestId);
    flushTimer = setTimeout(flush, flushDelay(answer?.content.length ?? 0));
  }

  /** Saves the conversation on screen into its project (after a question and after an answer). */
  function persist() {
    const { chatId, chatRoot, createdAt, turns } = get();
    if (!chatId || !turns.length || !savingAllowed()) return;
    void api.chats
      .save(chatRoot, toStored(chatId, createdAt, turns, Date.now()))
      .then((summary) => {
        if (saveFailedFor === chatId) saveFailedFor = null;
        // Not when the chat left the screen meanwhile (deleted, another opened).
        if (summary && get().chatId === chatId && get().historyRoot === chatRoot) set((s) => ({ history: upsertSummary(s.history, summary) }));
      })
      .catch((e: unknown) => {
        if (saveFailedFor === chatId) return console.warn('could not save the chat', e);
        saveFailedFor = chatId;
        reportError(e, i18n.t('chat:history.saveFailed'));
      });
  }

  function finish(requestId: string, change: (turns: Turn[]) => Turn[]) {
    flush();
    const before = get().turns;
    const turns = change(before);
    set((s) => ({ turns, activeRequestId: s.activeRequestId === requestId ? null : s.activeRequestId }));
    // Only when this closed the answer: a `done` event saved it already, and a
    // request stopped by opening another chat must not re-save that one.
    if (turns !== before) persist();
  }

  /** Starts a request answering `question`, appended after `history`. */
  function run(history: Turn[], question: UserTurn) {
    const requestId = newId();
    const turns = [...history, question, assistantTurn(newId(), requestId)];
    set((s) => (s.chatId ? { turns, activeRequestId: requestId } : { turns, activeRequestId: requestId, chatId: newId(), chatRoot: openRoot(), createdAt: Date.now() }));
    persist();
    const request = { id: requestId, messages: requestMessages(history, question.content, question.images), mentions: question.mentions };
    api.chat
      .send(request, (event) => enqueue(requestId, event))
      .then(() => {
        flush();
        setTimeout(() => finish(requestId, (t) => markFinished(t, requestId, Date.now())), SETTLE_MS);
      })
      .catch((e: unknown) => finish(requestId, (t) => markFailed(t, requestId, toAppError(e), Date.now())))
      .finally(() => {
        stopped.delete(requestId);
        cancelResent.delete(requestId);
      });
  }

  /** Stops a running answer and drops queued tokens. */
  function abandon() {
    const id = get().activeRequestId;
    if (id) cancelRequest(id);
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    queue.length = 0;
  }

  return {
    turns: [],
    activeRequestId: null,
    draft: '',
    draftMentions: [],
    draftImages: [],
    chatId: null,
    chatRoot: null,
    createdAt: 0,
    history: [],
    historyRoot: null,

    setDraft: (draft) => set({ draft }),
    addMentions: (mentions) => set((s) => ({ draftMentions: mergeMentions(s.draftMentions, mentions) })),
    removeMention: (key) => set((s) => ({ draftMentions: s.draftMentions.filter((m) => mentionKey(m) !== key) })),
    setDraftImages: (draftImages) => set({ draftImages }),

    send() {
      const { draft, draftMentions, draftImages, activeRequestId, turns } = get();
      const content = draft.trim();
      // While the last project reopens at startup, a question would be filed
      // under "no project" and then stopped when the project arrives.
      if ((!content && !draftImages.length) || activeRequestId || useApp.getState().reopening) return false;
      set({ draft: '', draftMentions: [], draftImages: [] });
      run(turns, userTurn(newId(), content, draftMentions, draftImages.map((i) => i.url)));
      return true;
    },

    sendSuggestion(text) {
      const content = text.trim();
      if (!content || get().activeRequestId || useApp.getState().reopening) return false;
      run(get().turns, userTurn(newId(), content, []));
      return true;
    },

    stop() {
      const id = get().activeRequestId;
      if (!id) return;
      flush();
      set((s) => ({ turns: markCancelled(s.turns, id, Date.now()), activeRequestId: null }));
      cancelRequest(id);
      persist();
    },

    retry(answerId) {
      if (get().activeRequestId) return;
      const target = prepareRetry(get().turns, answerId);
      if (target) run(target.history, target.question);
    },

    newChat() {
      // Saved conversations stay in the history. A running answer is dropped
      // here; callers that keep it (New chat, another project) stop it first.
      openSeq++; // a chat still loading must not fill the screen afterwards
      abandon();
      set({ turns: [], activeRequestId: null, chatId: null, chatRoot: null, createdAt: 0 });
    },

    async loadHistory(options) {
      const root = openRoot();
      let history: ChatSummary[] = [];
      try {
        history = savingAllowed() ? await api.chats.list(root) : [];
      } catch (e) {
        console.warn('could not read the saved chats', e);
      }
      // Another project opened meanwhile; its own load fills the list.
      if (openRoot() !== root) return;
      set({ history, historyRoot: root });
      const latest = history[0];
      if (options?.restoreLatest && latest && get().turns.length === 0 && !get().activeRequestId) await get().openChat(latest.id, { onlyIfEmpty: true });
    },

    async openChat(id, options) {
      if (id === get().chatId) return;
      const root = get().historyRoot;
      const seq = ++openSeq;
      try {
        const stored = await api.chats.load(root, id);
        // Another open, New chat or a project switch came first; or (when
        // restoring) the user started a conversation meanwhile.
        if (seq !== openSeq || openRoot() !== root) return;
        if (options?.onlyIfEmpty && (get().chatId !== null || get().turns.length > 0 || get().activeRequestId)) return;
        const turns = fromStored(stored);
        // Saved chats are never empty: this one is in a format this version
        // cannot read. Taking its id would overwrite it with the next question.
        if (!turns.length) throw new Error(`saved chat ${id} cannot be read by this version`);
        // A running answer is kept with what it has written so far.
        get().stop();
        abandon();
        set({ turns, activeRequestId: null, chatId: id, chatRoot: root, createdAt: stored.summary.createdAtUnixMs });
      } catch (e) {
        if (seq !== openSeq) return;
        console.warn('could not open the saved chat', e);
        // The file is gone or broken; drop it from the list.
        set((s) => ({ history: s.history.filter((c) => c.id !== id) }));
      }
    },

    async deleteChat(id) {
      const root = get().historyRoot;
      // Off the screen first, so no save of it can follow the delete.
      if (get().chatId === id) get().newChat();
      await api.chats.remove(root, id);
      set((s) => ({ history: s.history.filter((c) => c.id !== id) }));
    },

    forgetHistory() {
      get().newChat();
      set({ history: [] });
    },
  };
});

// Each project has its own chats: when the open project changes, a running
// answer is stopped and saved with its own project, the new project's history
// is read and its latest chat comes back. While Ylide reopens the last project
// at startup, the moment without a project is skipped.
let shownRoot: string | null | undefined;
function followProject(state: ReturnType<typeof useApp.getState>) {
  if (!state.ready) return;
  const root = state.workspace?.root ?? null;
  if (root === shownRoot) return;
  if (shownRoot === undefined && root === null && state.reopening) return;
  shownRoot = root;
  useChat.getState().stop();
  useChat.getState().newChat();
  void useChat.getState().loadHistory({ restoreLatest: true });
}
followProject(useApp.getState());
const unsubscribeProject = useApp.subscribe(followProject);
// Switching saving on reads the list; switching it off empties it.
let saving: boolean | undefined;
const unsubscribeSaving = useApp.subscribe((state) => {
  const now = state.settings?.chat.saveHistory;
  if (now === undefined || now === saving) return;
  const before = saving;
  saving = now;
  if (before !== undefined) void useChat.getState().loadHistory();
});

// Mentions handed over by the editor ("Add to chat") must reach the composer
// even while the panel is closed: open it, and the mounted panel takes them.
let panelsMounted = 0;

export function registerChatPanel(): () => void {
  panelsMounted++;
  return () => {
    panelsMounted--;
  };
}

const unsubscribeBridge = useEditorBridge.subscribe((state) => {
  if (state.pendingMentions.length && panelsMounted === 0 && useLayout.getState().right !== 'chat') {
    useLayout.getState().setRight('chat');
  }
});
import.meta.hot?.dispose(() => {
  unsubscribeBridge();
  unsubscribeProject();
  unsubscribeSaving();
});
