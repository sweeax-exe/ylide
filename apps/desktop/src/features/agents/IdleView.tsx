import { CircleCheck, CircleCheckBig, CircleStop, CircleX, Cpu, FolderOpen, Play, StepForward, TriangleAlert } from 'lucide-react';
import { useId, useMemo, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApprovalMode } from '../../bindings/ApprovalMode';
import type { PermissionSettings } from '../../bindings/PermissionSettings';
import { Badge, Button, Field, Segmented, Spinner, Switch, TextArea } from '../../components/ui';
import { reportError } from '../../lib/errors';
import { pickFolder } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useLayout } from '../../state/layout';
import s from './IdleView.module.css';
import { ChangedFilesList } from './parts';
import { changedFiles, openTaskCount, type RunData } from './run';
import { useAgentRun } from './store';
import { formatClock, formatWhen } from './text';

const MODES: ApprovalMode[] = ['ask', 'autoSafe', 'autonomous'];

export function IdleView() {
  const { t } = useTranslation('agents');
  const draft = useAgentRun((st) => st.draft);
  const setDraft = useAgentRun((st) => st.setDraft);
  const start = useAgentRun((st) => st.start);
  const previous = useAgentRun((st) => (st.run?.outcome ? st.run : null));
  const server = useApp((st) => st.server);
  const workspace = useApp((st) => st.workspace);
  const permissions = useApp((st) => st.settings?.agent.permissions);

  const modelReady = server?.status.state === 'ready';
  const canStart = modelReady && !!workspace && draft.trim().length > 0;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canStart) void start(draft);
  };

  return (
    <div className={s.idle}>
      <form className={s.form} onSubmit={submit}>
        <Field label={t('idle.goalLabel')} hint={t('idle.goalHint')}>
          {(id) => (
            <TextArea
              id={id}
              className={s.goal}
              rows={5}
              value={draft}
              placeholder={t('idle.goalPlaceholder')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
              }}
              spellCheck
            />
          )}
        </Field>
        {permissions && <ModeControl permissions={permissions} />}
        <Readiness />
        <Button type="submit" variant="primary" size="lg" icon={<Play size={15} />} disabled={!canStart} className={s.start}>
          {t('idle.start')}
        </Button>
      </form>
      {previous && <PreviousRun run={previous} />}
    </div>
  );
}

function ModeControl({ permissions: p }: { permissions: PermissionSettings }) {
  const { t } = useTranslation('agents');
  const updateSettings = useApp((st) => st.updateSettings);
  const update = (change: (perm: PermissionSettings) => void) =>
    updateSettings((draft) => change(draft.agent.permissions)).catch((e: unknown) => reportError(e, t('errors.settings')));

  const setMode = (mode: ApprovalMode) =>
    update((perm) => {
      perm.mode = mode;
      // "Safe steps" and "Ask first" promise that commands and deletions ask,
      // so leaving autonomous mode turns both guards back on.
      if (mode !== 'autonomous') {
        perm.confirmCommands = true;
        perm.confirmDeletes = true;
      }
    });

  const unguarded = p.mode === 'autonomous' && (!p.confirmCommands || !p.confirmDeletes);
  const warning = !p.confirmCommands && !p.confirmDeletes ? 'unguardedBoth' : !p.confirmCommands ? 'unguardedCommands' : 'unguardedDeletes';
  const allowed = p.mode !== 'ask' && p.allowedCommands.length > 0;

  return (
    <div className={s.mode}>
      <span className={s.label} aria-hidden>
        {t('mode.label')}
      </span>
      <Segmented label={t('mode.label')} value={p.mode} options={MODES.map((m) => ({ value: m, label: t(`mode.${m}`) }))} onChange={(m) => void setMode(m)} />
      <p className={s.modeHint}>
        {t(`mode.${p.mode}Hint`)}
        {allowed && <> {t('mode.allowedCommands', { count: p.allowedCommands.length })}</>}
      </p>
      {p.mode === 'autonomous' && (
        <div className={`${s.guards} ${unguarded ? s.guardsOff : ''}`}>
          <Switch checked={p.confirmCommands} onChange={(v) => void update((perm) => void (perm.confirmCommands = v))} label={t('mode.confirmCommands')} />
          <Switch checked={p.confirmDeletes} onChange={(v) => void update((perm) => void (perm.confirmDeletes = v))} label={t('mode.confirmDeletes')} />
          {unguarded && (
            <p className={s.warning} role="note">
              <TriangleAlert size={14} aria-hidden />
              {t(`mode.${warning}`)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** What the run needs: a running model and an open project. */
function Readiness() {
  const { t } = useTranslation('agents');
  const server = useApp((st) => st.server);
  const workspace = useApp((st) => st.workspace);
  const openWorkspace = useApp((st) => st.openWorkspace);
  const setMain = useLayout((st) => st.setMain);
  const state = server?.status.state;

  const openFolder = async () => {
    try {
      const path = await pickFolder();
      if (path) await openWorkspace(path);
    } catch (e) {
      reportError(e);
    }
  };

  let model: ReactNode;
  if (state === 'ready') {
    model = <Check ok icon={<Cpu size={14} />} text={t('idle.modelReady', { model: server?.modelName ?? '' })} />;
  } else if (state === 'starting' || state === 'loading') {
    model = <Check icon={<Spinner />} text={t('idle.modelLoading', { model: server?.modelName ?? '' })} />;
  } else {
    model = (
      <Check
        icon={<Cpu size={14} />}
        text={state === 'crashed' ? t('idle.modelCrashed') : t('idle.noModel')}
        action={
          <Button type="button" size="sm" variant="secondary" onClick={() => setMain('models')}>
            {t('idle.openModels')}
          </Button>
        }
      />
    );
  }

  return (
    <ul className={s.checks} aria-label={t('idle.readiness')}>
      {model}
      {state === 'ready' && server?.toolCalls === 'failed' && <Check warn icon={<TriangleAlert size={14} />} text={t('idle.toolCallsFailed')} />}
      {workspace ? (
        <Check ok icon={<FolderOpen size={14} />} text={t('idle.project', { name: workspace.name })} title={workspace.root} />
      ) : (
        <Check
          icon={<FolderOpen size={14} />}
          text={t('idle.noProject')}
          action={
            <Button type="button" size="sm" variant="secondary" onClick={() => void openFolder()}>
              {t('common:actions.openFolder')}
            </Button>
          }
        />
      )}
    </ul>
  );
}

function Check({ icon, text, action, ok = false, warn = false, title }: { icon: ReactNode; text: string; action?: ReactNode; ok?: boolean; warn?: boolean; title?: string }) {
  return (
    <li className={`${s.check} ${ok ? s.ok : ''} ${warn ? s.warn : ''}`} title={title}>
      <span className={s.checkIcon}>{icon}</span>
      <span className={s.checkText}>{text}</span>
      {ok && <CircleCheck size={14} className={s.okMark} aria-hidden />}
      {action}
    </li>
  );
}

function PreviousRun({ run }: { run: RunData }) {
  const { t, i18n } = useTranslation('agents');
  const showRun = useAgentRun((st) => st.showRun);
  const headingId = useId();
  const files = useMemo(() => changedFiles(run.changes), [run.changes]);
  const open = openTaskCount(run);
  if (!run.outcome) return null;
  const tone = run.outcome === 'completed' ? 'success' : run.outcome === 'failed' ? 'danger' : 'neutral';
  const Icon = run.outcome === 'completed' ? CircleCheckBig : run.outcome === 'failed' ? CircleX : CircleStop;
  return (
    <section className={s.previous} aria-labelledby={headingId}>
      <header className={s.previousHead}>
        <h3 id={headingId} className={s.previousTitle}>
          {t('idle.previous')}
        </h3>
        <Badge tone={tone}>
          <Icon size={12} aria-hidden />
          {t(`outcome.${run.outcome}`)}
        </Badge>
        {run.finishedAt !== null && (
          <span className={s.previousTime}>
            {formatWhen(run.finishedAt, i18n.language)} · {formatClock(run.finishedAt - run.startedAt)}
          </span>
        )}
      </header>
      <p className={s.previousGoal}>{run.goal}</p>
      {run.summary?.trim() && <pre className={s.previousSummary}>{run.summary.trim()}</pre>}
      <ChangedFilesList files={files} />
      {open > 0 && <p className={s.previousOpen}>{t('idle.openTasks', { count: open })}</p>}
      <div className={s.previousActions}>
        <Button size="sm" variant="secondary" icon={<StepForward size={13} />} onClick={() => showRun(true)}>
          {t('next.continue')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => showRun()}>
          {t('idle.showRun')}
        </Button>
      </div>
    </section>
  );
}
