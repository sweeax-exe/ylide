// Address handling for an external OpenAI-compatible server.

/** Default addresses of the servers people usually already run. */
export const SERVER_PRESETS = {
  ollama: 'http://127.0.0.1:11434',
  lmStudio: 'http://127.0.0.1:1234',
  llamaServer: 'http://127.0.0.1:8080',
} as const;

export type ServerPreset = keyof typeof SERVER_PRESETS;

/**
 * Normalizes what the user typed into the base URL the core expects: with a
 * scheme, without trailing slashes and without `/v1` (the client adds the
 * API path itself). Returns null when it is not an http(s) address.
 */
export function normalizeBaseUrl(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** True when the address points at this computer, so prompts and code stay local. */
export function isLocalAddress(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
