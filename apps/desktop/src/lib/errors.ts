import i18n from '../i18n';
import { useToasts } from '../state/toasts';
import { IpcError } from './ipc';

/** Human readable, translated message for any error from the core. */
export function errorText(e: unknown): string {
  const err = e instanceof IpcError ? e : new IpcError({ code: 'generic', message: String(e) });
  const key = `common:errors.${err.code}`;
  return i18n.exists(key) ? i18n.t(key, { message: err.detail }) : i18n.t('common:errors.generic', { message: err.detail });
}

/** Shows an error toast. Use in catch handlers of user actions. */
export function reportError(e: unknown, title?: string): void {
  console.error(e);
  useToasts.getState().push({ tone: 'danger', title: title ?? errorText(e), body: title ? errorText(e) : undefined });
}
