import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { restoreTheme } from './ui/themes';
import { detectBigScreen, startRemote } from './bigscreen/client';
import { RemoteRoot } from './ui/bigscreen/RemoteRoot';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root-Element #root nicht gefunden');

// Gespeichertes Farbschema vor dem ersten Rendern anwenden (kein violettes Aufblitzen);
// höchstens 300 ms warten, damit ein langsamer Datenbank-Start die App nicht aufhält.
const themeReady = Promise.race([restoreTheme().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);

// Big Screen (PLAN.md M18): Liefert das Handy die App aus, gibt es `/bigscreen.json` —
// dann Fernbetrieb mit Anmeldung statt der normalen App.
void Promise.all([themeReady, detectBigScreen()]).then(([, bigscreen]) => {
  createRoot(rootEl).render(
    <StrictMode>
      {bigscreen ? <RemoteRoot client={startRemote(bigscreen)} /> : <App />}
    </StrictMode>,
  );
});
