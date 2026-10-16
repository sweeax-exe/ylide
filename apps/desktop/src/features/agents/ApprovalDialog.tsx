import { ShieldCheck, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApprovalRequest } from '../../bindings/ApprovalRequest';
import type { ApprovalResponse } from '../../bindings/ApprovalResponse';
import type { ToolRisk } from '../../bindings/ToolRisk';
import { Dialog } from '../../components/Dialog';
import { Badge, Button, Field, TextArea, TextInput, type Tone } from '../../components/ui';
import s from './ApprovalDialog.module.css';
import { looksLikeDiff } from './diff';
import { DiffView } from './DiffView';
import { useRoleName } from './hooks';
import { CodeText } from './parts';
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

/** Dialog for a question an agent asks the user. */
export function QuestionDialog({ question, onLater }: { question: UserQuestion; onLater: () => void }) {
  const { t } = useTranslation('agents');
  const roleName = useRoleName();
  const answer = useAgentRun((st) => st.answer);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await answer(question.id, text.trim());
    setBusy(false);
  };

  return (
    <Dialog
      open
      title={t('question.title', { agent: roleName(question.agentId) })}
      onClose={onLater}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onLater}>
            {t('question.later')}
          </Button>
          <Button variant="primary" onClick={() => void send()} loading={busy} disabled={!text.trim()}>
            {t('question.send')}
          </Button>
        </>
      }
    >
      <div className={s.body}>
        <p className={s.question}>{question.question}</p>
        <Field label={t('question.answerLabel')} hint={t('question.hint')}>
          {(id) => (
            <TextArea
              id={id}
              data-autofocus=""
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
