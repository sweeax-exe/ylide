// One recommended skill bundled with Ylide: what it does, where it came from,
// and the actions "View content" and "Add & switch on" (which shows the
// content first). Recommended skills are off by default; adding one installs
// its bundled files and switches it on.

import { ExternalLink, FileText, GitBranch, Plug, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecommendedInfo } from '../../bindings/RecommendedInfo';
import { Badge, Button } from '../../components/ui';
import { reportError } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { api, openExternal } from '../../lib/ipc';
import { useToasts } from '../../state/toasts';
import { Note } from '../settings/page/controls';
import { ContentDialog } from './ContentDialog';
import { shortCommit } from './logic';
import s from './Skills.module.css';
import { useSkills } from './store';

export function RecommendedRow({ skill }: { skill: RecommendedInfo }) {
  const { t } = useTranslation('skills');
  const [viewing, setViewing] = useState<'view' | 'enable' | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      // Installs the bundled files and switches it on; reload moves it to "Installed".
      useSkills.getState().set(await api.skills.installRecommended(skill.name));
      await useSkills.getState().load();
      setViewing(null);
      useToasts.getState().push({ tone: 'success', title: t('recommended.added', { name: skill.name }) });
    } catch (e) {
      reportError(e, t('recommended.addFailed', { name: skill.name }));
    } finally {
      setBusy(false);
    }
  };

  const mcpConfirm = skill.needsMcp ? (
    <Note icon={<Plug size={15} aria-hidden />}>{t('recommended.mcpConfirm')}</Note>
  ) : undefined;

  return (
    <li className={s.row}>
      <div className={s.main}>
        <div className={s.titleLine}>
          <span className={s.name}>{skill.name}</span>
          {skill.version && <Badge tone="metal">{t('row.version', { version: skill.version })}</Badge>}
          <Badge tone="accent">{t('recommended.badge')}</Badge>
          {skill.needsMcp && <Badge>{t('recommended.needsMcpBadge')}</Badge>}
        </div>
        {skill.description && <p className={s.description}>{skill.description}</p>}
        <div className={s.meta}>
          <span className={s.source} title={`${skill.repo} · ${skill.license}`}>
            <GitBranch size={13} aria-hidden />
            <span className={`${s.sourceText} selectable`}>
              {skill.repo} · {skill.license}
            </span>
          </span>
          <span className="tabular" title={skill.commit}>
            {t('row.commit', { commit: shortCommit(skill.commit) })}
          </span>
          <span className="tabular">
            {t('row.files', { count: skill.files })} · {formatBytes(skill.bytes)}
          </span>
          <button type="button" className={s.link} onClick={() => void openExternal(skill.url)} title={skill.url}>
            {t('row.openOnGithub')}
            <ExternalLink size={12} aria-hidden />
          </button>
          <button type="button" className={s.link} onClick={() => void openExternal(skill.docsUrl)} title={skill.docsUrl}>
            {t('recommended.docs')}
            <ExternalLink size={12} aria-hidden />
          </button>
        </div>
        {skill.needsMcp && (
          <p className={s.mcpNote}>
            <Plug size={14} aria-hidden />
            <span>{t('recommended.needsMcpHint')}</span>
          </p>
        )}
        <div className={s.actions}>
          <Button size="sm" variant="ghost" icon={<FileText size={13} />} onClick={() => setViewing('view')}>
            {t('row.view')}
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={13} />} loading={busy && viewing === null} onClick={() => setViewing('enable')}>
            {t('recommended.add')}
          </Button>
        </div>
      </div>

      <ContentDialog
        name={skill.name}
        load={() => api.skills.recommendedContent(skill.name)}
        open={viewing !== null}
        confirm={viewing === 'enable'}
        busy={busy}
        note={mcpConfirm}
        enableLabel={t('recommended.addEnable')}
        onEnable={() => void add()}
        onClose={() => setViewing(null)}
      />
    </li>
  );
}
