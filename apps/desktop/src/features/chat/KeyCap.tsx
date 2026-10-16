import type { ReactNode } from 'react';
import { Kbd } from '../../components/ui';

/** Kbd with optional children, so <Trans> can fill in the key name from the translation. */
export function KeyCap({ children }: { children?: ReactNode }) {
  return <Kbd>{children}</Kbd>;
}
