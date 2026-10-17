// Under a finished run: what the agents should do next. "Continue" starts a
// run whose orchestrator is told what this one did (goal, tasks, changed
// files) and that first does the tasks it left open; "New run" in the header
// starts without that. Images go with the next step like with a new request.

import { StepForward, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AttachImagesButton, ImageStrip, useImageInput, useVision } from '../../components/ImageInput';
import { Button, TextArea } from '../../components/ui';
import { useApp } from '../../state/app';
import s from './NextStep.module.css';
import { continueBlock, openTaskCount, type RunData } from './run';
import { useAgentRun } from './store';

export function NextStep({ run }: { run: RunData }) {
  const { t } = useTranslation('agents');
  const id = useId();
  const hintId = useId();
  const text = useAgentRun((st) => st.followUp);
  const setText = useAgentRun((st) => st.setFollowUp);
  const continueRun = useAgentRun((st) => st.continueRun);
  const images = useAgentRun((st) => st.followUpImages);
  const setImages = useAgentRun((st) => st.setFollowUpImages);
  const vision = useVision();
  const imageInput = useImageInput(() => useAgentRun.getState().followUpImages, setImages, vision);
  const modelReady = useApp((st) => st.server?.status.state === 'ready');
  const project = useApp((st) => st.workspace?.root ?? null);
  const block = continueBlock(run, modelReady, project);
  // Images only go to a model that sees; the next step itself is text.
  const imagesBlocked = images.length > 0 && !vision.canSee;
  const canContinue = !block && text.trim().length > 0 && !imagesBlocked;
  const open = openTaskCount(run);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focus = useAgentRun((st) => st.focusFollowUp);
  const focused = useAgentRun((st) => st.followUpFocused);

  useEffect(() => {
    if (!focus) return;
    inputRef.current?.focus();
    focused();
  }, [focus, focused]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canContinue) void continueRun(text);
  };

  const blockText = block === 'otherProject' ? t('next.otherProject') : block === 'noProject' ? t('idle.noProject') : block === 'noModel' ? t('idle.noModel') : null;

  return (
    <form
      className={`${s.next} ${imageInput.dragging ? s.dropping : ''}`}
      onSubmit={submit}
      onDragOver={imageInput.onDragOver}
      onDragLeave={imageInput.onDragLeave}
      onDrop={imageInput.onDrop}
    >
      <label className={s.label} htmlFor={id}>
        {t('next.label')}
      </label>
      <TextArea
        ref={inputRef}
        id={id}
        className={s.input}
        rows={2}
        value={text}
        placeholder={t('next.placeholder')}
        aria-describedby={hintId}
        onChange={(e) => setText(e.target.value)}
        onPaste={imageInput.onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
        }}
        spellCheck
      />
      <ImageStrip images={images} onRemove={imageInput.remove} size="sm" />
      <div className={s.row}>
        <AttachImagesButton vision={vision} onPick={imageInput.pick} busy={imageInput.busy} />
        <p id={hintId} className={`${s.hint} ${blockText ? s.blocked : ''}`}>
          {blockText && <TriangleAlert size={13} aria-hidden />}
          {blockText ?? (imagesBlocked ? vision.hint : open > 0 ? t('next.hintOpen', { count: open }) : t('next.hint'))}
        </p>
        <Button type="submit" variant="primary" size="sm" icon={<StepForward size={13} />} disabled={!canContinue}>
          {t('next.continue')}
        </Button>
      </div>
    </form>
  );
}
