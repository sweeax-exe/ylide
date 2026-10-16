// The shared Dialog re-runs its focus setup whenever `onClose` changes, which
// moves focus back to the first field after every keystroke when the caller
// passes an inline function. This wrapper hands it one stable callback.

import type { ComponentProps } from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { Dialog } from '../../../components/Dialog';

export function SettingsDialog({ onClose, ...rest }: ComponentProps<typeof Dialog>) {
  const latest = useRef(onClose);
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  const close = useCallback(() => latest.current(), []);
  return <Dialog {...rest} onClose={close} />;
}
