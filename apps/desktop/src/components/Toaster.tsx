import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToasts } from '../state/toasts';
import s from './Toaster.module.css';
import { Button } from './ui';

export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToasts((st) => st.toasts);
  const dismiss = useToasts((st) => st.dismiss);
  return (
    <div className={s.stack} role="region" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`${s.toast} ${s[toast.tone]}`} role={toast.tone === 'danger' ? 'alert' : 'status'}>
          <div className={s.text}>
            <div className={s.title}>{toast.title}</div>
            {toast.body && <div className={s.body}>{toast.body}</div>}
            {toast.action && (
              <div className={s.action}>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    dismiss(toast.id);
                    toast.action?.run();
                  }}
                >
                  {toast.action.label}
                </Button>
              </div>
            )}
          </div>
          <button className={s.close} onClick={() => dismiss(toast.id)} aria-label={t('actions.close')}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
