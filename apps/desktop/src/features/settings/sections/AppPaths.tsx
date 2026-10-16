// Version and the folders Ylide uses on this computer.

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppInfo } from '../../../bindings/AppInfo';
import { IconButton, Spinner } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { Group } from '../page/controls';
import s from './AppPaths.module.css';

export function AppPaths({ info }: { info: AppInfo | null }) {
  const { t } = useTranslation('settings');
  return (
    <Group title={t('about.title')} description={t('about.description')}>
      {info ? (
        <dl className={s.list}>
          <div className={s.item}>
            <dt>{t('about.version')}</dt>
            <dd className="tabular">{info.version}</dd>
          </div>
          <div className={s.item}>
            <dt>{t('about.system')}</dt>
            <dd>{t('about.systemValue', { os: info.os, arch: info.arch })}</dd>
          </div>
          <PathItem label={t('about.configDir')} path={info.configDir} />
          <PathItem label={t('about.dataDir')} path={info.dataDir} />
          <PathItem label={t('about.modelsDir')} path={info.modelsDir} />
          <PathItem label={t('about.logFile')} path={info.logFile} />
        </dl>
      ) : (
        <div className={s.loading}>
          <Spinner label={t('about.loading')} />
        </div>
      )}
    </Group>
  );
}

function PathItem({ label, path }: { label: string; path: string }) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <div className={s.item}>
      <dt>{label}</dt>
      <dd className={s.pathCell}>
        <code className={`${s.path} selectable`} title={path}>
          {path}
        </code>
        <IconButton label={copied ? t('common:actions.copied') : t('about.copyPath', { name: label })} onClick={() => void copy()}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconButton>
      </dd>
    </div>
  );
}
