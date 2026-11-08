import { useState } from 'react';
import type { RemoteClient } from '../../bigscreen/client';

/**
 * Anmeldeseite im Browser (PLAN.md M18). Als Überlagerung, wenn die Anmeldung ohne Eingabe
 * abgelaufen ist: Die Daten sind dann nicht zu sehen, nach dem Anmelden geht es an
 * derselben Stelle weiter.
 */
export function RemoteLogin({ client, device, overlay = false }: { client: RemoteClient; device: string; overlay?: boolean }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const err = await client.login(password);
      if (err) setError(err);
      else setPassword('');
    } catch {
      setError('Das Handy antwortet nicht.');
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <form onSubmit={(e) => void submit(e)} className="frame w-full max-w-sm bg-surface">
      <div className="titlebar"><span className="truncate text-text">Big Screen · {device}</span></div>
      <div className="space-y-3 p-5 font-mono text-sm">
        {overlay ? (
          <p className="text-muted">Abgemeldet, weil eine Weile nichts passiert ist. Nach dem Anmelden geht es hier weiter.</p>
        ) : (
          <p className="text-muted">Das Passwort hast du am Handy unter Mehr → Big Screen festgelegt.</p>
        )}
        <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="Passwort" autoComplete="current-password"
          className="w-full border-2 border-border bg-bg px-3 py-2 outline-none focus:border-paper" />
        <button type="submit" disabled={!password || busy} className="pxbtn pxbtn-primary w-full font-hud text-[10px] disabled:opacity-40">
          {busy ? 'Prüfe…' : 'Anmelden'}
        </button>
        {error && <p className="text-danger">{error}</p>}
        <p className="text-[10px] text-muted">
          Nur fürs eigene WLAN gedacht. Das Passwort geht nicht im Klartext durchs Netz.
        </p>
      </div>
    </form>
  );

  if (overlay) {
    return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg px-4">{body}</div>;
  }
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4">
      <h1 className="mb-8 font-hud text-xl">
        <span className="text-muted">Scry</span><span className="text-paper">Glass</span>
      </h1>
      {body}
    </div>
  );
}
