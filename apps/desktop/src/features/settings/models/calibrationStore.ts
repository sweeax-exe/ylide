// "Optimize for this PC": the stored calibration of the selected chat model
// and, while one runs, its live trials.

import { create } from 'zustand';
import type { CalibrationEvent } from '../../../bindings/CalibrationEvent';
import type { CalibrationStatus } from '../../../bindings/CalibrationStatus';
import type { Speeds } from '../../../bindings/Speeds';
import type { Tuning } from '../../../bindings/Tuning';
import { api, onEvent } from '../../../lib/ipc';

interface CalibrationState {
  status: CalibrationStatus | null;
  /** The last event of the calibration started in this window: live trials, then the outcome. */
  event: CalibrationEvent | null;
  refresh: () => Promise<void>;
}

export const useCalibration = create<CalibrationState>((set) => ({
  status: null,
  event: null,
  refresh: async () => set({ status: await api.calibration.get() }),
}));

/** A calibration owns the model server right now. */
export const calibrating = (s: CalibrationState) => s.event?.state === 'running' || !!s.status?.running;

let following = false;

/** Follows the core's calibration events, once per window. */
export function followCalibration() {
  if (following) return;
  following = true;
  void onEvent('runtime://calibration', (event) => {
    useCalibration.setState({ event });
    if (event.state !== 'running') void useCalibration.getState().refresh().catch(() => undefined);
  });
}

/** Seconds for a typical agent step (4,000 prompt tokens, 400 answer tokens), as the core compares trials. */
export function stepSeconds(s: Speeds): number {
  return 4000 / Math.max(s.promptTps, 0.1) + 400 / Math.max(s.genTps, 0.1);
}

/** What a tuning changes, as keys of `calibration.change.*` with their values. */
export function describeTuning(t: Tuning): Array<{ key: string; values?: Record<string, string | number> }> {
  const out: Array<{ key: string; values?: Record<string, string | number> }> = [];
  if (t.kv === 'q8_0') out.push({ key: 'kvQ8' });
  if (t.noMmap === true) out.push({ key: 'noMmap' });
  if (t.noMmap === false) out.push({ key: 'mmap' });
  if (t.ubatch !== null) out.push({ key: 'ubatch', values: { n: t.ubatch } });
  if (t.threads !== null && t.cpuMaskBatch !== null) out.push({ key: 'ccd', values: { n: t.threads } });
  else if (t.cpuMask !== null) out.push({ key: 'pinned' });
  if (t.moeCacheMib !== null) out.push({ key: 'expertCache', values: { mib: t.moeCacheMib } });
  return out;
}
