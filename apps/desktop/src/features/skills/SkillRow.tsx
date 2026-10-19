// One skill: what it does, where it came from, its switch, and the actions
// "View content", "Check for updates" and "Remove".

import { ExternalLink, FileText, FolderOpen, GitBranch, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SkillInfo } from '../../bindings/SkillInfo';
import type { SkillUpdate } from '../../bindings/SkillUpdate';
import { Badge, Button, IconButton, Switch } from '../../components/ui';
import { reportError } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { api, openExternal } from '../../lib/ipc';
import { useToasts } from '../../state/toasts';
import { DiffView } from '../agents/DiffView';
import { SettingsDialog } from '../settings/page/SettingsDialog';
import { ContentDialog } from './ContentDialog';
import { isProjectSkill, needsReview, shortCommit, sourceText, sourceUrl, updateCounts } from './logic';
import { ensureSkillDownloads } from './permission';
import s from './Skills.module.css';
import { useSkills } from './store';

export function SkillRow({ skill, onRemoved }: { skill: SkillInfo; onRemoved: () => void }) {
  const { t } = useTranslation('skills');
  const project = isProjectSkill(skill);
  const [viewing, setViewing] = useState<'view' | 'enable' | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<SkillUpdate | null>(null);
  const [removing, setRemoving] = useState(false);

  const setEnabled = async (on: boolean) => {
    setBusy(true);
    try {
      useSkills.getState().set(await api.skills.setEnabled(skill.id, on));
      setViewing(null);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (on: boolean) => {
    // The content is shown before a skill is switched on the first time.
    if (needsReview(skill, on)) setViewing('enable');
    else void setEnabled(on);
  };

  const check = async () => {
    setChecking(true);
    try {
      if (skill.source.kind === 'github' && !(await ensureSkillDownloads())) return;
      const result = await api.skills.checkUpdate(skill.name);
      if (result.upToDate) useToasts.getState().push({ tone: 'success', title: t('update.upToDate', { name: skill.name }) });
      else setUpdate(result);
    } catch (e) {
      reportError(e, t('update.checkFailed', { name: skill.name }));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (!update) return;
    setBusy(true);
    try {
      await api.skills.update(skill.name, update.commit);
      await useSkills.getState().load();
      setUpdate(null);
      useToasts.getState().push({ tone: 'success', title: t('update.done', { name: skill.name }) });
    } catch (e) {
      reportError(e, t('update.failed', { name: skill.name }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      useSkills.getState().set(await api.skills.remove(skill.name));
      setRemoving(false);
      onRemoved();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const url = sourceUrl(skill.source);
  return (
    <li className={s.row}>
      <div className={s.main}>
        <div className={s.titleLine}>
          <span className={s.name}>{skill.name}</span>
          {skill.version && <Badge tone="metal">{t('row.version', { version: skill.version })}</Badge>}
          {project && <Badge>{t('row.fromProject')}</Badge>}
          {skill.enabled && !skill.error && <Badge tone="accent">{t('row.on')}</Badge>}
          {skill.error && <Badge tone="danger">{t('row.broken')}</Badge>}
        </div>
        {skill.description && <p className={s.description}>{skill.description}</p>}
        {skill.error && <p className={s.problem}>{skill.error}</p>}
        <div className={s.meta}>
          <span className={s.source} title={sourceText(skill.source)}>
            {skill.source.kind === 'github' ? <GitBranch size={13} aria-hidden /> : <FolderOpen size={13} aria-hidden />}
            <span className={`${s.sourceText} selectable`}>{sourceText(skill.source)}</span>
          </span>
          {skill.source.kind === 'github' && (
            <span className="tabular" title={skill.source.commit}>
              {t('row.commit', { commit: shortCommit(skill.source.commit) })}
            </span>
          )}
          <span className="tabular">
            {t('row.files', { count: skill.files })} · {formatBytes(skill.bytes)}
          </span>
          {url && (
            <button type="button" className={s.link} onClick={() => void openExternal(url)} title={url}>
              {t('row.openOnGithub')}
              <ExternalLink size={12} aria-hidden />
            </button>
          )}
        </div>
        <div className={s.actions}>
          <Button size="sm" variant="ghost" icon={<FileText size={13} />} onClick={() => setViewing('view')}>
            {t('row.view')}
          </Button>
          {!project && (
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={checking} disabled={busy} onClick={() => void check()}>
              {t('row.checkUpdate')}
            </Button>
          )}
          {!project && (
            <IconButton label={t('row.remove', { name: skill.name })} onClick={() => setRemoving(true)} disabled={busy}>
              <Trash2 size={14} />
            </IconButton>
          )}
        </div>
      </div>
      <div className={s.switch}>
        <Switch
          checked={skill.enabled && !skill.error}
          disabled={busy || !!skill.error}
          onChange={toggle}
          label={<span className="visually-hidden">{t('row.switch', { name: skill.name })}</span>}
        />
      </div>

      <ContentDialog
        name={skill.name}
        load={() => api.skills.content(skill.id)}
        open={viewing !== null}
        confirm={viewing === 'enable'}
        busy={busy}
        onEnable={() => void setEnabled(true)}
        onClose={() => setViewing(null)}
      />

      <SettingsDialog
        open={update !== null}
        width={760}
        title={t('update.title', { name: skill.name })}
        onClose={() => !busy && setUpdate(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUpdate(null)} disabled={busy}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void install()} data-autofocus>
              {t('update.install')}
            </Button>
          </>
        }
      >
        {update && <UpdateDetails update={update} skill={skill} />}
      </SettingsDialog>

      <SettingsDialog
        open={removing}
        title={t('remove.title', { name: skill.name })}
        onClose={() => !busy && setRemoving(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(false)} disabled={busy} data-autofocus>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void remove()}>
              {t('remove.confirm')}
            </Button>
          </>
        }
      >
        <div className={s.dialogBody}>
          <p>{t('remove.body')}</p>
        </div>
      </SettingsDialog>
    </li>
  );
}

function UpdateDetails({ update, skill }: { update: SkillUpdate; skill: SkillInfo }) {
  const { t } = useTranslation('skills');
  const counts = updateCounts(update);
  const groups = [
    { key: 'added', files: update.added },
    { key: 'changed', files: update.changed },
    { key: 'removed', files: update.removed },
  ] as const;
  return (
    <div className={s.dialogBody}>
      <p>
        {update.commit
          ? t('update.introGithub', { commit: shortCommit(update.commit), source: sourceText(skill.source) })
          : t('update.introFolder', { source: sourceText(skill.source) })}{' '}
        {update.version && update.version !== skill.version && t('update.version', { from: skill.version ?? '–', to: update.version })}
      </p>
      <p>{t('update.summary', { added: counts.added, changed: counts.changed, removed: counts.removed })}</p>
      <ul className={s.changes}>
        {groups.flatMap(({ key, files }) =>
          files.map((f) => (
            <li key={`${key}:${f}`}>
              <Badge tone={key === 'added' ? 'success' : key === 'removed' ? 'danger' : 'metal'}>{t(`update.kind.${key}`)}</Badge> <code>{f}</code>
            </li>
          )),
        )}
      </ul>
      {update.diff && <DiffView diff={update.diff} maxHeight={340} />}
      <p>{t('update.note')}</p>
    </div>
  );
}
