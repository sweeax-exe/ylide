// Agent roles: system prompt, tools and limits of each role, plus custom roles.

import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RoleDefinition } from '../../../bindings/RoleDefinition';
import type { ToolRisk } from '../../../bindings/ToolRisk';
import { Badge, Button, Field, Select, TextInput } from '../../../components/ui';
import { createRole, roleIdProblem, sameRole, slugify, toggleTool, TOOLS, uniqueId } from '../logic/roles';
import { Group, GroupResetButton, NumberSetting, Row, TextSetting } from '../page/controls';
import { PromptEditor } from '../page/PromptEditor';
import type { Saver } from '../page/save';
import { SettingsDialog } from '../page/SettingsDialog';
import s from './RolesEditor.module.css';

const RISKS: ToolRisk[] = ['read', 'write', 'delete', 'execute', 'communicate'];

export function RolesEditor({ roles, defaults }: { roles: RoleDefinition[]; defaults: RoleDefinition[] | undefined }) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  // The deleted role's form, and the button that opened its dialog, are gone; keep focus in this group.
  const focusGroup = () => requestAnimationFrame(() => addButton.current?.focus());

  return (
    <Group
      title={t('roles.title')}
      description={t('roles.description')}
      flush
      actions={
        <Button ref={addButton} size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          {t('roles.add')}
        </Button>
      }
    >
      {(save) => (
        <>
          <ul className={s.list}>
            {roles.map((role) => (
              <RoleItem
                key={role.id}
                role={role}
                defaultRole={defaults?.find((d) => d.id === role.id)}
                defaultsLoaded={defaults !== undefined}
                expanded={open === role.id}
                onToggle={() => setOpen((o) => (o === role.id ? null : role.id))}
                onDeleted={focusGroup}
                save={save}
              />
            ))}
          </ul>
          <AddRoleDialog
            open={adding}
            roles={roles}
            onClose={() => setAdding(false)}
            onCreate={async (role) => {
              const ok = await save((d) => {
                d.agent.roles.push(role);
              });
              if (ok) {
                setAdding(false);
                setOpen(role.id);
              }
            }}
          />
        </>
      )}
    </Group>
  );
}

function RoleItem({
  role,
  defaultRole,
  defaultsLoaded,
  expanded,
  onToggle,
  onDeleted,
  save,
}: {
  role: RoleDefinition;
  defaultRole: RoleDefinition | undefined;
  defaultsLoaded: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDeleted: () => void;
  save: Saver;
}) {
  const { t } = useTranslation('settings');
  const bodyId = useId();
  const changed = role.builtin && defaultRole !== undefined && !sameRole(role, defaultRole);

  return (
    <li className={s.item}>
      <button type="button" className={s.head} aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} onClick={onToggle}>
        <ChevronRight size={14} className={s.chevron} aria-hidden />
        <span className={s.headMain}>
          <span className={s.headTitle}>
            <span className={s.name}>{role.name}</span>
            <code className={s.id}>{role.id}</code>
            {role.builtin ? <Badge>{t('roles.builtin')}</Badge> : <Badge tone="accent">{t('roles.custom')}</Badge>}
            {changed && <Badge tone="accent">{t('prompt.isChanged')}</Badge>}
          </span>
          <span className={s.desc}>{role.description || t('roles.noDescription')}</span>
        </span>
        <span className={s.meta}>
          <span className="tabular">{t('roles.toolCount', { count: role.tools.length })}</span>
          <span className="tabular">{t('roles.stepCount', { count: role.maxSteps })}</span>
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className={s.body}>
          <RoleForm role={role} defaultRole={defaultRole} defaultsLoaded={defaultsLoaded} save={save} onDeleted={onDeleted} />
        </div>
      )}
    </li>
  );
}

function RoleForm({
  role,
  defaultRole,
  defaultsLoaded,
  save,
  onDeleted,
}: {
  role: RoleDefinition;
  defaultRole: RoleDefinition | undefined;
  defaultsLoaded: boolean;
  save: Saver;
  onDeleted: () => void;
}) {
  const { t } = useTranslation('settings');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = (change: (r: RoleDefinition) => void) =>
    save((d) => {
      const r = d.agent.roles.find((x) => x.id === role.id);
      if (r) change(r);
    });
  const promptDefault = role.builtin ? (defaultsLoaded ? (defaultRole?.systemPrompt ?? null) : undefined) : null;

  return (
    <>
      <Row label={t('roles.name')}>
        {({ id }) => (
          <TextSetting
            id={id}
            value={role.name}
            validate={(v) => (v.trim() ? null : t('validation.required'))}
            onCommit={(v) =>
              update((r) => {
                r.name = v.trim();
              })
            }
          />
        )}
      </Row>
      <Row label={t('roles.descriptionLabel')} hint={t('roles.descriptionHint')}>
        {({ id, describedBy }) => (
          <TextSetting
            id={id}
            describedBy={describedBy}
            value={role.description}
            onCommit={(v) =>
              update((r) => {
                r.description = v.trim();
              })
            }
          />
        )}
      </Row>
      <PromptEditor
        label={t('roles.systemPrompt')}
        hint={t('roles.systemPromptHint')}
        value={role.systemPrompt}
        defaultValue={promptDefault}
        rows={14}
        onSave={(v) =>
          update((r) => {
            r.systemPrompt = v;
          })
        }
      />
      <ToolPicker
        tools={role.tools}
        onToggle={(name, on) =>
          void update((r) => {
            r.tools = toggleTool(r.tools, name, on);
          })
        }
      />
      <Row label={t('roles.temperature')} hint={t('roles.temperatureHint')}>
        {({ id, describedBy }) => (
          <NumberSetting
            id={id}
            describedBy={describedBy}
            value={role.temperature}
            rule={{ min: 0, max: 2, optional: true }}
            placeholder={t('roles.modelDefault')}
            onCommit={(v) =>
              update((r) => {
                r.temperature = v;
              })
            }
          />
        )}
      </Row>
      <Row label={t('roles.maxSteps')} hint={t('roles.maxStepsHint')}>
        {({ id, describedBy }) => (
          <NumberSetting
            id={id}
            describedBy={describedBy}
            value={role.maxSteps}
            rule={{ min: 1, max: 1000, integer: true }}
            unit={t('units.steps')}
            onCommit={(v) =>
              v !== null &&
              update((r) => {
                r.maxSteps = v;
              })
            }
          />
        )}
      </Row>
      <div className={s.foot}>
        {role.builtin ? (
          <>
            <span className={s.footHint}>{t('roles.builtinHint')}</span>
            <GroupResetButton
              variant="secondary"
              disabled={!defaultRole || sameRole(role, defaultRole)}
              onReset={() =>
                defaultRole &&
                update((r) => {
                  Object.assign(r, structuredClone(defaultRole));
                })
              }
            >
              {t('roles.reset')}
            </GroupResetButton>
          </>
        ) : (
          <>
            <span className={s.footHint}>{t('roles.customHint')}</span>
            <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)}>
              {t('roles.delete')}
            </Button>
          </>
        )}
      </div>
      <SettingsDialog
        open={confirmDelete}
        title={t('roles.deleteTitle', { name: role.name })}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} data-autofocus>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const ok = await save((d) => {
                  d.agent.roles = d.agent.roles.filter((r) => r.id !== role.id);
                });
                if (ok) {
                  setConfirmDelete(false);
                  onDeleted();
                }
              }}
            >
              {t('roles.delete')}
            </Button>
          </>
        }
      >
        <p className={s.dialogText}>{t('roles.deleteBody', { id: role.id })}</p>
      </SettingsDialog>
    </>
  );
}

function ToolPicker({ tools, onToggle }: { tools: string[]; onToggle: (name: string, on: boolean) => void }) {
  const { t } = useTranslation('settings');
  const unknown = tools.filter((n) => !TOOLS.some((x) => x.name === n));
  return (
    <div className={s.tools}>
      <div className={s.toolsHead}>
        <span className={s.toolsLabel}>{t('roles.tools')}</span>
        <span className={s.toolsHint}>{t('roles.toolsHint')}</span>
      </div>
      <div className={s.riskGrid}>
        {RISKS.map((risk) => (
          <fieldset key={risk} className={s.risk}>
            <legend className={s.riskLegend}>{t(`roles.risk.${risk}`)}</legend>
            {TOOLS.filter((x) => x.risk === risk).map((tool) => (
              <label key={tool.name} className={s.tool}>
                <input type="checkbox" checked={tools.includes(tool.name)} onChange={(e) => onToggle(tool.name, e.target.checked)} />
                <code>{tool.name}</code>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      {unknown.length > 0 && <div className={s.toolsHint}>{t('roles.unknownTools', { tools: unknown.join(', ') })}</div>}
    </div>
  );
}

function AddRoleDialog({ open, roles, onClose, onCreate }: { open: boolean; roles: RoleDefinition[]; onClose: () => void; onCreate: (role: RoleDefinition) => Promise<void> }) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const taken = roles.map((r) => r.id);
  const effectiveId = idEdited ? id : uniqueId(slugify(name), taken);
  const problem = roleIdProblem(effectiveId, taken);
  const canCreate = name.trim().length > 0 && problem === null;

  const reset = () => {
    setName('');
    setId('');
    setIdEdited(false);
    setDescription('');
    setFrom('');
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = async () => {
    if (!canCreate || busy) return;
    setBusy(true);
    try {
      await onCreate(createRole({ id: effectiveId, name, description }, roles.find((r) => r.id === from)));
      reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsDialog
      open={open}
      title={t('roles.addTitle')}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" disabled={!canCreate} loading={busy} onClick={() => void submit()}>
            {t('roles.create')}
          </Button>
        </>
      }
    >
      <form
        className={s.dialogForm}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t('roles.name')}>{(fid) => <TextInput id={fid} data-autofocus value={name} placeholder={t('roles.namePlaceholder')} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t('roles.id')} hint={problem && (idEdited || name) ? t(`roles.idProblem.${problem}`) : t('roles.idHint')}>
          {(fid) => (
            <TextInput
              id={fid}
              className={s.mono}
              value={effectiveId}
              aria-invalid={problem && (idEdited || name) ? true : undefined}
              onChange={(e) => {
                setIdEdited(true);
                setId(e.target.value.trim());
              }}
            />
          )}
        </Field>
        <Field label={t('roles.descriptionLabel')} hint={t('roles.descriptionHint')}>
          {(fid) => <TextInput id={fid} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label={t('roles.startFrom')} hint={t('roles.startFromHint')}>
          {(fid) => (
            <Select id={fid} value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">{t('roles.startBlank')}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {t('roles.startCopy', { name: r.name })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {/* Lets Enter in a field submit the form. */}
        <button type="submit" hidden />
      </form>
    </SettingsDialog>
  );
}
