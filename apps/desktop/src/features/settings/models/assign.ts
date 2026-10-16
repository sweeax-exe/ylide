// What an installed model is used for, and choosing it for that. Shared by the
// Use button of an installed model and the toast shown after an import.

import type { InstalledModel } from '../../../bindings/InstalledModel';
import type { ModelSelection } from '../../../bindings/ModelSelection';
import type { Role } from '../../../bindings/Role';
import { api } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { saveSettings } from '../page/save';

export type Slot = 'chat' | 'autocomplete' | 'embedding';

/** Which assignment fits a model: registry roles (chat first), or chat for imported files. */
export function slotFor(roles: Role[] | undefined): Slot {
  if (!roles || roles.includes('chat') || roles.includes('agent')) return 'chat';
  if (roles.includes('fim')) return 'autocomplete';
  if (roles.includes('embedding')) return 'embedding';
  return 'chat';
}

/** The slot of an installed model, from its registry entry if it has one. */
export function slotOf(model: InstalledModel): Slot {
  return slotFor(useApp.getState().registry?.models.find((r) => r.id === model.modelId)?.roles);
}

/** Chooses the model for its slot; the chat model is also started, in place of an external server. */
export async function assignModel(model: InstalledModel, slot: Slot): Promise<void> {
  const selection: ModelSelection = { modelId: model.modelId, quant: model.quant };
  await saveSettings((d) => {
    d.models[slot] = selection;
    if (slot === 'chat') d.endpoint.enabled = false;
  });
  if (slot === 'chat') await api.server.start(selection);
}
