import { describe, expect, it } from 'vitest';
import { hostOf, isLocalAddress, normalizeBaseUrl } from './endpoint';

describe('normalizeBaseUrl', () => {
  it('adds a scheme and strips /v1 and trailing slashes', () => {
    expect(normalizeBaseUrl('127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(normalizeBaseUrl(' http://localhost:1234/v1/ ')).toBe('http://localhost:1234');
    expect(normalizeBaseUrl('https://llm.example.com/api/')).toBe('https://llm.example.com/api');
  });

  it('rejects what is not an http address', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('ftp://host')).toBeNull();
    expect(normalizeBaseUrl('http://')).toBeNull();
  });
});

describe('isLocalAddress', () => {
  it('recognises loopback addresses', () => {
    expect(isLocalAddress('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalAddress('http://localhost:11434')).toBe(true);
    expect(isLocalAddress('http://[::1]:1234')).toBe(true);
  });

  it('treats everything else as remote', () => {
    expect(isLocalAddress('http://192.168.1.20:11434')).toBe(false);
    expect(isLocalAddress('https://api.example.com')).toBe(false);
    expect(isLocalAddress('nonsense')).toBe(false);
  });

  it('names the host', () => {
    expect(hostOf('http://192.168.1.20:11434')).toBe('192.168.1.20:11434');
  });
});
