// The current agent run. Lives outside React so a run keeps reducing events
// while the panel is closed; the panel only reads from here.

import { create } from 'zustand';
import type { AgentEvent } from '../../bindings/AgentEvent';
import type { ApprovalRequest } from '../../bindings/ApprovalRequest';
import type { ApprovalResponse } from '../../bindings/ApprovalResponse';
import type { Checkpoint } from '../../bindings/Checkpoint';
import type { LastRun } from '../../bindings/LastRun';
import i18n from '../../i18n';
import { reportError } from '../../lib/errors';
import { api } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useLayout } from '../../state/layout';
import { useToasts } from '../../state/toasts';
import { appendStream, applyDecision, applyEvent, continuationOf, createRun, removeQuestion, restoreRun, type RunData } from './run';

export type Phase = 'idle' | 'starting' | 'running' | 'finished';

interface AgentRunState {
  phase: Phase;
  /** Goal typed in the idle view, kept while the panel is closed. */
  draft: string;
  /** Next step typed under a finished run, kept while the panel is closed. */
  followUp: string;
  /** The next-step field takes the focus when it appears. */
  focusFollowUp: boolean;
  /** The current run, or the last finished one. */
  run: RunData | null;
  paused: boolean;
  stopping: boolean;
  /** A pause/resume/stop request is on its way. */
  controlBusy: boolean;
  /** Checkpoints whose changes the user undid. */
  restored: ReadonlySet<string>;
  /**
   * Tail of the text each agent streams in its current turn. Kept apart from
   * `run` and flushed a few times per second, so tokens re-render only the
   * agent rows instead of the whole panel.
   */
  streams: Readonly<Record<string, string>>;
  /** Questions the user chose to answer later; they stay as a banner. */
  deferred: ReadonlySet<string>;

  setDraft(draft: string): void;
  setFollowUp(text: string): void;
  start(goal: string): Promise<void>;
  /** Starts a run that continues the finished one; its agents are told what it did. */
  continueRun(goal: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  decide(request: ApprovalRequest, response: ApprovalResponse): Promise<void>;
  answer(questionId: string, answer: string): Promise<boolean>;
  intervene(agentId: string, text: string): Promise<boolean>;
  restore(checkpoint: Checkpoint): Promise<string[] | null>;
  /** Back to the idle view; the finished run stays available as "previous run". */
  newRun(): void;
  /** Shows the last finished run again; with `next`, ready to type the next step. */
  showRun(next?: boolean): void;
  followUpFocused(): void;
  /**
   * Shows the project's last run, kept by the core across restarts, unless a
   * run of this project is already here or one is going.
   */
  loadLast(project: string | null): Promise<void>;
  deferQuestion(questionId: string): void;
  reopenQuestion(questionId: string): void;
}

/** Increments per started run; events of older runs are dropped. */
let generation = 0;

/** How often streamed text reaches the UI (ms). */
const STREAM_FLUSH_MS = 120;

const t = (key: string, options?: Record<string, unknown>) => i18n.t(`agents:${key}`, options);

export const useAgentRun = create<AgentRunState>((set, get) => {
  // Streamed text waiting for the next flush, per agent.
  const pending = new Map<string, string>();
  let flushTimer: number | null = null;

  const flush = () => {
    flushTimer = null;
    if (!pending.size) return;
    const updates = Object.fromEntries(pending);
    pending.clear();
    set((s) => ({ streams: { ...s.streams, ...updates } }));
  };

  const resetStreams = () => {
    pending.clear();
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    flushTimer = null;
  };

  const clearStream = (agentId: string) => {
    pending.delete(agentId);
    const { streams } = get();
    if (!(agentId in streams)) return;
    const next = { ...streams };
    delete next[agentId];
    set({ streams: next });
  };

  const receiveDelta = (event: Extract<AgentEvent, { type: 'delta' }>) => {
    const { run, streams } = get();
    if (!run || run.outcome !== null || (run.runId !== null && run.runId !== event.runId)) return;
    if (event.delta.kind === 'toolCall' || !event.delta.text) return;
    const agentId = event.agentId;
    pending.set(agentId, appendStream(pending.get(agentId) ?? streams[agentId] ?? '', event.delta.text));
    if (flushTimer === null) flushTimer = window.setTimeout(flush, STREAM_FLUSH_MS);
  };

  const receive = (event: AgentEvent) => {
    if (event.type === 'delta') {
      receiveDelta(event);
      return;
    }
    const at = Date.now();
    const before = get();
    if (!before.run) return;
    const run = applyEvent(before.run, event, at);
    if (run === before.run) return;
    // A new state starts a new turn: its streamed text begins afresh.
    if (event.type === 'status' && before.run.agents[event.status.agentId]?.state !== event.status.state) clearStream(event.status.agentId);
    if (event.type === 'runFinished') {
      resetStreams();
      set({ run, phase: 'finished', paused: false, stopping: false, controlBusy: false, streams: {}, deferred: new Set() });
      if (useLayout.getState().right !== 'agents') {
        const tone = event.outcome === 'completed' ? 'success' : event.outcome === 'failed' ? 'danger' : 'neutral';
        useToasts.getState().push({ tone, title: t(`outcome.${event.outcome}`), body: run.goal });
      }
      return;
    }
    // Approvals and questions show as dialogs at shell level (AgentAttention),
    // so the open panel stays as it is.
    set({ run, phase: before.phase === 'starting' ? 'running' : before.phase });
  };

  const control = async (action: 'pause' | 'resume' | 'cancel') => {
    const { run, controlBusy } = get();
    if (!run?.runId || controlBusy || run.outcome) return false;
    set({ controlBusy: true });
    try {
      await api.agents.control(run.runId, action);
      return true;
    } catch (e) {
      reportError(e);
      return false;
    } finally {
      set({ controlBusy: false });
    }
  };

  /** Starts a run; with `from`, one that continues that finished run. */
  const launch = async (goal: string, from: RunData | null) => {
    const text = goal.trim();
    const { phase, run: previous } = get();
    if (!text || phase === 'starting' || phase === 'running') return;
    const continues = from && continuationOf(from);
    if (from && !continues) return;
    const gen = ++generation;
    resetStreams();
    const project = useApp.getState().workspace?.root ?? null;
    set({ phase: 'starting', run: createRun(text, Date.now(), { project, continues }), paused: false, stopping: false, controlBusy: false, restored: new Set(), streams: {}, deferred: new Set() });
    try {
      const runId = await api.agents.start(
        text,
        (event) => {
          if (gen === generation) receive(event);
        },
        continues?.runId ?? null,
      );
      if (gen !== generation) return;
      const { run } = get();
      if (run && run.runId === null) set({ run: { ...run, runId } });
      set((s) => ({ ...(continues ? { followUp: '' } : { draft: '' }), phase: s.phase === 'starting' ? 'running' : s.phase }));
    } catch (e) {
      if (gen !== generation) return;
      generation++;
      // Back where the user was: the idle view, or the finished run with the text still typed.
      set({ phase, run: previous });
      reportError(e, t('errors.start'));
    }
  };

  return {
    phase: 'idle',
    draft: '',
    followUp: '',
    focusFollowUp: false,
    run: null,
    paused: false,
    stopping: false,
    controlBusy: false,
    restored: new Set(),
    streams: {},
    deferred: new Set(),

    setDraft(draft) {
      set({ draft });
    },

    setFollowUp(followUp) {
      set({ followUp });
    },

    start(goal) {
      return launch(goal, null);
    },

    continueRun(goal) {
      const { phase, run } = get();
      if (phase !== 'finished' || !run) return Promise.resolve();
      return launch(goal, run);
    },

    async pause() {
      if (await control('pause')) set({ paused: true });
    },

    async resume() {
      if (await control('resume')) set({ paused: false });
    },

    async stop() {
      if (get().stopping) return;
      if (!(await control('cancel'))) return;
      // The core stops waiting for open questions and approvals on cancel.
      set((s) => ({ stopping: true, paused: false, ...(s.run ? { run: { ...s.run, questions: [] }, deferred: new Set<string>() } : {}) }));
    },

    async decide(request, response) {
      const runId = get().run?.runId;
      if (!runId) return;
      try {
        await api.agents.approve(runId, request.id, response);
        // `false` means the core no longer waits for it (run stopped); drop it either way.
        set((s) => (s.run ? { run: applyDecision(s.run, request, response, Date.now()) } : {}));
      } catch (e) {
        reportError(e, t('errors.approve'));
      }
    },

    async answer(questionId, answer) {
      const runId = get().run?.runId;
      if (!runId) return false;
      try {
        await api.agents.answer(runId, questionId, answer);
        set((s) => {
          if (!s.run) return {};
          const deferred = new Set(s.deferred);
          deferred.delete(questionId);
          return { run: removeQuestion(s.run, questionId), deferred };
        });
        return true;
      } catch (e) {
        reportError(e, t('errors.answer'));
        return false;
      }
    },

    async intervene(agentId, text) {
      const runId = get().run?.runId;
      if (!runId || !text.trim()) return false;
      try {
        await api.agents.intervene(runId, agentId, text.trim());
        return true;
      } catch (e) {
        reportError(e, t('errors.intervene'));
        return false;
      }
    },

    async restore(checkpoint) {
      const runId = get().run?.runId;
      if (!runId) return null;
      try {
        const files = await api.agents.restore(runId, checkpoint.id);
        // Undoing from a checkpoint reverts it and every later one that exists now.
        set((s) => {
          const restored = new Set(s.restored);
          for (const cp of s.run?.checkpoints ?? []) if (cp.seq >= checkpoint.seq) restored.add(cp.id);
          return { restored };
        });
        return files;
      } catch (e) {
        reportError(e, t('errors.restore'));
        return null;
      }
    },

    newRun() {
      if (get().phase === 'finished') set({ phase: 'idle' });
    },

    showRun(next = false) {
      if (get().run?.outcome) set({ phase: 'finished', focusFollowUp: next });
    },

    followUpFocused() {
      set({ focusFollowUp: false });
    },

    async loadLast(project) {
      const busy = () => get().phase === 'starting' || get().phase === 'running';
      if (busy() || (get().run && get().run?.project === project)) return;
      const gen = generation;
      let last: LastRun | null = null;
      try {
        last = project ? await api.agents.lastRun() : null;
      } catch (e) {
        console.warn('the last agent run could not be read', e);
      }
      if (gen !== generation || busy() || (get().run && get().run?.project === project)) return;
      const run = last ? restoreRun(last, project) : null;
      set({ phase: 'idle', run, followUp: '', focusFollowUp: false, restored: new Set(), streams: {}, deferred: new Set() });
      // Checkpoints stay on disk, so the changes can still be undone.
      if (!run?.runId) return;
      const runId = run.runId;
      try {
        const checkpoints = await api.agents.checkpoints(runId);
        set((s) => (s.run?.runId === runId && s.run.outcome ? { run: { ...s.run, checkpoints } } : {}));
      } catch (e) {
        console.warn('the checkpoints of the last agent run could not be read', e);
      }
    },

    deferQuestion(questionId) {
      set((s) => ({ deferred: new Set(s.deferred).add(questionId) }));
    },

    reopenQuestion(questionId) {
      set((s) => {
        const deferred = new Set(s.deferred);
        deferred.delete(questionId);
        return { deferred };
      });
    },
  };
});
