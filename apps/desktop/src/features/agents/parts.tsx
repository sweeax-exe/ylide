// Small building blocks shared by the agent views.

import { FileMinus, FilePen, FilePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChangeKind } from '../../bindings/ChangeKind';
import { openInEditor } from './hooks';
import s from './parts.module.css';
import type { ChangedFile } from './run';
import { splitCode } from './text';

/** Text with `backtick` spans rendered as inline code. */
export function CodeText({ text }: { text: string }) {
  return (
    <>
      {splitCode(text).map((part, i) =>
        part.code ? (
          <code key={i} className={s.code}>
            {part.text}
          </code>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function FileKindIcon({ kind, size = 14 }: { kind: ChangeKind; size?: number }) {
  if (kind === 'created') return <FilePlus size={size} className={s.created} aria-hidden />;
  if (kind === 'deleted') return <FileMinus size={size} className={s.deleted} aria-hidden />;
  return <FilePen size={size} className={s.modified} aria-hidden />;
}

/** Files changed by a run; existing files open in the editor. */
export function ChangedFilesList({ files }: { files: ChangedFile[] }) {
  const { t } = useTranslation('agents');
  if (!files.length) return <p className={s.muted}>{t('run.noChanges')}</p>;
  return (
    <ul className={s.files}>
      {files.map((f) => (
        <li key={f.path} className={s.file}>
          <FileKindIcon kind={f.kind} />
          {f.kind === 'deleted' ? (
            <span className={s.path} title={f.path}>
              {f.path}
            </span>
          ) : (
            <button type="button" className={s.pathButton} onClick={() => openInEditor(f.path)} title={t('feed.openPath', { path: f.path })}>
              {f.path}
            </button>
          )}
          <span className={s.kind}>{t(`changeKind.${f.kind}`)}</span>
        </li>
      ))}
    </ul>
  );
}
