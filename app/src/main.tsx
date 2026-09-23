import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { restoreTheme } from './ui/themes';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root-Element #root nicht gefunden');

// Gespeichertes Farbschema vor dem ersten Rendern anwenden (kein violettes Aufblitzen);
// höchstens 300 ms warten, damit ein langsamer Datenbank-Start die App nicht aufhält.
const themeReady = Promise.race([restoreTheme().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);

void themeReady.then(() => {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
