// Planning mode ("Planen | Umsetzen"): the plan of the open project, the
// conversation about it and the planning runs that write and change it.
// Kept per project by the core (planning.rs), so it survives a restart.
//
// - Planen: the agents only read; the orchestrator writes a plan, the user
//   changes it in conversation or by hand.
// - Umsetzen with a plan: the plan's steps run as the tasks (same ids).
// - Planen during a run: the current task finishes, then the run stops and
//   its open tasks become the plan again; Umsetzen goes on from there.

import { create } from 'zustand';
import type { AgentEvent } from '../../bindings/AgentEvent';
import type { PlanDoc } from '../../bindings/PlanDoc';
import type { PlanNote } from '../../bindings/PlanNote';
import type { PlanState } from '../../bindings/PlanState';
import type { WorkMode } from '../../bindings/WorkMode';
import i18n from '../../i18n';
import { reportError } from '../../lib/errors';
import { api } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useToasts } from '../../state/toasts';
import { answersWish, changedParts, hasChanges, lastTaskNumber, planFilePath, planFromRun, toMarkdown, type PlanChanges } from './plan';
import { applyEvent, createRun, type RunData } from './run';
import { useAgentRun } from './store';

interface PlanModeState {
  /** Project the state belongs to (its root), once read from the core. */
  project: string | null;
  mode: WorkMode;
  plan: PlanDoc | null;
  /** The stopped run whose open tasks the plan holds. */
  continues: string | null;
  notes: PlanNote[];
  /** Text in the plan's input: the request, or a wish for the plan. */
  draft: string;
  /** The planning run going on (or the last one). */
  run: RunData | null;
  busy: boolean;
  /** What the last planning run changed, highlighted for a moment. */
  changes: PlanChanges | null;
  changedAt: number;
  /** Run that stops after its current task, because the user switched to Planen. */
  handover: string | null;

  load(project: string | null): Promise<void>;
  setMode(mode: WorkMode): Promise<void>;
  toggleMode(): Promise<void>;
  setDraft(text: string): void;
  /** A plan for `text`, or the current plan changed as `text` wishes. */
  send(text: string): Promise<boolean>;
  /** The user's answers to the plan's open questions. */
  answer(answers: string[]): Promise<boolean>;
  stop(): Promise<void>;
  /** A change the user made by hand. */
  edit(change: (plan: PlanDoc) => PlanDoc): void;
  /** Umsetzen: the plan's steps run as the tasks. */
  carryOut(): Promise<boolean>;
  /** Plans first, from the idle view, when the user wants to see the plan before it runs. */
  planFirst(goal: string): Promise<boolean>;
  /** Plans the next step of a finished run, with its open tasks in the plan. */
  planNext(run: RunData, wish: string): Promise<boolean>;
  /** A finished run's open tasks as the plan, without asking the orchestrator. */
  adopt(run: RunData): void;
  saveFile(): Promise<string | null>;
  discard(): void;
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(`agents:${key}`, options);
const language = () => i18n.resolvedLanguage ?? i18n.language ?? 'en';
/** Counts planning runs; events of older ones are dropped. */
let generation = 0;
/** Counts the user's changes, so a slow load does not undo one made meanwhile. */
let edits = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const usePlanning = create<PlanModeState>((set, get) => {
  /** Writes the project's planning state, a moment after the last change. */
  const persist = () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const { project, mode, plan, continues, notes } = get();
      if (project === null || useApp.getState().workspace?.root !== project) return;
      const state: PlanState = { mode, plan, continues, notes };
      api.plans.save(state).catch((e: unknown) => console.warn('the plan could not be kept', e));
    }, 300);
  };

  const update = (patch: Partial<PlanModeState>) => {
    edits++;
    set(patch);
    persist();
  };

  /** Starts a planning run; `wish` changes the current plan. */
  const draftPlan = async (goal: string, wish: string | null): Promise<boolean> => {
    const { busy, handover, plan, notes, continues } = get();
    if (busy || handover) return false;
    const gen = ++generation;
    const earlierWishes = notes.filter((n) => n.kind === 'wish' || n.kind === 'answers').map((n) => n.text);
    if (wish !== null) earlierWishes.pop(); // the newest wish goes as the wish itself
    set({ busy: true, run: createRun(goal, Date.now()) });
    const receive = (event: AgentEvent) => {
      if (gen !== generation) return;
      const { run } = get();
      if (run) set({ run: applyEvent(run, event, Date.now()) });
      if (event.type === 'planDrafted') {
        const before = get().plan;
        const changes = changedParts(before, event.plan);
        update({ plan: event.plan, changes: hasChanges(changes) ? changes : null, changedAt: Date.now(), notes: [...get().notes, { kind: 'updated', text: '' }] });
      } else if (event.type === 'runFinished') {
        const drafted = get().run?.timeline.some((e) => e.event.type === 'planDrafted');
        set({ busy: false });
        if (!drafted && event.outcome === 'failed') update({ notes: [...get().notes, { kind: 'failed', text: '' }] });
      }
    };
    try {
      await api.plans.draft({ goal, plan: wish !== null ? plan : null, wish, earlierWishes, continues, language: language() }, receive);
      return true;
    } catch (e) {
      if (gen === generation) set({ busy: false });
      reportError(e, t('errors.planDraft'));
      return false;
    }
  };

  return {
    project: null,
    mode: 'code',
    plan: null,
    continues: null,
    notes: [],
    draft: '',
    run: null,
    busy: false,
    changes: null,
    changedAt: 0,
    handover: null,

    async load(project) {
      if (project === get().project) return;
      generation++;
      const before = edits;
      let state: PlanState = { mode: 'code', plan: null, continues: null, notes: [] };
      try {
        if (project) state = await api.plans.state();
      } catch (e) {
        console.warn('the plan of the project could not be read', e);
      }
      if (useApp.getState().workspace?.root !== project) return;
      // The user switched or edited while it loaded: that wins, and is kept for the project.
      if (edits !== before && get().project === null) {
        set({ project });
        persist();
        return;
      }
      set({ project, ...state, draft: '', run: null, busy: false, changes: null, handover: null });
    },

    async setMode(mode) {
      const { mode: now, plan, handover, busy } = get();
      const agents = useAgentRun.getState();
      const running = agents.run && !agents.run.outcome && (agents.phase === 'running' || agents.phase === 'starting') ? agents.run : null;
      if (mode === now) return;
      if (mode === 'plan') {
        // The current task finishes; then the run stops and its open tasks become the plan.
        if (running?.runId) {
          try {
            await api.agents.handover(running.runId, true);
            set({ handover: running.runId });
          } catch (e) {
            reportError(e, t('errors.planDraft'));
            return;
          }
        }
        update({ mode: 'plan' });
        return;
      }
      if (handover && running?.runId === handover) {
        // Back before the task ended: the run goes on as if nothing happened.
        await api.agents.handover(handover, false).catch(() => undefined);
        set({ handover: null });
        update({ mode: 'code' });
        return;
      }
      if (plan?.steps.length && !busy) {
        await get().carryOut();
        return;
      }
      update({ mode: 'code' });
    },

    toggleMode() {
      return get().setMode(get().mode === 'plan' ? 'code' : 'plan');
    },

    setDraft(draft) {
      set({ draft });
    },

    async send(text) {
      const wish = text.trim();
      if (!wish) return false;
      const { plan } = get();
      if (plan) {
        update({ notes: [...get().notes, { kind: 'wish', text: wish }] });
        const ok = await draftPlan(plan.goal, wish);
        if (ok) set({ draft: '' });
        return ok;
      }
      const ok = await draftPlan(wish, null);
      if (ok) set({ draft: '' });
      return ok;
    },

    async answer(answers) {
      const { plan } = get();
      if (!plan?.questions.length) return false;
      const wish = answersWish(t('plan.answersIntro'), plan.questions, answers, t('plan.leftOpen'));
      update({ notes: [...get().notes, { kind: 'answers', text: wish }] });
      return draftPlan(plan.goal, wish);
    },

    async stop() {
      const runId = get().run?.runId;
      if (!get().busy || !runId) return;
      await api.agents.control(runId, 'cancel').catch((e: unknown) => reportError(e));
    },

    edit(change) {
      const { plan } = get();
      if (!plan || get().busy) return;
      update({ plan: change(plan), changes: null });
    },

    async carryOut() {
      const { plan, continues, busy } = get();
      if (!plan?.steps.length || busy) return false;
      const ok = await useAgentRun.getState().runPlan(plan, continues);
      if (ok) update({ mode: 'code', plan: null, continues: null, notes: [], changes: null });
      return ok;
    },

    async planFirst(goal) {
      update({ mode: 'plan', plan: null, continues: null, notes: [], changes: null });
      return get().send(goal);
    },

    async planNext(run, wish) {
      const open = planFromRun(run);
      update({ mode: 'plan', plan: open, continues: run.runId, notes: open ? [{ kind: 'tookOver', text: '' }] : [], changes: null });
      return get().send(wish);
    },

    adopt(run) {
      const plan = planFromRun(run);
      if (!plan || get().busy) return;
      update({ plan, continues: run.runId, notes: [{ kind: 'tookOver', text: '' }], changes: changedParts(null, plan), changedAt: Date.now() });
    },

    async saveFile() {
      const { plan } = get();
      if (!plan) return null;
      const path = planFilePath(plan.goal, new Date());
      const content = toMarkdown(plan, {
        approach: t('plan.approach'),
        steps: t('plan.steps'),
        files: t('plan.files'),
        verify: t('plan.verify'),
        risks: t('plan.risks'),
        questions: t('plan.questions'),
        recommended: t('question.recommended'),
      });
      try {
        await api.plans.writeFile(path, content);
        useToasts.getState().push({ tone: 'success', title: t('plan.saved'), body: path });
        return path;
      } catch (e) {
        reportError(e, t('errors.planSave'));
        return null;
      }
    },

    discard() {
      if (get().busy) return;
      update({ plan: null, continues: null, notes: [], changes: null });
    },
  };
});

/** The highest task number of the run the plan continues, for ids of new steps. */
export function continuedNumber(): number {
  const { continues } = usePlanning.getState();
  const run = useAgentRun.getState().run;
  return continues && run?.runId === continues ? lastTaskNumber(run) : 0;
}

// A run that stopped because the user switched to Planen: its open tasks
// become the plan. When it finished everything first, there is no plan.
const unsubscribeRuns = useAgentRun.subscribe((agents) => {
  const { handover } = usePlanning.getState();
  const run = agents.run;
  if (!handover || run?.runId !== handover || !run.outcome) return;
  const plan = planFromRun(run);
  usePlanning.setState({ handover: null });
  if (!plan) return;
  const { notes } = usePlanning.getState();
  usePlanning.setState({ plan, continues: run.runId, notes: [...notes, { kind: 'tookOver', text: '' }], changes: changedParts(null, plan), changedAt: Date.now() });
  const { project, mode, continues } = usePlanning.getState();
  if (project !== null) void api.plans.save({ mode, plan, continues, notes: usePlanning.getState().notes }).catch(() => undefined);
});
import.meta.hot?.dispose(() => unsubscribeRuns());
