import { Copy, Minus, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LogoMark } from '../../components/Braid';
import { useMaximized, windowControls } from '../../shell/window';
import s from './WindowBar.module.css';

/** Slim title bar: the whole strip drags the window (Tauri also maximizes on double click). */
export function WindowBar() {
  const { t } = useTranslation();
  const maximized = useMaximized();
  return (
    <header className={s.bar} data-tauri-drag-region="deep">
      <span className={s.brand}>
        <LogoMark size={18} />
        <span className={s.name}>{t('app.name')}</span>
      </span>
      <div className={s.controls}>
        <button type="button" className={s.control} aria-label={t('window.minimize')} title={t('window.minimize')} onClick={() => void windowControls.minimize()}>
          <Minus size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={s.control}
          aria-label={t(maximized ? 'window.restore' : 'window.maximize')}
          title={t(maximized ? 'window.restore' : 'window.maximize')}
          onClick={() => void windowControls.toggleMaximize()}
        >
          {maximized ? <Copy size={12} aria-hidden /> : <Square size={12} aria-hidden />}
        </button>
        <button type="button" className={`${s.control} ${s.close}`} aria-label={t('window.close')} title={t('window.close')} onClick={() => void windowControls.close()}>
          <X size={15} aria-hidden />
        </button>
      </div>
    </header>
  );
}
