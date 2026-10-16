// The shipped default settings, loaded once and shared by every "Reset to default".

import { useEffect, useState } from 'react';
import type { Settings } from '../../../bindings/Settings';
import { reportError } from '../../../lib/errors';
import { api } from '../../../lib/ipc';

let cached: Settings | null = null;
let pending: Promise<Settings> | null = null;

function load(): Promise<Settings> {
  pending ??= api.settings
    .defaults()
    .then((d) => {
      cached = d;
      return d;
    })
    .catch((e: unknown) => {
      pending = null;
      reportError(e);
      throw e;
    });
  return pending;
}

/** Default settings, or `null` while they load (reset buttons stay disabled until then). */
export function useDefaults(): Settings | null {
  const [defaults, setDefaults] = useState<Settings | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    load().then(
      (d) => alive && setDefaults(d),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return defaults;
}
