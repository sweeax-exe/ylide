// The Skills page: skills teach the local models a task (the open Agent
// Skills format: a folder with a SKILL.md). Installed skills work with every
// model, in the chat and for the agents; each one has its own switch.

import { FolderPlus, Plus, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { SkillInfo } from '../../bindings/SkillInfo';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { reportError } from '../../lib/errors';
import { api, pickFolder } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useToasts } from '../../state/toasts';
import { Note } from '../settings/page/controls';
import { SKILL_SECTIONS } from '../settings/page/ids';
import { Page, PageSection } from '../settings/page/Page';
import { AddFromGithub } from './AddFromGithub';
import { splitSkills } from './logic';
import { SkillRow } from './SkillRow';
import s from './Skills.module.css';
import { useSkills } from './store';

export function SkillsView() {
  const { t } = useTranslation('skills');
  const workspace = useApp((st) => st.workspace);
  const skills = useSkills((st) => st.skills);
  const error = useSkills((st) => st.error);
  const load = useSkills((st) => st.load);
  const [adding, setAdding] = useState(false);

  // Read again whenever the page opens or another project opens (its own skills).
  useEffect(() => {
    void load();
  }, [load, workspace?.root]);

  const { installed, project } = useMemo(() => splitSkills(skills ?? []), [skills]);
  const sections = useMemo(
    () => [
      { id: SKILL_SECTIONS.installed, title: t('installed.title') },
      ...(workspace ? [{ id: SKILL_SECTIONS.project, title: t('project.title') }] : []),
      { id: SKILL_SECTIONS.usage, title: t('usage.title') },
    ],
    [t, workspace],
  );

  return (
    <Page view="skills" title={t('page.title')} intro={t('page.intro')} sections={sections}>
      <Installed skills={installed} loading={skills === null && !error} error={error} onAdd={() => setAdding(true)} />
      {workspace && <ProjectSkills skills={project} loading={skills === null && !error} />}
      <Usage />
      <AddFromGithub open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}

function AddButtons({ onAdd, large }: { onAdd: () => void; large?: boolean }) {
  const { t } = useTranslation('skills');
  const [busy, setBusy] = useState(false);

  const fromFolder = async () => {
    const path = await pickFolder();
    if (!path) return;
    setBusy(true);
    try {
      const added = await api.skills.installFolder(path);
      await useSkills.getState().load();
      useToasts.getState().push({ tone: 'success', title: t('add.installed', { count: added.length }), body: t('add.installedBody', { count: added.length }) });
    } catch (e) {
      reportError(e, t('add.folderFailed'));
    } finally {
      setBusy(false);
    }
  };

  const size = large ? 'md' : 'sm';
  return (
    <>
      <Button size={size} variant="primary" icon={<Plus size={14} />} onClick={onAdd}>
        {t('add.fromGithub')}
      </Button>
      <Button size={size} icon={<FolderPlus size={14} />} loading={busy} onClick={() => void fromFolder()}>
        {t('add.fromFolder')}
      </Button>
    </>
  );
}

function Installed({ skills, loading, error, onAdd }: { skills: SkillInfo[]; loading: boolean; error: string | null; onAdd: () => void }) {
  const { t } = useTranslation('skills');
  const head = useRef<HTMLDivElement>(null);
  // A removed row took the focused button with it; stay in this section.
  const focusSection = () => requestAnimationFrame(() => head.current?.closest('section')?.querySelector<HTMLElement>('[data-section-title]')?.focus());

  return (
    <PageSection id={SKILL_SECTIONS.installed} title={t('installed.title')} description={t('installed.description')}>
      {skills.length > 0 && (
        // In the section, not its header, so the buttons wrap in a narrow column.
        <div className={s.toolbar}>
          <AddButtons onAdd={onAdd} />
        </div>
      )}
      <div ref={head} className={s.notice}>
        <Note icon={<ShieldAlert size={15} aria-hidden />}>{t('trust')}</Note>
      </div>
      {error ? (
        <Note tone="danger">{t('loadFailed', { message: error })}</Note>
      ) : loading ? (
        <div className={s.loading}>
          <Spinner label={t('loading')} />
        </div>
      ) : skills.length === 0 ? (
        <div className={s.empty}>
          <EmptyState
            title={t('installed.emptyTitle')}
            body={t('installed.emptyBody')}
            action={
              <div className={s.emptyActions}>
                <AddButtons onAdd={onAdd} large />
              </div>
            }
          />
        </div>
      ) : (
        <ul className={s.list}>
          {skills.map((skill) => (
            <SkillRow key={skill.id} skill={skill} onRemoved={focusSection} />
          ))}
        </ul>
      )}
    </PageSection>
  );
}

function ProjectSkills({ skills, loading }: { skills: SkillInfo[]; loading: boolean }) {
  const { t } = useTranslation('skills');
  return (
    <PageSection id={SKILL_SECTIONS.project} title={t('project.title')} description={t('project.description')}>
      {loading ? null : skills.length === 0 ? (
        <p className={s.quiet}>
          <Trans t={t} i18nKey="project.empty" components={[<code key="dir" />]} />
        </p>
      ) : (
        <ul className={s.list}>
          {skills.map((skill) => (
            <SkillRow key={skill.id} skill={skill} onRemoved={() => undefined} />
          ))}
        </ul>
      )}
    </PageSection>
  );
}

function Usage() {
  const { t } = useTranslation('skills');
  return (
    <PageSection id={SKILL_SECTIONS.usage} title={t('usage.title')} description={t('usage.description')}>
      <ul className={s.usage}>
        <li>
          <Trans t={t} i18nKey="usage.agents" components={[<strong key="b" />, <code key="c" />]} />
        </li>
        <li>
          <Trans t={t} i18nKey="usage.chat" components={[<strong key="b" />, <code key="c" />]} />
        </li>
        <li>
          <Trans t={t} i18nKey="usage.scripts" components={[<strong key="b" />]} />
        </li>
        <li>
          <Trans t={t} i18nKey="usage.mcp" components={[<strong key="b" />]} />
        </li>
      </ul>
    </PageSection>
  );
}
