import { useTranslation } from 'react-i18next';
import type { EditorSettings } from '../../../bindings/EditorSettings';
import type { Settings } from '../../../bindings/Settings';
import { Group, GroupResetButton, NumberSetting, Row, SwitchRow, TextSetting } from '../page/controls';
import { useDefaults } from '../page/defaults';
import { SETTINGS_SECTIONS } from '../page/ids';
import { PageSection } from '../page/Page';
import s from './EditorSection.module.css';

const sameEditor = (a: EditorSettings, b: EditorSettings) => (Object.keys(a) as Array<keyof EditorSettings>).every((k) => a[k] === b[k]);

export function EditorSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation('settings');
  const defaults = useDefaults();
  const editor = settings.editor;
  const isDefault = defaults ? sameEditor(editor, defaults.editor) : true;

  return (
    <PageSection id={SETTINGS_SECTIONS.editor} title={t('editor.title')} description={t('editor.description')}>
      <Group
        title={t('editor.textTitle')}
        actions={(save) => (
          <GroupResetButton
            disabled={!defaults || isDefault}
            onReset={() =>
              defaults &&
              save((d) => {
                d.editor = structuredClone(defaults.editor);
              })
            }
          >
            {t('common:actions.reset')}
          </GroupResetButton>
        )}
      >
        {(save) => {
          const set = <K extends keyof EditorSettings>(key: K) => (v: EditorSettings[K]) =>
            save((d) => {
              d.editor[key] = v;
            });
          return (
            <>
              <Row label={t('editor.fontFamily.label')} hint={t('editor.fontFamily.hint')}>
                {({ id, describedBy }) => (
                  <TextSetting id={id} describedBy={describedBy} mono value={editor.fontFamily} onCommit={set('fontFamily')} validate={(v) => (v.trim() ? null : t('validation.required'))} />
                )}
              </Row>
              <Row label={t('editor.fontSize.label')}>
                {({ id }) => <NumberSetting id={id} value={editor.fontSize} rule={{ min: 8, max: 32, integer: true }} unit={t('units.px')} onCommit={(v) => v !== null && set('fontSize')(v)} />}
              </Row>
              <Row label={t('editor.lineHeight.label')} hint={t('editor.lineHeight.hint')}>
                {({ id, describedBy }) => <NumberSetting id={id} describedBy={describedBy} value={editor.lineHeight} rule={{ min: 1, max: 3 }} unit={t('units.times')} onCommit={(v) => v !== null && set('lineHeight')(v)} />}
              </Row>
              <Row label={t('editor.tabSize.label')} hint={t('editor.tabSize.hint')}>
                {({ id, describedBy }) => <NumberSetting id={id} describedBy={describedBy} value={editor.tabSize} rule={{ min: 1, max: 16, integer: true }} unit={t('units.spaces')} onCommit={(v) => v !== null && set('tabSize')(v)} />}
              </Row>
              <SwitchRow label={t('editor.wordWrap.label')} hint={t('editor.wordWrap.hint')} checked={editor.wordWrap} onChange={set('wordWrap')} />
              <SwitchRow label={t('editor.minimap.label')} hint={t('editor.minimap.hint')} checked={editor.minimap} onChange={set('minimap')} />
              <div className={s.previewRow}>
                <span className={s.previewLabel} id="settings-editor-preview">
                  {t('editor.preview')}
                </span>
                <EditorPreview editor={editor} />
              </div>
            </>
          );
        }}
      </Group>
    </PageSection>
  );
}

/** A few lines of code rendered with the chosen font, size, spacing, tabs and wrapping. */
function EditorPreview({ editor }: { editor: EditorSettings }) {
  return (
    <pre
      className={s.preview}
      aria-labelledby="settings-editor-preview"
      style={{
        fontFamily: editor.fontFamily,
        fontSize: `${editor.fontSize}px`,
        lineHeight: editor.lineHeight,
        tabSize: editor.tabSize,
        whiteSpace: editor.wordWrap ? 'pre-wrap' : 'pre',
      }}
    >
      <span className={s.kw}>export function</span> <span className={s.fn}>total</span>(items: <span className={s.ty}>Item</span>[]): <span className={s.ty}>number</span> {'{'}
      {'\n\t'}
      <span className={s.kw}>return</span> items.<span className={s.fn}>reduce</span>((sum, item) =&gt; sum + item.price * item.quantity, <span className={s.num}>0</span>);
      {'\n}'}
    </pre>
  );
}
