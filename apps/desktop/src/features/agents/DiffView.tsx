import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseUnifiedDiff, type DiffFile } from './diff';
import s from './DiffView.module.css';

/** Lines rendered before "Show all" appears; keeps huge diffs cheap. */
const LINE_LIMIT = 400;

const SIGN = { add: '+', del: '-', context: ' ', hunk: '', note: '' } as const;

interface DiffViewProps {
  diff: string;
  /** Pre-parsed files, when the caller already has them. */
  files?: DiffFile[];
  /** Shows the file path above each file (for multi-file diffs). */
  showPaths?: boolean;
  maxHeight?: number;
  /** Receives the dialog's initial focus (approval dialogs). */
  autoFocus?: boolean;
}

/** Unified diff: +/- lines on tinted rows, monospace, no wrapping, scrolls sideways. */
export function DiffView({ diff, files: parsed, showPaths = false, maxHeight = 320, autoFocus = false }: DiffViewProps) {
  const { t } = useTranslation('agents');
  const files = useMemo(() => parsed ?? parseUnifiedDiff(diff), [parsed, diff]);
  const [all, setAll] = useState(false);
  const total = files.reduce((n, f) => n + f.lines.length, 0);
  const path = files[0]?.newPath ?? files[0]?.oldPath ?? '';

  if (!total) return <p className={s.empty}>{t('diff.empty')}</p>;

  let budget = all ? Infinity : LINE_LIMIT;
  return (
    <div className={s.wrap}>
      <div
        className={s.scroller}
        style={{ maxHeight }}
        tabIndex={0}
        role="region"
        aria-label={t('diff.label', { path })}
        data-autofocus={autoFocus ? '' : undefined}
      >
        <div className={s.inner}>
          {files.map((file, fi) => {
            if (budget <= 0) return null;
            const lines = file.lines.slice(0, budget);
            budget -= lines.length;
            const name = file.newPath ?? file.oldPath;
            return (
              <div key={fi} className={s.file}>
                {showPaths && name && <div className={s.fileHeader}>{name}</div>}
                {lines.map((line, li) =>
                  line.kind === 'hunk' ? (
                    <div key={li} className={`${s.line} ${s.hunk}`}>
                      <span className={s.gutter} aria-hidden />
                      <span className={s.text}>{line.text}</span>
                    </div>
                  ) : (
                    <div key={li} className={`${s.line} ${s[line.kind] ?? ''}`}>
                      <span className={s.gutter} aria-hidden>
                        <span className={s.no}>{line.oldNo ?? ''}</span>
                        <span className={s.no}>{line.newNo ?? ''}</span>
                      </span>
                      <span className={s.sign}>{SIGN[line.kind]}</span>
                      <span className={s.text}>{line.text}</span>
                    </div>
                  ),
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!all && total > LINE_LIMIT && (
        <button type="button" className={s.more} onClick={() => setAll(true)}>
          {t('diff.showAll', { total })}
        </button>
      )}
    </div>
  );
}
