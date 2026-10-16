// Which server state the ready step shows. Pure, so the rules for stale store
// values can be tested without a DOM.

import type { ServerInfo } from '../../bindings/ServerInfo';

export type ReadyStatus = 'starting' | 'loading' | 'ready' | 'failed';

/**
 * The server the step should describe. The store keeps the last state it was
 * told about, which may belong to an earlier attempt (a crashed start before a
 * retry). Only a store value that arrived after the start request (a new
 * object) counts; until then the answer of the start call is used.
 */
export function currentServer(store: ServerInfo | null, staleAtStart: ServerInfo | null | undefined, returned: ServerInfo | null): ServerInfo | null {
  const fresh = store !== null && store !== staleAtStart ? store : null;
  return fresh ?? returned;
}

export function readyStatus(server: ServerInfo | null, failed: boolean): ReadyStatus {
  if (failed) return 'failed';
  switch (server?.status.state) {
    case 'ready':
      return 'ready';
    case 'loading':
      return 'loading';
    case 'crashed':
    case 'stopped':
      return 'failed';
    default:
      return 'starting';
  }
}
