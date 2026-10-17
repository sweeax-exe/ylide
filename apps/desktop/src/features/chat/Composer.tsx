import { ArrowUp, AtSign, FolderOpen, ScanText, Square } from 'lucide-react';
import { forwardRef, memo, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Mention } from '../../bindings/Mention';
import { AttachImagesButton, ImageStrip, useImageInput, useVision } from '../../components/ImageInput';
import { Button, IconButton, Spinner, TextArea } from '../../components/ui';
import { reportError } from '../../lib/errors';
import { formatNumber, formatTokens } from '../../lib/format';
import { pickFolder } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { useLayout } from '../../state/layout';
import { caretPosition } from './caret';
import s from './Composer.module.css';
import { ContextChip } from './ContextChip';
import { MentionPicker, optionId } from './MentionPicker';
import { applyTrigger, basename, findMentionTrigger, mentionKey, mentionLabel, mentionPath, type PickerItem } from './mentions';
import { openInEditor } from './projectPaths';
import { useChat } from './store';
import { useContextPreview } from './useContextPreview';
import { useMentionSearch } from './useMentionSearch';

export interface ComposerHandle {
  focus(): void;
  /** Fills in an example prompt; an "@" in it marks where a mention goes. */
  fillTemplate(template: string, mentions: Mention[]): void;
}

const PICKER_WIDTH = 360;

function ModelNotice() {
  const { t } = useTranslation('chat');
  const server = useApp((st) => st.server);
  const setMain = useLayout((st) => st.setMain);
  const state = server?.status.state;
  if (state === 'ready') return null;
  const loading = state === 'starting' || state === 'loading';
  const text = loading && server ? t('notice.loading', { model: server.modelName }) : state === 'crashed' ? t('notice.crashed') : t('notice.noModel');
  return (
    <div className={s.notice} role="status">
      <span className={`${s.dot} ${loading ? s.dotLoading : state === 'crashed' ? s.dotCrashed : ''}`} aria-hidden />
      <span className={s.noticeText}>{text}</span>
      {!loading && (
        <Button size="sm" onClick={() => setMain('models')}>
          {t('notice.openModels')}
        </Button>
      )}
    </div>
  );
}

function DraftContext({ mentions }: { mentions: Mention[] }) {
  const { t } = useTranslation('chat');
  const workspace = useApp((st) => st.workspace);
  const settingsBudget = useApp((st) => st.settings?.chat.contextBudgetTokens ?? null);
  const modelContext = useApp((st) => st.server?.context ?? null);
  // The core caps attached context at half of the model's context window.
  const budget = settingsBudget !== null && modelContext ? Math.min(settingsBudget, Math.floor(modelContext / 2)) : settingsBudget;
  const removeMention = useChat((st) => st.removeMention);
  const preview = useContextPreview(mentions, !!workspace);
  if (!mentions.length) return null;

  const total = budget !== null ? t('composer.contextTotal', { tokens: formatNumber(preview.total), budget: formatTokens(budget) }) : t('common:units.tokens', { value: formatNumber(preview.total) });
  const totalTitle = preview.error ?? (preview.truncated ? `${t('composer.contextTotalTitle')} ${t('composer.contextTruncated')}` : t('composer.contextTotalTitle'));
  return (
    <div className={s.attached}>
      <div className={s.chips} role="list" aria-label={t('composer.attached')}>
        {mentions.map((m) => {
          const key = mentionKey(m);
          const item = preview.items.get(key);
          const path = mentionPath(m);
          const line = m.type === 'selection' ? m.startLine : m.type === 'symbol' ? m.line : null;
          return (
            <ContextChip
              key={key}
              chip={{ kind: m.type, label: mentionLabel(m, workspace?.name ?? ''), tokens: item?.tokens ?? null, truncated: item?.truncated ?? false, error: item?.error ?? null }}
              title={path ?? undefined}
              onOpen={path ? () => openInEditor(path, line) : undefined}
              onRemove={() => removeMention(key)}
            />
          );
        })}
      </div>
      <span className={`${s.total} ${preview.truncated ? s.totalWarning : ''}`} title={totalTitle}>
        {preview.loading && preview.items.size === 0 ? <Spinner label={t('composer.measuring')} /> : preview.error ? t('composer.contextUnknown') : total}
      </span>
    </div>
  );
}

function NoProjectHint() {
  const { t } = useTranslation('chat');
  const openWorkspace = useApp((st) => st.openWorkspace);
  const open = async () => {
    const path = await pickFolder();
    if (path) await openWorkspace(path).catch(reportError);
  };
  return (
    <div className={s.noProject}>
      <FolderOpen size={13} aria-hidden className={s.noProjectIcon} />
      <span className={s.noProjectText}>{t('composer.noProject')}</span>
      <Button variant="ghost" size="sm" onClick={() => void open()}>
        {t('common:actions.openFolder')}
      </Button>
    </div>
  );
}

const ComposerField = forwardRef<ComposerHandle, { maxHeight: number }>(function Composer({ maxHeight }, ref) {
  const { t } = useTranslation('chat');
  const draft = useChat((st) => st.draft);
  const mentions = useChat((st) => st.draftMentions);
  const images = useChat((st) => st.draftImages);
  const streaming = useChat((st) => st.activeRequestId !== null);
  const { setDraft, addMentions, send, stop, setDraftImages } = useChat.getState();
  const vision = useVision();
  const imageInput = useImageInput(() => useChat.getState().draftImages, setDraftImages, vision);
  const ready = useApp((st) => st.server?.status.state === 'ready');
  const workspace = useApp((st) => st.workspace);
  // The last project is still being reopened at startup: questions wait for it.
  const reopening = useApp((st) => st.reopening);
  const selection = useEditorBridge((st) => st.selection);

  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [caretSeq, setCaretSeq] = useState(0);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeState, setActiveState] = useState({ query: '', index: 0 });
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const listId = useId();

  const typed = workspace ? findMentionTrigger(draft, caret) : null;
  const trigger = focused && typed && typed.start !== dismissedAt ? typed : null;
  const search = useMentionSearch(trigger ? trigger.query : null, workspace?.name ?? '');
  const active = trigger && activeState.query === trigger.query ? Math.min(activeState.index, Math.max(0, search.items.length - 1)) : 0;
  // Images only go to a model that sees; a question may be only images.
  const imagesBlocked = images.length > 0 && !vision.canSee;
  const canSend = ready && !reopening && !streaming && (draft.trim().length > 0 || images.length > 0) && !imagesBlocked;

  /** Moves the caret after React has rendered the new text. */
  const placeCaret = (position: number) => {
    pendingCaret.current = position;
    setCaretSeq((n) => n + 1);
  };

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    fillTemplate(template, extra) {
      const at = template.indexOf('@');
      const withMentions = !!useApp.getState().workspace;
      let text = template;
      let position = template.length;
      if (at >= 0 && withMentions) position = at + 1;
      else if (at >= 0) {
        text = template.slice(0, at) + template.slice(at + 1);
        position = at;
      }
      useChat.getState().setDraft(text);
      if (extra.length) useChat.getState().addMentions(extra);
      setDismissedAt(null);
      placeCaret(position);
    },
  }));

  // Grow with the text up to `maxHeight`, then scroll.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const borders = el.offsetHeight - el.clientHeight;
    const full = el.scrollHeight + borders;
    el.style.height = `${Math.min(full, maxHeight)}px`;
    el.style.overflowY = full > maxHeight ? 'auto' : 'hidden';
  }, [draft, maxHeight]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    const position = pendingCaret.current;
    if (!el || position === null) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(position, position);
    setCaret(position);
  }, [draft, caretSeq]);

  // Anchor the picker above the "@" that opened it.
  const triggerStart = trigger?.start ?? null;
  useLayoutEffect(() => {
    const el = inputRef.current;
    const field = fieldRef.current;
    if (triggerStart === null || !el || !field) {
      setAnchor(null);
      return;
    }
    const pos = caretPosition(el, triggerStart);
    const width = Math.min(PICKER_WIDTH, field.clientWidth);
    const left = Math.max(0, Math.min(pos.left - 10, field.clientWidth - width));
    const top = el.offsetTop + pos.top - el.scrollTop;
    setAnchor({ left, width, bottom: field.clientHeight - top + 4 });
  }, [triggerStart]);

  // Once the "@" is gone, a new one may open the picker again.
  const typing = typed !== null;
  useEffect(() => {
    if (!typing && dismissedAt !== null) setDismissedAt(null);
  }, [typing, dismissedAt]);

  const submit = () => {
    if (!canSend) return;
    send();
    inputRef.current?.focus();
  };

  const pick = (item: PickerItem) => {
    if (!trigger) return;
    const next = applyTrigger(draft, trigger, caret, item.insert);
    setDraft(next.text);
    if (item.mention) addMentions([item.mention]);
    placeCaret(next.caret);
  };

  const insertAt = () => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const before = draft.slice(0, start);
    const spacer = before && !/\s$/.test(before) ? ' ' : '';
    setDraft(`${before}${spacer}@${draft.slice(end)}`);
    setDismissedAt(null);
    placeCaret(before.length + spacer.length + 1);
  };

  const attachSelection = () => {
    if (!selection) return;
    addMentions([{ type: 'selection', path: selection.path, startLine: selection.startLine, endLine: selection.endLine, text: selection.text }]);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (trigger) {
      const count = search.items.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActiveState({ query: trigger.query, index: (active + step + count) % count });
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && count) {
        e.preventDefault();
        pick(search.items[active]);
        return;
      }
      // Results for what was just typed are still loading: do not send "@que" by accident.
      if (e.key === 'Enter' && !e.shiftKey && search.loading) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(trigger.start);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      inputRef.current?.blur();
    }
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    setCaret(e.target.selectionStart);
  };

  const selectionLabel = selection ? `${basename(selection.path)}:${selection.startLine}-${selection.endLine}` : '';

  return (
    <div
      className={`${s.composer} ${imageInput.dragging ? s.dropping : ''}`}
      onDragOver={imageInput.onDragOver}
      onDragLeave={imageInput.onDragLeave}
      onDrop={imageInput.onDrop}
    >
      <ModelNotice />
      <DraftContext mentions={mentions} />
      <ImageStrip images={images} onRemove={imageInput.remove} />
      {imagesBlocked && (
        <p className={s.imageWarning} role="status">
          {vision.hint}
        </p>
      )}
      {!workspace && !reopening && <NoProjectHint />}
      <div ref={fieldRef} className={s.field}>
        <TextArea
          ref={inputRef}
          className={s.input}
          rows={2}
          spellCheck={false}
          value={draft}
          aria-label={t('composer.label')}
          placeholder={workspace ? t('composer.placeholderMentions') : t('composer.placeholder')}
          aria-autocomplete={workspace ? 'list' : undefined}
          aria-controls={trigger ? listId : undefined}
          aria-activedescendant={trigger && search.items.length ? optionId(listId, active) : undefined}
          onChange={onChange}
          onPaste={imageInput.onPaste}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {trigger && anchor && (
          <MentionPicker
            listId={listId}
            query={trigger.query}
            search={search}
            active={active}
            position={anchor}
            onPick={pick}
            onHover={(index) => setActiveState({ query: trigger.query, index })}
          />
        )}
      </div>
      <div className={s.toolbar}>
        <IconButton label={t('composer.addContext')} onClick={insertAt} disabled={!workspace}>
          <AtSign size={15} />
        </IconButton>
        <AttachImagesButton vision={vision} onPick={imageInput.pick} busy={imageInput.busy} />
        <Button
          variant="ghost"
          size="sm"
          icon={<ScanText size={14} />}
          onClick={attachSelection}
          disabled={!workspace || !selection}
          title={selection ? t('composer.attachSelectionTitle', { label: selectionLabel }) : t('composer.noSelection')}
        >
          {t('composer.attachSelection')}
        </Button>
        <span className={s.grow} />
        {streaming ? (
          <Button
            key="stop"
            size="sm"
            icon={<Square size={10} fill="currentColor" />}
            onClick={() => {
              stop();
              inputRef.current?.focus();
            }}
          >
            {t('common:actions.stop')}
          </Button>
        ) : (
          <Button key="send" variant="primary" size="sm" icon={<ArrowUp size={14} />} onClick={submit} disabled={!canSend}>
            {t('common:actions.send')}
          </Button>
        )}
      </div>
    </div>
  );
});

/** Memoised so that panel state (dialog, streaming flag) does not re-render the field. */
export const Composer = memo(ComposerField);
