// An external OpenAI-compatible server instead of the built-in runtime.

import { Eye, EyeOff, PlugZap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomEndpoint } from '../../../bindings/CustomEndpoint';
import { Badge, Button, IconButton } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { formatTokens } from '../../../lib/format';
import { api } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { isHttpUrl, optionalText } from '../logic/forms';
import { Group, NumberSetting, Row, SwitchRow, TextSetting } from '../page/controls';
import { keepFocusInSection } from '../page/focus';
import s from './EndpointForm.module.css';

/** Context the core assumes when none is set (`use_external` in src-tauri/src/runtime.rs). */
const DEFAULT_EXTERNAL_CONTEXT = 32_768;

export function EndpointForm({ endpoint }: { endpoint: CustomEndpoint }) {
  const { t } = useTranslation('settings');
  const server = useApp((st) => st.server);
  const [showKey, setShowKey] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const external = server?.runtime === 'external' ? server : null;

  const validateUrl = (v: string) => (v.trim() === '' || isHttpUrl(v) ? null : t('validation.url'));

  return (
    <Group
      title={t('endpoint.title')}
      description={t('endpoint.description')}
      actions={
        external && (
          <Badge tone={external.status.state === 'ready' ? 'success' : external.status.state === 'crashed' ? 'danger' : 'neutral'}>
            {external.status.state === 'ready' ? t('endpoint.connected') : external.status.state === 'crashed' ? t('endpoint.unreachable') : t('endpoint.connecting')}
          </Badge>
        )
      }
    >
      {(save) => {
        const connect = async (from: HTMLElement) => {
          const restoreFocus = keepFocusInSection(from);
          // Commit a field that still has focus; saves run in order, so the
          // change below sees the committed URL.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          setProblem(null);
          setConnecting(true);
          try {
            const ok = await save((d) => {
              if (isHttpUrl(d.endpoint.baseUrl)) d.endpoint.enabled = true;
            });
            const saved = useApp.getState().settings?.endpoint;
            if (!ok || !saved) return;
            if (!saved.enabled || !isHttpUrl(saved.baseUrl)) {
              setProblem(t('endpoint.needUrl'));
              return;
            }
            await api.server.start();
          } catch (e) {
            reportError(e);
          } finally {
            setConnecting(false);
            restoreFocus();
          }
        };
        const toggle = async (on: boolean) => {
          setProblem(null);
          // Checked inside the change so a URL committed a moment ago counts.
          const ok = await save((d) => {
            d.endpoint.enabled = on && isHttpUrl(d.endpoint.baseUrl);
          });
          if (!ok) return;
          if (on && !useApp.getState().settings?.endpoint.enabled) setProblem(t('endpoint.needUrl'));
          // Switching off ends the connection; the local model can then be started.
          if (!on && useApp.getState().server?.runtime === 'external') await api.server.stop().catch(reportError);
        };
        return (
          <>
            <SwitchRow
              label={t('endpoint.enabled.label')}
              hint={t('endpoint.enabled.hint')}
              checked={endpoint.enabled}
              onChange={(v) => void toggle(v)}
            />
            <Row label={t('endpoint.baseUrl.label')} hint={t('endpoint.baseUrl.hint')}>
              {({ id, describedBy }) => (
                <TextSetting
                  id={id}
                  describedBy={describedBy}
                  mono
                  value={endpoint.baseUrl}
                  placeholder="http://127.0.0.1:11434/v1"
                  validate={validateUrl}
                  onCommit={(v) =>
                    save((d) => {
                      d.endpoint.baseUrl = v.trim();
                    })
                  }
                />
              )}
            </Row>
            <Row label={t('endpoint.apiKey.label')} hint={t('endpoint.apiKey.hint')}>
              {({ id, describedBy }) => (
                <div className={s.keyLine}>
                  <TextSetting
                    id={id}
                    describedBy={describedBy}
                    mono
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    value={endpoint.apiKey ?? ''}
                    placeholder={t('endpoint.apiKey.placeholder')}
                    onCommit={(v) =>
                      save((d) => {
                        d.endpoint.apiKey = optionalText(v);
                      })
                    }
                  />
                  <IconButton label={showKey ? t('endpoint.apiKey.hide') : t('endpoint.apiKey.show')} pressed={showKey} onClick={() => setShowKey((v) => !v)}>
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </IconButton>
                </div>
              )}
            </Row>
            <Row label={t('endpoint.model.label')} hint={t('endpoint.model.hint')}>
              {({ id, describedBy }) => (
                <TextSetting
                  id={id}
                  describedBy={describedBy}
                  mono
                  value={endpoint.model ?? ''}
                  placeholder={t('endpoint.model.placeholder')}
                  onCommit={(v) =>
                    save((d) => {
                      d.endpoint.model = optionalText(v);
                    })
                  }
                />
              )}
            </Row>
            <Row label={t('endpoint.context.label')} hint={t('endpoint.context.hint', { tokens: formatTokens(DEFAULT_EXTERNAL_CONTEXT) })}>
              {({ id, describedBy }) => (
                <NumberSetting
                  id={id}
                  describedBy={describedBy}
                  value={endpoint.context}
                  rule={{ min: 512, max: 10_000_000, integer: true, optional: true }}
                  unit={t('units.tokens')}
                  placeholder={formatTokens(DEFAULT_EXTERNAL_CONTEXT)}
                  onCommit={(v) =>
                    save((d) => {
                      d.endpoint.context = v;
                    })
                  }
                />
              )}
            </Row>
            <div className={s.foot}>
              <span className={`${s.footHint} ${problem || external?.status.state === 'crashed' ? s.footProblem : ''}`} role="status">
                {problem ?? (external?.status.state === 'crashed' ? external.status.message : external ? t('endpoint.activeHint', { model: external.modelName }) : t('endpoint.connectHint'))}
              </span>
              <Button variant="primary" icon={<PlugZap size={14} />} loading={connecting} onClick={(e) => void connect(e.currentTarget)}>
                {t('endpoint.connect')}
              </Button>
            </div>
          </>
        );
      }}
    </Group>
  );
}
