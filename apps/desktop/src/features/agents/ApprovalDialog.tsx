import { ShieldCheck, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ClipboardEventHandler, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApprovalRequest } from '../../bindings/ApprovalRequest';
import type { ApprovalResponse } from '../../bindings/ApprovalResponse';
import type { Question } from '../../bindings/Question';
import type { ToolRisk } from '../../bindings/ToolRisk';
import { Dialog } from '../../components/Dialog';
import { AttachImagesButton, ImageStrip, useDraftImages, useImageInput, useVision } from '../../components/ImageInput';
import { Badge, Button, Field, TextArea, TextInput, type Tone } from '../../components/ui';
import s from './ApprovalDialog.module.css';
import { looksLikeDiff } from './diff';
import { DiffView } from './DiffView';
import { useRoleName } from './hooks';
import { CodeText } from './parts';
import { answersFor, answersOnClick, canSend, emptyDrafts, pick, type AnswerDraft } from './questions';
import type { UserQuestion } from './run';
import { useAgentRun } from './store';

const RISK_TONE: Record<ToolRisk, Tone> = { read: 'neutral', communicate: 'neutral', write: 'warning', delete: 'danger', execute: 'danger' };
const EMPTY: ApprovalRequest[] = [];
const noop = () => {};

/** Shows the oldest pending approval; the next one follows once it is answered. */
export function ApprovalHost() {
  const approvals = useAgentRun((st) => st.run?.approvals ?? EMPTY);
  const request = approvals[0];
  if (!request) return null;
  return <ApprovalDialog key={request.id} request={request} waiting={approvals.length - 1} />;
}

function ApprovalDialog({ request, waiting }: { request: ApprovalRequest; waiting: number }) {
  const { t } = useTranslation('agents');
  const roleName = useRoleName();
  const decide = useAgentRun((st) => st.decide);
  const taskId = useAgentRun((st) => st.run?.agents[request.agentId]?.taskId ?? null);
  const task = useAgentRun((st) => (taskId ? st.run?.tasks[taskId] : undefined));
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<ApprovalResponse['decision'] | null>(null);
  const agent = roleName(request.agentId);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const wasRejecting = useRef(false);

  // Leaving the reason step removes the focused field; keep focus in the dialog.
  useEffect(() => {
    if (wasRejecting.current && !rejecting) rejectRef.current?.focus();
    wasRejecting.current = rejecting;
  }, [rejecting]);

  const send = async (response: ApprovalResponse) => {
    if (busy) return;
    setBusy(response.decision);
    await decide(request, response);
    setBusy(null);
  };

  const titleKey = request.risk === 'write' ? 'titleWrite' : request.risk === 'delete' ? 'titleDelete' : request.risk === 'execute' ? 'titleExecute' : 'titleOther';
  const note =
    request.risk === 'execute' ? (
      <p className={`${s.note} ${s.warn}`}>
        <TriangleAlert size={14} aria-hidden />
        {t('approval.notUndoable')}
      </p>
    ) : request.risk === 'write' || request.risk === 'delete' ? (
      <p className={s.note}>
        <Undo2 size={14} aria-hidden />
        {t('approval.undoable')}
      </p>
    ) : null;

  const footer: ReactNode = rejecting ? (
    <>
      <Button variant="ghost" onClick={() => setRejecting(false)} disabled={!!busy}>
        {t('common:actions.back')}
      </Button>
      <Button variant="danger" onClick={() => void send({ decision: 'reject', reason: reason.trim() || null })} loading={busy === 'reject'}>
        {t('approval.reject')}
      </Button>
    </>
  ) : (
    <>
      {waiting > 0 && <span className={s.queue}>{t('approval.queue', { count: waiting })}</span>}
      <Button ref={rejectRef} variant="danger" onClick={() => setRejecting(true)} disabled={!!busy}>
        {t('approval.reject')}
      </Button>
      <Button variant="secondary" onClick={() => void send({ decision: 'approveAlways' })} loading={busy === 'approveAlways'} disabled={!!busy} title={t('approval.approveAlwaysHint', { tool: request.tool })}>
        {t('approval.approveAlways')}
      </Button>
      <Button variant="primary" icon={<ShieldCheck size={15} />} onClick={() => void send({ decision: 'approve' })} loading={busy === 'approve'} disabled={!!busy}>
        {t('approval.approve')}
      </Button>
    </>
  );

  return (
    <Dialog open modal title={t(`approval.${titleKey}`, { agent })} onClose={noop} width={600} footer={footer}>
      <div className={s.body}>
        <div className={s.meta}>
          <Badge tone={RISK_TONE[request.risk]}>{t(`risk.${request.risk}`)}</Badge>
          <code className={s.tool}>{request.tool}</code>
          {task && (
            <span className={s.task}>
              <span className={s.taskId}>{task.id}</span> {task.title}
            </span>
          )}
        </div>
        <p className={s.title}>
          <CodeText text={request.title} />
        </p>
        <ApprovalDetail request={request} />
        {note}
        {!rejecting && <p className={s.hint}>{t('approval.approveAlwaysHint', { tool: request.tool })}</p>}
        {rejecting && (
          <Field label={t('approval.reasonLabel')} hint={t('approval.reasonHint')}>
            {(id) => (
              <TextInput
                id={id}
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void send({ decision: 'reject', reason: reason.trim() || null });
                  }
                }}
                placeholder={t('approval.reasonPlaceholder')}
                spellCheck
              />
            )}
          </Field>
        )}
      </div>
    </Dialog>
  );
}

/** The diff of an edit, the full command, or the path, as the core sent it. */
function ApprovalDetail({ request }: { request: ApprovalRequest }) {
  const { t } = useTranslation('agents');
  const detail = request.detail;
  if (!detail.trim()) return null;
  // Initial focus lands on the detail, never on a button, so a stray Enter cannot approve.
  if (request.tool === 'edit_file' || request.tool === 'write_file' || looksLikeDiff(detail)) {
    return (
      <div className={s.detail}>
        <span className={s.detailLabel}>{t('approval.changes')}</span>
        <DiffView diff={detail} maxHeight={300} autoFocus />
      </div>
    );
  }
  const label = request.risk === 'execute' ? t('approval.command') : request.risk === 'delete' ? t('approval.path') : t('approval.detail');
  return (
    <div className={s.detail}>
      <span className={s.detailLabel}>{label}</span>
      <pre className={request.risk === 'execute' ? s.command : s.block} tabIndex={0} data-autofocus="" aria-label={label}>
        {detail}
      </pre>
    </div>
  );
}

/**
 * Dialog for questions an agent asks the user: one, or before the plan up
 * to three. A question with answers to click shows them as buttons (the
 * recommended one marked) with a field for the user's own answer; for a
 * single question that takes one answer, the click answers it.
 */
export function QuestionDialog({ question, onLater }: { question: UserQuestion; onLater: () => void }) {
  const { t } = useTranslation('agents');
  const roleName = useRoleName();
  const answer = useAgentRun((st) => st.answer);
  const questions = question.questions;
  const [drafts, setDrafts] = useState<AnswerDraft[]>(() => emptyDrafts(questions.length));
  const [busy, setBusy] = useState(false);
  const [images, getImages, setImages] = useDraftImages();
  const vision = useVision();
  const imageInput = useImageInput(getImages, setImages, vision);
  const imagesBlocked = images.length > 0 && !vision.canSee;
  const plain = questions.length === 1 && questions[0].options.length === 0;
  const byClick = answersOnClick(questions);
  const ready = canSend(questions, drafts) && !imagesBlocked;

  const send = async (answers: string[]) => {
    if (busy || imagesBlocked) return;
    setBusy(true);
    await answer(question.id, answers, images.map((i) => i.url));
    setBusy(false);
  };
  const change = (index: number, edit: (d: AnswerDraft) => AnswerDraft) => {
    const next = drafts.map((d, i) => (i === index ? edit(d) : d));
    setDrafts(next);
    return next;
  };
  const choose = (index: number, option: number) => {
    const next = change(index, (d) => pick(d, option, questions[index].multiple));
    if (byClick) void send(answersFor(questions, next));
  };
  const submit = () => {
    if (ready) void send(answersFor(questions, drafts));
  };

  const title = question.clarify ? t('question.clarifyTitle') : t('question.title', { agent: roleName(question.agentId) });
  return (
    <Dialog
      open
      title={title}
      onClose={onLater}
      width={questions.length > 1 ? 600 : 520}
      footer={
        <>
          <Button variant="ghost" onClick={onLater}>
            {t('question.later')}
          </Button>
          {question.clarify && (
            <Button variant="secondary" onClick={() => void send(questions.map(() => ''))} disabled={busy || imagesBlocked} title={t('question.skipHint')}>
              {t('question.skip')}
            </Button>
          )}
          <Button variant="primary" onClick={submit} loading={busy} disabled={!ready}>
            {plain || byClick ? t('question.send') : t('question.sendAll')}
          </Button>
        </>
      }
    >
      <div className={`${s.body} ${imageInput.dragging ? s.dropping : ''}`} onDragOver={imageInput.onDragOver} onDragLeave={imageInput.onDragLeave} onDrop={imageInput.onDrop}>
        {question.clarify && <p className={s.hint}>{t('question.clarifyIntro')}</p>}
        {plain ? (
          <>
            <p className={s.question}>{questions[0].question}</p>
            <Field label={t('question.answerLabel')} hint={t('question.hint')}>
              {(id) => (
                <TextArea
                  id={id}
                  data-autofocus=""
                  rows={4}
                  value={drafts[0]?.own ?? ''}
                  onChange={(e) => change(0, (d) => ({ ...d, own: e.target.value }))}
                  onPaste={imageInput.onPaste}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              )}
            </Field>
          </>
        ) : (
          <div className={s.questionRows}>
            {questions.map((q, i) => (
              <QuestionRow
                key={i}
                question={q}
                draft={drafts[i]}
                numbered={questions.length > 1 ? i + 1 : null}
                toggles={!byClick}
                autoFocus={i === 0}
                disabled={busy}
                onPick={(option) => choose(i, option)}
                onOwn={(own) => change(i, (d) => ({ ...d, own }))}
                onSubmit={submit}
                onPaste={imageInput.onPaste}
              />
            ))}
          </div>
        )}
        <div className={s.answerImages}>
          <ImageStrip images={images} onRemove={imageInput.remove} size="sm" />
          <AttachImagesButton vision={vision} onPick={imageInput.pick} busy={imageInput.busy} />
          {imagesBlocked && <span className={s.answerImagesHint}>{vision.hint}</span>}
        </div>
      </div>
    </Dialog>
  );
}

/** One question with its answers to click and a field for an own answer (question cards, the plan's open questions). */
export function QuestionRow({
  question,
  draft,
  numbered,
  toggles,
  autoFocus,
  disabled,
  onPick,
  onOwn,
  onSubmit,
  onPaste,
}: {
  question: Question;
  draft: AnswerDraft;
  numbered: number | null;
  /** The buttons pick (several questions, or several answers); else a click answers. */
  toggles: boolean;
  autoFocus: boolean;
  disabled: boolean;
  onPick: (option: number) => void;
  onOwn: (text: string) => void;
  onSubmit: () => void;
  onPaste?: ClipboardEventHandler;
}) {
  const { t } = useTranslation('agents');
  const id = useId();
  return (
    <div className={s.questionRow} role="group" aria-labelledby={id}>
      <p id={id} className={s.question}>
        {numbered !== null && <span className={s.questionNumber}>{numbered}.</span>}
        {question.question}
      </p>
      {question.options.length > 0 && (
        <div className={s.options}>
          {question.options.map((o, i) => (
            <button key={i} type="button" className={s.option} aria-pressed={toggles ? draft.picked.includes(i) : undefined} disabled={disabled} onClick={() => onPick(i)}>
              <span className={s.optionLabel}>{o.label}</span>
              {o.recommended && <span className={s.recommended}>{t('question.recommended')}</span>}
            </button>
          ))}
        </div>
      )}
      {question.multiple && <span className={s.optionHint}>{t('question.several')}</span>}
      <TextInput
        data-autofocus={autoFocus ? '' : undefined}
        aria-label={t('question.ownLabel', { question: question.question })}
        placeholder={question.options.length ? t('question.own') : t('question.answerLabel')}
        value={draft.own}
        disabled={disabled}
        onChange={(e) => onOwn(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        spellCheck
      />
    </div>
  );
}
