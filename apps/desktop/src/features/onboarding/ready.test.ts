import { describe, expect, it } from 'vitest';
import type { ServerInfo } from '../../bindings/ServerInfo';
import { currentServer, readyStatus } from './ready';

const info = (status: ServerInfo['status']): ServerInfo => ({
  modelId: 'm',
  quant: 'Q4',
  modelName: 'M',
  runtime: 'vulkan',
  device: null,
  context: 8192,
  slots: 1,
  status,
  toolCalls: 'unknown',
  command: [],
});

describe('currentServer', () => {
  it('ignores the store value that was there before the start request', () => {
    const crashed = info({ state: 'crashed', code: 1, message: 'out of memory' });
    const returned = info({ state: 'starting' });
    expect(currentServer(crashed, crashed, returned)).toBe(returned);
    expect(currentServer(crashed, crashed, null)).toBeNull();
  });

  it('prefers events that arrived after the start request', () => {
    const before = info({ state: 'crashed', code: 1, message: 'x' });
    const loading = info({ state: 'loading' });
    expect(currentServer(loading, before, info({ state: 'starting' }))).toBe(loading);
    expect(currentServer(null, before, null)).toBeNull();
  });
});

describe('readyStatus', () => {
  it('maps server states', () => {
    expect(readyStatus(null, false)).toBe('starting');
    expect(readyStatus(info({ state: 'starting' }), false)).toBe('starting');
    expect(readyStatus(info({ state: 'loading' }), false)).toBe('loading');
    expect(readyStatus(info({ state: 'ready' }), false)).toBe('ready');
    expect(readyStatus(info({ state: 'stopped' }), false)).toBe('failed');
    expect(readyStatus(info({ state: 'crashed', code: null, message: '' }), false)).toBe('failed');
    expect(readyStatus(info({ state: 'ready' }), true)).toBe('failed');
  });
});
