// Adding skills from GitHub: paste a repository (or a folder in it), see
// every SKILL.md it has, read them, pick some. They are installed pinned to
// the listed commit and start switched off.

import { Globe } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RepoListing } from '../../bindings/RepoListing';
import { Badge, Button, Field, Spinner, TextInput } from '../../components/ui';
import { errorText, reportError } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { api } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useToasts } from '../../state/toasts';
import { Note } from '../settings/page/controls';
import { SettingsDialog } from '../settings/page/SettingsDialog';
import { installable, shortCommit, toggleAll, toggleChoice } from './logic';
import { allowSkillDownloads } from './permission';
import s from './Skills.module.css';
import { useSkills } from './store';

export const EXAMPLE_REPO = 'https://github.com/morluto/rea';

export function AddFromGithub({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('skills');
  const allowed = useApp((st) => !!st.settings?.network.allowSkillDownloads);
  const [address, setAddress] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<RepoListing | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [allowing, setAllowing] = useState(false);

  const close = () => {
    if (installing) return;
    setListing(null);
    setChosen([]);
    setError(null);
    onClose();
  };

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!address.trim() || !allowed) return;
    setSearching(true);
    setError(null);
    setListing(null);
    setChosen([]);
    try {
      const found = await api.skills.browse(address.trim());
      setListing(found);
      // A single skill is chosen right away.
      const usable = found.candidates.filter(installable);
      if (found.candidates.length === 1 && usable.length === 1) setChosen([usable[0].path]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSearching(false);
    }
  };

  const allow = async () => {
    setAllowing(true);
    try {
      await allowSkillDownloads();
    } catch (err) {
      reportError(err);
    } finally {
      setAllowing(false);
    }
  };

  const install = async () => {
    if (!listing || !chosen.length) return;
    setInstalling(true);
    try {
      const added = await api.skills.installGithub(listing.repo, listing.gitRef, listing.commit, chosen);
      await useSkills.getState().load();
      useToasts.getState().push({ tone: 'success', title: t('add.installed', { count: added.length }), body: t('add.installedBody', { count: added.length }) });
      setInstalling(false);
      close();
    } catch (err) {
      reportError(err, t('add.installFailed'));
      setInstalling(false);
    }
  };

  const usable = listing?.candidates.filter(installable) ?? [];
  return (
    <SettingsDialog
      open={open}
      width={720}
      title={t('add.title')}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={installing}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={installing} disabled={!chosen.length} onClick={() => void install()}>
            {chosen.length ? t('add.install', { count: chosen.length }) : t('add.installNone')}
          </Button>
        </>
      }
    >
      <div className={s.dialogBody}>
        <p>{t('add.intro')}</p>
        {!allowed && (
          <Note
            icon={<Globe size={15} aria-hidden />}
            action={
              <Button size="sm" loading={allowing} onClick={() => void allow()}>
                {t('permission.allow')}
              </Button>
            }
          >
            {t('add.permission')}
          </Note>
        )}
        <form onSubmit={(e) => void search(e)}>
          <Field label={t('add.addressLabel')} hint={t('add.addressHint')}>
            {(id) => (
              <div className={s.addressLine}>
                <TextInput id={id} value={address} placeholder={EXAMPLE_REPO} onChange={(e) => setAddress(e.target.value)} disabled={!allowed} data-autofocus />
                <Button type="submit" variant={listing ? 'secondary' : 'primary'} loading={searching} disabled={!allowed || !address.trim()}>
                  {t('add.search')}
                </Button>
              </div>
            )}
          </Field>
        </form>
        {searching && (
          <div className={s.loading}>
            <Spinner label={t('add.searching')} />
          </div>
        )}
        {error && <Note tone="danger">{error}</Note>}
        {listing && (
          <>
            <div className={s.listingHead}>
              <span>
                {t('add.found', { count: listing.candidates.length, repo: listing.repo })} <code title={listing.commit}>{shortCommit(listing.commit)}</code>
              </span>
              {usable.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => setChosen(toggleAll(chosen, listing))}>
                  {usable.every((c) => chosen.includes(c.path)) ? t('add.chooseNone') : t('add.chooseAll')}
                </Button>
              )}
            </div>
            <ul className={s.candidates} aria-label={t('add.listLabel')}>
              {listing.candidates.map((c) => {
                const enabled = installable(c);
                return (
                  <li key={c.path} className={s.candidate}>
                    <label className={s.pick} data-disabled={!enabled}>
                      <input type="checkbox" checked={chosen.includes(c.path)} disabled={!enabled} onChange={() => setChosen(toggleChoice(chosen, c.path, listing))} />
                      <span className={s.candidateText}>
                        <span className={s.titleLine}>
                          <span className={s.name}>{c.name}</span>
                          {c.version && <Badge tone="metal">{t('row.version', { version: c.version })}</Badge>}
                          {c.installed && <Badge tone="accent">{t('add.alreadyInstalled')}</Badge>}
                          {c.error && <Badge tone="danger">{t('add.notInstallable')}</Badge>}
                        </span>
                        {c.description && <span className={s.description}>{c.description}</span>}
                        {c.error && <span className={s.problem}>{c.error}</span>}
                        <span className={s.meta}>
                          <span className={s.sourceText}>{c.path || '/'}</span>
                          <span className="tabular">
                            {t('row.files', { count: c.files })} · {formatBytes(c.bytes)}
                          </span>
                        </span>
                      </span>
                    </label>
                    {c.content && (
                      <details className={s.peek}>
                        <summary>{t('add.viewContent')}</summary>
                        <pre className={`${s.text} selectable`} tabIndex={0}>
                          {c.content}
                        </pre>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
            <p>{t('add.startOff')}</p>
          </>
        )}
      </div>
    </SettingsDialog>
  );
}
