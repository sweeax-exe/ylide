import { Braces, FileText, Folder, FolderRoot } from 'lucide-react';
import { useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Spinner } from '../../components/ui';
import { KeyCap } from './KeyCap';
import { SYMBOL_MIN_QUERY, type PickerItem, type PickerSection } from './mentions';
import s from './MentionPicker.module.css';
import type { MentionSearch } from './useMentionSearch';

const SECTIONS: PickerSection[] = ['files', 'folders', 'symbols'];

export const optionId = (listId: string, index: number) => `${listId}-option-${index}`;

interface Props {
  listId: string;
  query: string;
  search: MentionSearch;
  active: number;
  /** Position inside the composer field, computed from the caret. */
  position: { left: number; bottom: number; width: number };
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
}

function ItemIcon({ item }: { item: PickerItem }) {
  if (item.root) return <FolderRoot size={14} />;
  if (item.section === 'folders') return <Folder size={14} />;
  if (item.section === 'symbols') return <Braces size={14} />;
  return <FileText size={14} />;
}

/**
 * The "@" picker. Focus stays in the composer: the textarea owns the keyboard
 * and points at the active option with aria-activedescendant.
 */
export function MentionPicker({ listId, query, search, active, position, onPick, onHover }: Props) {
  const { t } = useTranslation('chat');
  const { items, loading, error } = search;

  useEffect(() => {
    document.getElementById(optionId(listId, active))?.scrollIntoView({ block: 'nearest' });
  }, [listId, active]);

  const showSymbolHint = query.length < SYMBOL_MIN_QUERY;
  const empty = !loading && !error && items.length === 0;

  return (
    <div className={s.picker} style={{ left: position.left, bottom: position.bottom, width: position.width }}>
      <div className={s.scroll}>
        <div id={listId} role="listbox" aria-label={t('picker.label')} className={s.list}>
          {SECTIONS.map((section) => {
            const entries = items.map((item, index) => ({ item, index })).filter(({ item }) => item.section === section);
            if (!entries.length && !(section === 'symbols' && showSymbolHint && items.length > 0)) return null;
            const headingId = `${listId}-${section}`;
            return (
              <div key={section} role="group" aria-labelledby={headingId} className={s.group}>
                <div id={headingId} className={s.groupTitle} role="presentation">
                  {t(`picker.${section}`)}
                </div>
                {entries.map(({ item, index }) => (
                  <div
                    key={item.key}
                    id={optionId(listId, index)}
                    role="option"
                    aria-selected={index === active}
                    className={s.option}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => index !== active && onHover(index)}
                    onClick={() => onPick(item)}
                  >
                    <span className={s.icon} aria-hidden>
                      <ItemIcon item={item} />
                    </span>
                    <span className={s.title}>{item.title}</span>
                    <span className={s.detail}>{item.root ? t('picker.root') : item.detail}</span>
                    {item.symbolKind && <span className={s.kind}>{t(`symbolKind.${item.symbolKind}`)}</span>}
                  </div>
                ))}
                {section === 'symbols' && showSymbolHint && (
                  <div className={s.hintRow} aria-hidden>
                    {t('picker.symbolsHint')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {empty && <div className={s.message}>{query ? t('picker.empty', { query }) : t('picker.noFiles')}</div>}
        {error && (
          <div className={`${s.message} ${s.error}`} role="alert">
            {error}
          </div>
        )}
        {loading && items.length === 0 && (
          <div className={s.message}>
            <Spinner label={t('picker.searching')} />
          </div>
        )}
      </div>
      <div className={s.footer}>
        <span className={s.keys}>
          <Trans t={t} i18nKey="picker.hint" components={[<KeyCap key="up" />, <KeyCap key="down" />, <KeyCap key="enter" />, <KeyCap key="esc" />]} />
        </span>
        {loading && items.length > 0 && <Spinner label={t('picker.searching')} />}
      </div>
    </div>
  );
}
