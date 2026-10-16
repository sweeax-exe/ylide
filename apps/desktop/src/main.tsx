import '@fontsource-variable/instrument-sans/standard.css';
import '@fontsource-variable/jetbrains-mono';
import './styles/base.css';
import './i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './design/applyTheme';
import { darkTheme } from './design/themes';

// Paint the dark theme before settings arrive, so there is no white flash.
applyTheme(darkTheme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
