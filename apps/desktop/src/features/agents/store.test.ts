import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../bindings/AgentEvent';
import type { DraftImage } from '../../lib/images';

// The agent store talks to the core only through lib/ipc.
const api = vi.hoisted(() => ({
  agents: {
    start: vi.fn(),
    answer: vi.fn(async () => true),
    handover: vi.fn(async () => undefined),
    intervene: vi.fn(async () => undefined),
    lastRun: vi.fn(async () => null),
    checkpoints: vi.fn(async () => []),
  },
  plans: {
    run: vi.fn(async (_plan: unknown, _continues: unknown, _language: string, onEvent: (e: AgentEvent) => void) => {
      emit = onEvent;
      return `run-${++runs}`;
    }),
  },
}));
vi.mock('../../lib/ipc', () => ({ api }));
vi.mock('../../lib/errors', () => ({ reportError: vi.fn() }));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key, language: 'de', resolvedLanguage: 'de' } }));
vi.mock('../../state/app', () => ({ useApp: { getState: () => ({ workspace: { root: 'D:/shop' } }), subscribe: () => () => undefined } }));
vi.mock('../../state/layout', () => ({ useLayout: { getState: () => ({ right: 'agents' }) } }));
vi.mock('../../state/toasts', () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));

const image = (name: string): DraftImage => ({ id: name, url: `data:image/png;base64,${name}`, width: 10, height: 10, name });
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Each start gets its own run id; the events of the last start go to `emit`. */
let emit: (e: AgentEvent) => void = () => undefined;
let runs = 0;

async function load() {
  vi.resetModules();
  const { useAgentRun } = await import('./store');
  return useAgentRun;
}

beforeEach(() => {
  runs = 0;
  vi.clearAllMocks();
  api.agents.start.mockImplementation(async (_goal: string, onEvent: (e: AgentEvent) => void) => {
    emit = onEvent;
    return `run-${++runs}`;
  });
});

describe('agent run images', () => {
  it('sends the goal images with a new run and the next-step images when it continues', async () => {
    const store = await load();
    store.getState().setDraft('Build the cart like the mockup');
    store.getState().setDraftImages([image('mockup')]);
    // Images typed for the next step of an earlier run stay out of a new run.
    store.getState().setFollowUpImages([image('not-yet')]);
    await store.getState().start(store.getState().draft);
    expect(api.agents.start).toHaveBeenLastCalledWith('Build the cart like the mockup', expect.any(Function), null, ['data:image/png;base64,mockup'], 'de');
    expect(store.getState().draftImages).toEqual([]);
    expect(store.getState().run?.images).toEqual(['data:image/png;base64,mockup']);

    emit({ type: 'runFinished', runId: 'run-1', outcome: 'completed', summary: 'Done.', recap: null });
    await flush();
    expect(store.getState().phase).toBe('finished');

    store.getState().setFollowUpImages([image('bug'), image('detail')]);
    await store.getState().continueRun('The button is still blue, see the screenshots');
    expect(api.agents.start).toHaveBeenLastCalledWith(
      'The button is still blue, see the screenshots',
      expect.any(Function),
      'run-1',
      ['data:image/png;base64,bug', 'data:image/png;base64,detail'],
      'de',
    );
    expect(store.getState().followUpImages).toEqual([]);
    expect(store.getState().run?.images).toHaveLength(2);
  });

  it('keeps the images when the core refuses the run', async () => {
    const store = await load();
    api.agents.start.mockRejectedValueOnce(new Error('no_vision'));
    store.getState().setDraftImages([image('mockup')]);
    await store.getState().start('Look at this');
    expect(store.getState().draftImages).toHaveLength(1);
    expect(store.getState().phase).toBe('idle');
  });

  it('sends images with an answer and with a message to an agent', async () => {
    const store = await load();
    await store.getState().start('Fix the cart');
    await store.getState().answer('question-1', ['Like this'], ['data:image/png;base64,a']);
    expect(api.agents.answer).toHaveBeenCalledWith('run-1', 'question-1', ['Like this'], ['data:image/png;base64,a']);
    await store.getState().intervene('coder', ' Use this color ', ['data:image/png;base64,b']);
    expect(api.agents.intervene).toHaveBeenCalledWith('run-1', 'coder', 'Use this color', ['data:image/png;base64,b']);
    await store.getState().intervene('coder', 'No image');
    expect(api.agents.intervene).toHaveBeenLastCalledWith('run-1', 'coder', 'No image', []);
  });
});

describe('agent run questions and plan', () => {
  it('answers a card with one answer per question', async () => {
    const store = await load();
    await store.getState().start('Add tests');
    emit({ type: 'questionForUser', runId: 'run-1', questionId: 'question-1', agentId: 'orchestrator', question: 'q', questions: [], clarify: true });
    await flush();
    await store.getState().answer('question-1', ['Vitest', '']);
    expect(api.agents.answer).toHaveBeenLastCalledWith('run-1', 'question-1', ['Vitest', ''], []);
    expect(store.getState().run?.questions).toEqual([]);
  });

  it('carries out a plan, also one that continues the stopped run', async () => {
    const store = await load();
    const plan = { goal: 'Rabatte', approach: 'a', steps: [{ id: 'T2', title: 'Berechnung', description: '', files: [], verify: '', assignee: 'coder' }], risks: [], questions: [] };
    await store.getState().start('Rabatte');
    emit({ type: 'runFinished', runId: 'run-1', outcome: 'cancelled', summary: '', recap: null });
    await flush();
    store.getState().setDraft('kept');
    expect(await store.getState().runPlan(plan, 'run-1')).toBe(true);
    expect(api.plans.run).toHaveBeenLastCalledWith(plan, 'run-1', 'de', expect.any(Function));
    expect(store.getState().run?.continues?.runId, 'shows the run it goes on with').toBe('run-1');
    expect(store.getState().draft, 'the goal field is left alone').toBe('kept');
    expect(await store.getState().runPlan(plan, null), 'one run at a time').toBe(false);
  });

  it('starts a run from a chat suggestion without touching the drafts', async () => {
    const store = await load();
    store.getState().setDraft('My own goal');
    store.getState().setDraftImages([image('mockup')]);
    expect(await store.getState().startWith('Add a test for an empty cart')).toBe(true);
    expect(api.agents.start).toHaveBeenLastCalledWith('Add a test for an empty cart', expect.any(Function), null, [], 'de');
    expect(store.getState().draft).toBe('My own goal');
    expect(store.getState().draftImages).toHaveLength(1);
    expect(await store.getState().startWith('Another one'), 'one run at a time').toBe(false);
  });
});
