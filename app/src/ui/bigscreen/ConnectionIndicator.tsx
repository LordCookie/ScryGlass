import { useState, useSyncExternalStore } from 'react';
import { remoteClient, type RemoteClient } from '../../bigscreen/client';
import { IDLE_OPTIONS } from '../../domain/bigscreen';
import { PixelCheckbox } from '../PixelCheckbox';

/**
 * Verbindung zum Handy (PLAN.md M18): Pixel-Punkt mit Zustand; antippen öffnet die Details
 * und „Verbindung trennen".
 */

const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

export function useRemoteState(client: RemoteClient) {
  return useSyncExternalStore(client.subscribe, () => client.state);
}

function idleLabel(ms: number | undefined): string {
  if (ms == null) return '';
  return IDLE_OPTIONS.find((o) => o.ms === ms)?.label ?? `${Math.round(ms / 60_000)} min`;
}

/** `up`: Feld öffnet nach oben (unten in der Seitenleiste). */
export function ConnectionIndicator({ compact = false, up = false }: { compact?: boolean; up?: boolean }) {
  const client = remoteClient();
  if (!client) return null;
  return <Indicator client={client} compact={compact} up={up} />;
}

function Indicator({ client, compact, up }: { client: RemoteClient; compact: boolean; up: boolean }) {
  const st = useRemoteState(client);
  const [open, setOpen] = useState(false);
  const [clearCatalog, setClearCatalog] = useState(false);
  const [busy, setBusy] = useState(false);
  const low = st.status?.battery && !st.status.battery.charging && st.status.battery.level < 0.15;
  const color = st.online ? (low ? 'bg-warn' : 'bg-ok') : 'bg-danger';
  const label = st.online ? 'Handy verbunden' : 'Handy schläft — App öffnen';

  async function disconnect() {
    setBusy(true);
    try {
      await client.disconnect({ clearCatalog });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex items-center gap-2 px-2 py-1 font-mono text-xs text-muted hover:text-text">
        <span className={`inline-block h-2.5 w-2.5 ${color}`} style={{ boxShadow: '0 0 0 var(--px) rgb(var(--c-surface))' }} />
        {!compact && <span>{label}</span>}
        {low && <span className="text-warn">Akku {Math.round(st.status!.battery!.level * 100)} %</span>}
      </button>
      {open && (
        <div className={`frame absolute z-40 w-72 bg-surface font-mono text-xs ${up ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2'}`}>
          <div className="titlebar"><span className="truncate text-text">{st.status?.device ?? st.info.deviceName}</span></div>
          <div className="space-y-1 p-3 text-muted">
            <p>{label}</p>
            <p>Adresse: <span className="text-text">{location.host}</span></p>
            {st.loggedInAt && <p>Angemeldet seit {timeFmt.format(st.loggedInAt)}</p>}
            {st.status && (
              <p>Abmeldung nach {st.status.idleMs ? `${idleLabel(st.status.idleMs)} ohne Eingabe` : 'nie (bis Big Screen aus)'}</p>
            )}
            {st.status?.battery && (
              <p>Handy-Akku {Math.round(st.status.battery.level * 100)} %{st.status.battery.charging ? ' · lädt' : ''}</p>
            )}
            <div className="pt-2">
              <PixelCheckbox checked={clearCatalog} onChange={setClearCatalog}>
                Auch den Katalog löschen (fremder PC)
              </PixelCheckbox>
            </div>
            <button disabled={busy} onClick={() => void disconnect()}
              className="mt-2 w-full border-2 border-border px-3 py-1.5 text-sm text-text hover:border-danger hover:text-danger disabled:opacity-40">
              Verbindung trennen
            </button>
            <p className="pt-1 text-[10px]">
              Meldet diesen Browser ab und löscht hier Sammlung und Decks. Am Handy bleibt alles.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
