import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { previewImageIds } from '../../data/cards';
import { remoteClient, type RemoteClient, type ScanEntry } from '../../bigscreen/client';
import { CardImage } from '../CardImage';
import { useRemoteState } from './ConnectionIndicator';

/**
 * Unten rechts, immer sichtbar: neue Scans vom Handy (PLAN.md M18, DESIGN A11). Jede Karte
 * erscheint einige Sekunden; darunter bleibt der Zähler „neu seit Anmeldung" stehen, der die
 * Liste öffnet. Rückgängig am Handy → durchgestrichen.
 */

const SHOW_MS = 6000;
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const STATE_LABEL: Record<ScanEntry['state'], string> = {
  korb: 'im Korb',
  uebernommen: 'übernommen',
  verworfen: 'rückgängig',
};

export function ScanToasts() {
  const client = remoteClient();
  if (!client) return null;
  return <Toasts client={client} />;
}

function Toasts({ client }: { client: RemoteClient }) {
  const st = useRemoteState(client);
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const fresh = st.scans.filter((s) => now - s.at < SHOW_MS && s.state !== 'verworfen').slice(0, 3);
  useEffect(() => {
    if (!st.scans.length) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [st.scans.length]);
  const ids = useMemo(() => [...new Set(st.scans.slice(0, 40).map((s) => s.oracleId))], [st.scans]);
  const imgs = useLiveQuery(() => previewImageIds(ids), [ids]);
  const counted = st.scans.filter((s) => s.state !== 'verworfen').length;
  const taken = st.scans.filter((s) => s.state === 'uebernommen').length;
  if (!st.scans.length) return null;

  return (
    <div className="pointer-events-none fixed bottom-24 right-3 z-30 flex w-64 flex-col items-end gap-2 lg:bottom-4">
      {fresh.map((s) => (
        <div key={s.id} className="frame bs-toast-in pointer-events-auto flex w-full items-center gap-2 bg-surface p-2 font-mono text-xs">
          <CardImage scryfallId={imgs?.get(s.oracleId)} name={s.name} size="small" className="h-14 w-10 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-text">{s.name}</span>
            <span className="block text-muted">neu gescannt · {STATE_LABEL[s.state]}</span>
          </span>
        </div>
      ))}
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="pointer-events-auto bg-titlebar px-3 py-1.5 font-hud text-[9px] text-paper"
        style={{ boxShadow: 'calc(var(--px)*-1) calc(var(--px)*1) 0 rgb(var(--c-fill))' }}>
        {counted} NEU SEIT ANMELDUNG{taken ? ` · ${taken} ÜBERNOMMEN` : ''}
      </button>
      {open && (
        <div className="frame pointer-events-auto max-h-[60vh] w-80 overflow-y-auto bg-surface font-mono text-xs">
          <div className="titlebar sticky top-0">
            <span className="min-w-0 flex-1 truncate text-text">Zuletzt gescannt</span>
            <button onClick={() => client.dismissScans()} className="px-1 text-paper hover:text-danger" aria-label="Liste leeren">leeren</button>
          </div>
          <ul className="divide-y divide-border">
            {st.scans.map((s) => (
              <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-16 shrink-0 text-muted">{timeFmt.format(s.at)}</span>
                <span className={`min-w-0 flex-1 truncate ${s.state === 'verworfen' ? 'text-muted line-through' : 'text-text'}`}>{s.name}</span>
                <span className={s.state === 'uebernommen' ? 'text-ok' : 'text-muted'}>{STATE_LABEL[s.state]}</span>
              </li>
            ))}
          </ul>
          <p className="px-3 py-2 text-[10px] text-muted">
            Gescannt wird am Handy. In die Sammlung kommt eine Karte beim „In Sammlung übernehmen" — dann zeigt der Browser sie auch.
          </p>
        </div>
      )}
    </div>
  );
}
