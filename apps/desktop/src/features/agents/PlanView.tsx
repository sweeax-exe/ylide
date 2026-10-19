// Planning mode: the plan as a clean document the user reads, changes in
// conversation ("Ändere Schritt 2 …") and edits by hand (rename, reorder,
// remove, add steps), with the orchestrator's open questions as cards.
// "Umsetzen" carries it out; switching back to Planen during a run brings
// the open tasks back here.

import { ArrowDown, ArrowUp, Check, FileDown, ListChecks, Pencil, Play, Plus, SendHorizontal, Square, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanDoc } from '../../bindings/PlanDoc';
import type { PlanStep } from '../../bindings/PlanStep';
import { Braid } from '../../components/Braid';
import { Button, IconButton, TextArea, TextInput } from '../../components/ui';
import { useApp } from '../../state/app';
import { useConfirm } from '../../state/confirm';
import { AgentList } from './AgentList';
import { QuestionRow } from './ApprovalDialog';
import { addStep, moveStep, parseFiles, removeStep, updateStep } from './plan';
import { continuedNumber, usePlanning } from './planStore';
import { answersFor, canSend, emptyDrafts, pick, type AnswerDraft } from './questions';
import { openTaskCount } from './run';
import s from './PlanView.module.css';
import { useAgentRun } from './store';

export function PlanView() {
  const plan = usePlanning((st) => st.plan);
  const busy = usePlanning((st) => st.busy);
  const handover = usePlanning((st) => st.handover);
  return (
    <div className={s.view}>
      {handover && <Handover />}
      {!handover && (plan || busy ? <PlanBody plan={plan} /> : <PlanStart />)}
    </div>
  );
}

/** Before there is a plan: what planning mode does, and the request. */
function PlanStart() {
  const { t } = useTranslation('agents');
  const id = useId();
  const draft = usePlanning((st) => st.draft);
  const setDraft = usePlanning((st) => st.setDraft);
  const send = usePlanning((st) => st.send);
  const adopt = usePlanning((st) => st.adopt);
  const finished = useAgentRun((st) => (st.run?.outcome ? st.run : null));
  const ready = useApp((st) => st.server?.status.state === 'ready' && !!st.workspace);
  const open = finished ? openTaskCount(finished) : 0;
  const canSendNow = ready && draft.trim().length > 0;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canSendNow) void send(draft);
  };

  return (
    <form className={s.start} onSubmit={submit}>
      <div className={s.intro}>
        <ListChecks size={18} aria-hidden className={s.introIcon} />
        <div>
          <p className={s.introTitle}>{t('plan.introTitle')}</p>
          <p className={s.introBody}>{t('plan.introBody')}</p>
        </div>
      </div>
      <label className={s.label} htmlFor={id}>
        {t('plan.goalLabel')}
      </label>
      <TextArea
        id={id}
        className={s.goalInput}
        rows={4}
        value={draft}
        placeholder={t('plan.goalPlaceholder')}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
        }}
        spellCheck
      />
      <div className={s.startRow}>
        <span className={s.hint}>{ready ? t('plan.createHint') : t('plan.notReady')}</span>
        <Button type="submit" variant="primary" icon={<ListChecks size={15} />} disabled={!canSendNow}>
          {t('plan.create')}
        </Button>
      </div>
      {finished && open > 0 && (
        <div className={s.adopt}>
          <span className={s.hint}>{t('plan.adoptHint', { goal: finished.goal })}</span>
          <Button variant="secondary" size="sm" onClick={() => adopt(finished)}>
            {t('plan.adopt')}
          </Button>
        </div>
      )}
    </form>
  );
}

/** The user switched to Planen during a run: it finishes the current task first. */
function Handover() {
  const { t } = useTranslation('agents');
  const setMode = usePlanning((st) => st.setMode);
  const task = useAgentRun((st) => {
    const run = st.run;
    const id = run?.taskOrder.find((tid) => run.tasks[tid]?.status === 'inProgress' || run.tasks[tid]?.status === 'inReview');
    return id && run ? `${id} ${run.tasks[id].title}` : null;
  });
  return (
    <div className={s.handover}>
      <div className={s.banner} role="status">
        <Braid active size={12} />
        <span className={s.bannerText}>{task ? t('plan.handover', { task }) : t('plan.handoverNoTask')}</span>
        <Button size="sm" variant="secondary" onClick={() => void setMode('code')}>
          {t('plan.keepGoing')}
        </Button>
      </div>
      <AgentList />
    </div>
  );
}

function PlanBody({ plan }: { plan: PlanDoc | null }) {
  const busy = usePlanning((st) => st.busy);
  return (
    <>
      <div className={s.scroll}>
        {plan ? <PlanDocument plan={plan} /> : <FirstDraft />}
        <Notes />
      </div>
      {busy && <Working />}
      {plan && <Composer />}
      {plan && <Footer plan={plan} />}
    </>
  );
}

/** While the first plan is written: the request, and that the orchestrator reads. */
function FirstDraft() {
  const { t } = useTranslation('agents');
  const goal = usePlanning((st) => st.run?.goal ?? '');
  return (
    <div className={s.doc}>
      <span className={s.kicker}>{t('plan.kicker')}</span>
      <h3 className={s.goal}>{goal}</h3>
      <p className={s.hint}>{t('plan.firstDraft')}</p>
    </div>
  );
}

/** The orchestrator at work, with its current step and a way to stop it. */
function Working() {
  const { t } = useTranslation('agents');
  const stop = usePlanning((st) => st.stop);
  const step = usePlanning((st) => {
    const o = st.run?.agents.orchestrator;
    return o && o.step && o.step !== 'thinking' && o.step !== 'plan ready' ? o.step : '';
  });
  return (
    <div className={s.working} role="status">
      <Braid active size={12} />
      <span className={s.workingText}>
        {t('plan.working')}
        {step && <code className={s.workingStep}>{step}</code>}
      </span>
      <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={() => void stop()}>
        {t('plan.stop')}
      </Button>
    </div>
  );
}

function PlanDocument({ plan }: { plan: PlanDoc }) {
  const { t } = useTranslation('agents');
  const busy = usePlanning((st) => st.busy);
  const changes = usePlanning((st) => st.changes);
  const changedAt = usePlanning((st) => st.changedAt);
  const edit = usePlanning((st) => st.edit);
  const continues = usePlanning((st) => st.continues);
  const done = useAgentRun((st) => (continues && st.run?.runId === continues ? st.run : null));
  const [editing, setEditing] = useState<string | null>(null);
  // Changed parts flash once: a new key per change restarts the animation.
  const flash = (changed: boolean | undefined, id: string) => (changed ? { key: `${id}@${changedAt}`, className: s.flash } : { key: id, className: '' });

  const add = () => {
    const { doc, id } = addStep(plan, '', continuedNumber());
    edit(() => doc);
    setEditing(id);
  };
  const approachFlash = flash(changes?.approach, 'approach');
  const risksFlash = flash(changes?.risks, 'risks');
  const doneTasks = done ? done.taskOrder.map((id) => done.tasks[id]).filter((task) => task?.status === 'done') : [];

  return (
    <article className={s.doc} aria-busy={busy}>
      <header>
        <span className={s.kicker}>{t('plan.kicker')}</span>
        <h3 className={s.goal}>{plan.goal}</h3>
      </header>

      {plan.approach.trim() && (
        <section className={s.section}>
          <h4 className={s.heading}>{t('plan.approach')}</h4>
          <p key={approachFlash.key} className={`${s.approach} ${approachFlash.className}`}>
            {plan.approach}
          </p>
        </section>
      )}

      {doneTasks.length > 0 && (
        <section className={s.section}>
          <h4 className={s.heading}>{t('plan.done')}</h4>
          <ul className={s.doneList}>
            {doneTasks.map((task) => (
              <li key={task.id} className={s.doneItem}>
                <Check size={13} aria-hidden />
                <span className={s.stepId}>{task.id}</span>
                <span className={s.doneTitle}>{task.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={s.section}>
        <h4 className={s.heading}>{t('plan.steps')}</h4>
        {plan.steps.length === 0 && <p className={s.hint}>{t('plan.noSteps')}</p>}
        <ol className={s.steps}>
          {plan.steps.map((step, i) => {
            const f = flash(changes?.steps.includes(step.id), step.id);
            return (
              <StepItem
                key={f.key}
                step={step}
                first={i === 0}
                last={i === plan.steps.length - 1}
                flashing={f.className}
                editing={editing === step.id}
                disabled={busy}
                onEdit={() => setEditing(step.id)}
                onClose={(saved) => {
                  // A new step left empty goes away again.
                  if (!saved && !step.title.trim()) edit((p) => removeStep(p, step.id));
                  setEditing(null);
                }}
              />
            );
          })}
        </ol>
        <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={add} disabled={busy || editing !== null} className={s.addStep}>
          {t('plan.addStep')}
        </Button>
      </section>

      {plan.risks.length > 0 && (
        <section className={s.section}>
          <h4 className={s.heading}>{t('plan.risks')}</h4>
          <ul key={risksFlash.key} className={`${s.risks} ${risksFlash.className}`}>
            {plan.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      {plan.questions.length > 0 && <OpenQuestions key={flash(changes?.questions, 'questions').key} plan={plan} />}
    </article>
  );
}

function StepItem({
  step,
  first,
  last,
  flashing,
  editing,
  disabled,
  onEdit,
  onClose,
}: {
  step: PlanStep;
  first: boolean;
  last: boolean;
  flashing: string;
  editing: boolean;
  disabled: boolean;
  onEdit: () => void;
  onClose: (saved: boolean) => void;
}) {
  const { t } = useTranslation('agents');
  const edit = usePlanning((st) => st.edit);
  if (editing) return <StepEditor step={step} onClose={onClose} />;
  return (
    <li className={`${s.step} ${flashing}`}>
      <span className={s.stepId}>{step.id}</span>
      <div className={s.stepBody}>
        <p className={s.stepTitle}>{step.title || t('plan.newStep')}</p>
        {step.description.trim() && <p className={s.stepText}>{step.description}</p>}
        {(step.files.length > 0 || step.verify.trim()) && (
          <dl className={s.meta}>
            {step.files.length > 0 && (
              <div className={s.metaRow}>
                <dt>{t('plan.files')}</dt>
                <dd className={s.files}>
                  {step.files.map((f) => (
                    <code key={f}>{f}</code>
                  ))}
                </dd>
              </div>
            )}
            {step.verify.trim() && (
              <div className={s.metaRow}>
                <dt>{t('plan.verify')}</dt>
                <dd>{step.verify}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
      <div className={s.stepActions}>
        <IconButton label={t('plan.moveUp')} disabled={disabled || first} onClick={() => edit((p) => moveStep(p, step.id, -1))}>
          <ArrowUp size={14} />
        </IconButton>
        <IconButton label={t('plan.moveDown')} disabled={disabled || last} onClick={() => edit((p) => moveStep(p, step.id, 1))}>
          <ArrowDown size={14} />
        </IconButton>
        <IconButton label={t('plan.edit')} disabled={disabled} onClick={onEdit}>
          <Pencil size={14} />
        </IconButton>
        <IconButton label={t('plan.remove')} disabled={disabled} onClick={() => edit((p) => removeStep(p, step.id))}>
          <Trash2 size={14} />
        </IconButton>
      </div>
    </li>
  );
}

function StepEditor({ step, onClose }: { step: PlanStep; onClose: (saved: boolean) => void }) {
  const { t } = useTranslation('agents');
  const edit = usePlanning((st) => st.edit);
  const [title, setTitle] = useState(step.title);
  const [description, setDescription] = useState(step.description);
  const [files, setFiles] = useState(step.files.join(', '));
  const [verify, setVerify] = useState(step.verify);
  const ids = { title: useId(), description: useId(), files: useId(), verify: useId() };

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!title.trim()) return;
    edit((p) => updateStep(p, step.id, { title: title.trim(), description: description.trim(), files: parseFiles(files), verify: verify.trim() }));
    onClose(true);
  };

  return (
    <li className={`${s.step} ${s.stepEditing}`}>
      <span className={s.stepId}>{step.id}</span>
      <form
        className={s.editor}
        onSubmit={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose(false);
          }
        }}
      >
        <label htmlFor={ids.title}>{t('plan.titleLabel')}</label>
        <TextInput id={ids.title} autoFocus value={title} placeholder={t('plan.newStep')} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor={ids.description}>{t('plan.descriptionLabel')}</label>
        <TextArea id={ids.description} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} spellCheck />
        <label htmlFor={ids.files}>{t('plan.filesLabel')}</label>
        <TextInput id={ids.files} value={files} className={s.mono} onChange={(e) => setFiles(e.target.value)} />
        <label htmlFor={ids.verify}>{t('plan.verifyLabel')}</label>
        <TextInput id={ids.verify} value={verify} onChange={(e) => setVerify(e.target.value)} />
        <div className={s.editorActions}>
          <Button size="sm" variant="ghost" onClick={() => onClose(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!title.trim()}>
            {t('plan.apply')}
          </Button>
        </div>
      </form>
    </li>
  );
}

/** The orchestrator's open questions, answered with the same cards as during a run. */
function OpenQuestions({ plan }: { plan: PlanDoc }) {
  const { t } = useTranslation('agents');
  const busy = usePlanning((st) => st.busy);
  const answer = usePlanning((st) => st.answer);
  const [drafts, setDrafts] = useState<AnswerDraft[]>(() => emptyDrafts(plan.questions.length));
  const change = (index: number, edit: (d: AnswerDraft) => AnswerDraft) => setDrafts((all) => all.map((d, i) => (i === index ? edit(d) : d)));
  const ready = canSend(plan.questions, drafts) && !busy;
  const submit = () => {
    if (ready) void answer(answersFor(plan.questions, drafts));
  };
  return (
    <section className={`${s.section} ${s.questions}`}>
      <h4 className={s.heading}>{t('plan.questions')}</h4>
      {plan.questions.map((q, i) => (
        <QuestionRow
          key={i}
          question={q}
          draft={drafts[i] ?? { picked: [], own: '' }}
          numbered={plan.questions.length > 1 ? i + 1 : null}
          toggles
          autoFocus={false}
          disabled={busy}
          onPick={(option) => change(i, (d) => pick(d, option, q.multiple))}
          onOwn={(own) => change(i, (d) => ({ ...d, own }))}
          onSubmit={submit}
        />
      ))}
      <div className={s.questionsActions}>
        <Button size="sm" variant="primary" onClick={submit} disabled={!ready}>
          {t('plan.answer')}
        </Button>
      </div>
    </section>
  );
}

/** The conversation about the plan: the user's wishes and what came of them. */
function Notes() {
  const { t } = useTranslation('agents');
  const notes = usePlanning((st) => st.notes);
  if (!notes.length) return null;
  let created = false;
  return (
    <ol className={s.notes} aria-label={t('plan.notesLabel')}>
      {notes.map((n, i) => {
        if (n.kind === 'wish' || n.kind === 'answers') {
          return (
            <li key={i} className={s.wish}>
              {n.text}
            </li>
          );
        }
        let text: string;
        if (n.kind === 'updated') {
          text = created ? t('plan.noteUpdated') : t('plan.noteCreated');
          created = true;
        } else if (n.kind === 'failed') text = t('plan.noteFailed');
        else text = t('plan.noteTookOver');
        return (
          <li key={i} className={`${s.event} ${n.kind === 'failed' ? s.eventFailed : ''}`}>
            {text}
          </li>
        );
      })}
    </ol>
  );
}

/** "Ändere Schritt 2 …": the plan changes in place. */
function Composer() {
  const { t } = useTranslation('agents');
  const id = useId();
  const draft = usePlanning((st) => st.draft);
  const setDraft = usePlanning((st) => st.setDraft);
  const send = usePlanning((st) => st.send);
  const busy = usePlanning((st) => st.busy);
  const ready = useApp((st) => st.server?.status.state === 'ready' && !!st.workspace);
  const canSendNow = ready && !busy && draft.trim().length > 0;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canSendNow) void send(draft);
  };
  return (
    <form className={s.composer} onSubmit={submit}>
      <label className="visually-hidden" htmlFor={id}>
        {t('plan.chatLabel')}
      </label>
      <TextArea
        id={id}
        className={s.composerInput}
        rows={2}
        value={draft}
        placeholder={t('plan.chatPlaceholder')}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        spellCheck
      />
      <IconButton type="submit" label={t('plan.send')} disabled={!canSendNow} className={s.sendButton}>
        <SendHorizontal size={15} />
      </IconButton>
    </form>
  );
}

function Footer({ plan }: { plan: PlanDoc }) {
  const { t } = useTranslation('agents');
  const busy = usePlanning((st) => st.busy);
  const carryOut = usePlanning((st) => st.carryOut);
  const saveFile = usePlanning((st) => st.saveFile);
  const discard = usePlanning((st) => st.discard);
  const ready = useApp((st) => st.server?.status.state === 'ready' && !!st.workspace);
  const agentsBusy = useAgentRun((st) => st.phase === 'starting' || st.phase === 'running');
  const [saving, setSaving] = useState(false);
  const canRun = ready && !busy && !agentsBusy && plan.steps.length > 0 && plan.steps.every((step) => step.title.trim());

  const askDiscard = async () => {
    const ok = await useConfirm.getState().ask({ title: t('plan.discardTitle'), body: t('plan.discardBody'), confirmLabel: t('plan.discard'), danger: true });
    if (ok) discard();
  };

  return (
    <div className={s.footer}>
      <div className={s.footerSide}>
        <IconButton
          label={t('plan.saveFile')}
          disabled={busy || saving}
          onClick={async () => {
            setSaving(true);
            await saveFile();
            setSaving(false);
          }}
        >
          <FileDown size={15} />
        </IconButton>
        <IconButton label={t('plan.discard')} disabled={busy} onClick={() => void askDiscard()}>
          <Trash2 size={15} />
        </IconButton>
      </div>
      <Button variant="primary" icon={<Play size={14} />} disabled={!canRun} onClick={() => void carryOut()} title={t('plan.carryOutHint')}>
        {t('plan.carryOut')}
      </Button>
    </div>
  );
}
