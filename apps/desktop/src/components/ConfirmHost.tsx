import { useTranslation } from 'react-i18next';
import { useConfirm } from '../state/confirm';
import { Dialog } from './Dialog';
import { Button } from './ui';

/** Renders the pending `useConfirm().ask(...)` question. Mounted once by the app. */
export function ConfirmHost() {
  const { t } = useTranslation();
  const current = useConfirm((st) => st.current);
  const settle = useConfirm((st) => st.settle);
  return (
    <Dialog
      open={current !== null}
      title={current?.title}
      onClose={() => settle(false)}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)} data-autofocus>
            {t('actions.cancel')}
          </Button>
          <Button variant={current?.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
            {current?.confirmLabel}
          </Button>
        </>
      }
    >
      {current?.body}
    </Dialog>
  );
}
