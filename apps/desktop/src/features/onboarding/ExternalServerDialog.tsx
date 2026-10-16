import { TriangleAlert } from 'lucide-react';
import type { FormEvent } from 'react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { Button, Field, Segmented, TextInput } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { useApp } from '../../state/app';
import { hostOf, isLocalAddress, normalizeBaseUrl, SERVER_PRESETS, type ServerPreset } from './endpoint';
import s from './ExternalServerDialog.module.css';
import type { ModelPath } from './flow';

interface ExternalServerDialogProps {
  open: boolean;
  onClose: () => void;
  onConnect: (path: Extract<ModelPath, { kind: 'external' }>) => void;
}

export function ExternalServerDialog({ open, onClose, onConnect }: ExternalServerDialogProps) {
  const { t } = useTranslation('onboarding');
  const endpoint = useApp((st) => st.settings?.endpoint);
  const updateSettings = useApp((st) => st.updateSettings);
  const formId = useId();
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl || SERVER_PRESETS.ollama);
  const [model, setModel] = useState(endpoint?.model ?? '');
  const [apiKey, setApiKey] = useState(endpoint?.apiKey ?? '');
  const [invalid, setInvalid] = useState(false);
  const [modelMissing, setModelMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeBaseUrl(baseUrl);
  const preset = (Object.keys(SERVER_PRESETS) as ServerPreset[]).find((p) => SERVER_PRESETS[p] === normalized) ?? 'custom';
  const remote = normalized !== null && !isLocalAddress(normalized);
  // Ollama and LM Studio answer with an error when the request names no model.
  const needsModel = preset === 'ollama' || preset === 'lmStudio';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!normalized) {
      setInvalid(true);
      return;
    }
    if (needsModel && !model.trim()) {
      setModelMissing(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const name = model.trim() || null;
      await updateSettings((d) => {
        d.endpoint.enabled = true;
        d.endpoint.baseUrl = normalized;
        d.endpoint.model = name;
        d.endpoint.apiKey = apiKey.trim() || null;
      });
      onConnect({ kind: 'external', baseUrl: normalized, model: name });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('external.title')}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {t('external.connect')}
          </Button>
        </>
      }
    >
      <form id={formId} className={s.form} onSubmit={submit} noValidate>
        <p className={s.intro}>{t('external.body')}</p>
        <Segmented<ServerPreset | 'custom'>
          label={t('external.preset')}
          value={preset}
          options={[
            { value: 'ollama', label: t('external.presetOllama') },
            { value: 'lmStudio', label: t('external.presetLmStudio') },
            { value: 'llamaServer', label: t('external.presetLlamaServer') },
          ]}
          onChange={(p) => {
            if (p !== 'custom') setBaseUrl(SERVER_PRESETS[p]);
            setInvalid(false);
            setModelMissing(false);
          }}
        />
        <Field label={t('external.baseUrl')} hint={invalid ? undefined : t('external.baseUrlHint')}>
          {(id) => (
            <>
              <TextInput
                id={id}
                data-autofocus
                value={baseUrl}
                inputMode="url"
                autoComplete="off"
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? `${id}-error` : undefined}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setInvalid(false);
                }}
              />
              {invalid && (
                <span id={`${id}-error`} className={s.fieldError} role="alert">
                  {t('external.invalidUrl')}
                </span>
              )}
            </>
          )}
        </Field>
        <Field label={t('external.model')} hint={modelMissing ? undefined : t('external.modelHint')}>
          {(id) => (
            <>
              <TextInput
                id={id}
                value={model}
                autoComplete="off"
                placeholder={t('external.modelPlaceholder')}
                aria-invalid={modelMissing || undefined}
                aria-describedby={modelMissing ? `${id}-error` : undefined}
                onChange={(e) => {
                  setModel(e.target.value);
                  setModelMissing(false);
                }}
              />
              {modelMissing && (
                <span id={`${id}-error`} className={s.fieldError} role="alert">
                  {t('external.modelRequired', { server: preset === 'ollama' ? t('external.presetOllama') : t('external.presetLmStudio') })}
                </span>
              )}
            </>
          )}
        </Field>
        <Field label={t('external.apiKey')} hint={t('external.apiKeyHint')}>
          {(id) => <TextInput id={id} type="password" value={apiKey} autoComplete="off" onChange={(e) => setApiKey(e.target.value)} />}
        </Field>
        {remote && normalized && (
          <p className={s.remote} role="note">
            <TriangleAlert size={14} aria-hidden />
            {t('external.remote', { host: hostOf(normalized) })}
          </p>
        )}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
