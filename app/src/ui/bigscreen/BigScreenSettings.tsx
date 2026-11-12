import { useEffect, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import {
  bigScreenPhone, bigScreenAvailable, initBigScreenPhone, setBigScreenPassword, setBigScreenIdle,
  startBigScreen, stopBigScreen, kickBigScreenSession, bigScreenCatalogReady, prepareBigScreenCatalog,
  bigScreenImageCache, clearBigScreenImageCache,
} from '../../bigscreen/phone';
import { remoteClient } from '../../bigscreen/client';
import { imagePrefetch } from '../../bigscreen/prefetch';
import { IDLE_OPTIONS, PASSWORD_MIN } from '../../domain/bigscreen';
import { PixelCheckbox } from '../PixelCheckbox';

/**
 * Mehr → Big Screen (PLAN.md M18). Am Handy: Passwort, Ein/Aus, Adresse + QR, angemeldete
 * Browser, Abmeldung ohne Eingabe. Im Browser: Verbindung und „Verbindung trennen".
 */

const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0).replace('.', ',')} MB`;

export function BigScreenSection() {
  const st = useSyncExternalStore(bigScreenPhone.subscribe, () => bigScreenPhone.state);
  const [pw, setPw] = useState('');
  const [changing, setChanging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => { void initBigScreenPhone(); }, []);
  // Bekommt der Browser denselben Katalog? (Sonst einmal bereitstellen.)
  const [catalog, setCatalog] = useState<{ ready: boolean } | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  useEffect(() => { void bigScreenCatalogReady().then(setCatalog).catch(() => setCatalog(null)); }, [st.running]);
  async function prepare() {
    setPreparing('Lade…');
    try {
      const r = await prepareBigScreenCatalog((b) => setPreparing(`Lade ${(b / 1_000_000).toFixed(1).replace('.', ',')} MB…`));
      setPreparing(r === 'update' ? 'Katalog-Update läuft (Mehr → Katalog).' : null);
      setCatalog(await bigScreenCatalogReady());
    } catch (e) {
      setPreparing(`Fehlgeschlagen: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    if (st.url) void QRCode.toDataURL(st.url, { width: 200, margin: 1 }).then(setQr).catch(() => setQr(null));
    else setQr(null);
  }, [st.url]);
  // Kartenbilder, die das Handy für den Browser aufhebt (M20).
  const [images, setImages] = useState<{ bytes: number; count: number } | null>(null);
  useEffect(() => { void bigScreenImageCache().then(setImages); }, [st.running, st.sessions.length]);

  if (!bigScreenAvailable()) {
    return (
      <div className="rounded-lg bg-surface p-4">
        <h2 className="mb-1 font-mono text-lg">Big Screen</h2>
        <p className="font-mono text-xs text-muted">Nur in der Android-App: Das Handy liefert die App an den Browser am PC aus.</p>
      </div>
    );
  }

  async function savePassword() {
    if (pw.length < PASSWORD_MIN) {
      setMsg(`Mindestens ${PASSWORD_MIN} Zeichen.`);
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      await setBigScreenPassword(pw);
      setPw('');
      setChanging(false);
      setMsg('Passwort gespeichert.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const askPassword = !st.hasPassword || changing;

  return (
    <div className="rounded-lg bg-surface p-4 font-mono">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="flex-1 text-lg">Big Screen</h2>
        {st.hasPassword && !askPassword && (
          <button disabled={st.busy} onClick={() => void (st.running ? stopBigScreen() : startBigScreen())}
            className={`px-3 py-1.5 text-sm disabled:opacity-40 ${st.running ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
            {st.busy ? '…' : st.running ? 'An' : 'Aus'}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-muted">
        Die App im Browser am PC oder Tablet: Sammlung ansehen, Decks bauen, Fertigdecks und CSV importieren —
        während das Handy weiter scannt. Nur fürs eigene WLAN.
      </p>

      {askPassword && (
        <div className="mb-3 space-y-2 bg-bg p-3 text-xs">
          <p className="text-text">{st.hasPassword ? 'Neues Passwort' : 'Erst ein Passwort festlegen'} (mindestens {PASSWORD_MIN} Zeichen)</p>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password"
            className="w-full border-2 border-border bg-surface px-3 py-2 text-sm outline-none focus:border-paper" />
          <div className="flex gap-2">
            <button disabled={saving || !pw} onClick={() => void savePassword()}
              className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-40">
              {saving ? 'Speichere…' : 'Passwort speichern'}
            </button>
            {changing && <button onClick={() => { setChanging(false); setPw(''); }} className="px-3 py-1.5 text-sm text-muted">Abbrechen</button>}
          </div>
          <p className="text-[10px] text-muted">Gespeichert wird nur ein daraus abgeleiteter Schlüssel, nie das Passwort.</p>
        </div>
      )}

      {catalog && !catalog.ready && (
        <div className="mb-3 bg-bg p-3 text-xs">
          <p className="text-warn">Der Browser bekäme einen älteren Katalog als dieses Handy.</p>
          <p className="mt-1 text-muted">
            Einmal bereitstellen: Das Handy lädt die Katalog-Dateien (rund 45 MB, im WLAN) von GitHub und hebt sie auf.
            Danach kommt der Katalog für den Browser immer vom Handy.
          </p>
          <button disabled={!!preparing && preparing.startsWith('Lade')} onClick={() => void prepare()}
            className="mt-2 rounded bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-40">Katalog bereitstellen</button>
          {preparing && <p className="mt-1 text-muted">{preparing}</p>}
        </div>
      )}

      {st.running && st.url && (
        <div className="mb-3 bg-bg p-3 text-xs">
          <p className="text-muted">Im Browser öffnen:</p>
          <p className="my-1 select-all break-all font-hud text-[12px] text-paper">{st.url}</p>
          {qr && <img src={qr} alt="QR-Code der Adresse" className="pixelated my-2 h-36 w-36" />}
          <p className="text-muted">
            Der Bildschirm bleibt an; nach 2 min ohne Berührung wird er dunkel. Antippen holt alles zurück.
            {st.charging === false && <span className="text-warn"> Ladekabel empfohlen.</span>}
          </p>
        </div>
      )}

      {st.running && (
        <div className="mb-3 text-xs">
          <h3 className="mb-1 font-hud text-[9px] text-text">ANGEMELDET ({st.sessions.length})</h3>
          {st.sessions.length === 0 ? (
            <p className="text-muted">Noch kein Browser. Ohne Anmeldung geht Big Screen nach 30 min von selbst aus.</p>
          ) : (
            <ul className="space-y-1">
              {st.sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-text">{s.device}</span>
                  <span className="text-muted">{s.ip} · {timeFmt.format(s.createdAt)}</span>
                  <button onClick={() => kickBigScreenSession(s.id)} className="bg-bg px-2 py-1 text-muted hover:text-danger">Abmelden</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <label className="mb-2 flex items-center gap-2 text-xs text-muted">
        Abmelden nach
        <select value={st.idleMs} onChange={(e) => void setBigScreenIdle(Number(e.target.value))}
          className="border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper">
          {IDLE_OPTIONS.map((o) => <option key={o.ms} value={o.ms}>{o.label}</option>)}
        </select>
        ohne Eingabe
      </label>
      <p className="mb-2 text-[10px] text-muted">
        Als Eingabe zählt Klicken, Tippen und Scrollen im Browser — ein vergessener Tab läuft trotzdem ab.
      </p>

      {images && images.count > 0 && (
        <p className="mb-2 flex items-center gap-2 text-xs text-muted">
          <span className="flex-1">Kartenbilder für den Browser: {images.count} · {mb(images.bytes)} (höchstens 300 MB)</span>
          <button onClick={() => void clearBigScreenImageCache().then(() => setImages({ bytes: 0, count: 0 }))}
            className="bg-bg px-2 py-1 hover:text-text">Leeren</button>
        </p>
      )}

      {st.hasPassword && !askPassword && (
        <button onClick={() => setChanging(true)} className="text-xs text-muted underline hover:text-text">Passwort ändern</button>
      )}
      {(msg || st.error) && <p className="mt-2 text-xs text-muted">{msg ?? st.error}</p>}
      <p className="mt-3 text-[10px] text-muted">
        Ohne HTTPS: Wer im selben WLAN mitliest, könnte die Sitzung übernehmen. Deshalb nur zu Hause oder im
        vertrauten Netz einschalten.
      </p>
    </div>
  );
}

/** Im Browser unter „Mehr": Verbindung und „Verbindung trennen". */
export function BigScreenRemoteSection() {
  const client = remoteClient();
  const st = useSyncExternalStore(
    (l) => client?.subscribe(l) ?? (() => {}),
    () => client?.state,
  );
  const [clearCatalog, setClearCatalog] = useState(false);
  const [busy, setBusy] = useState(false);
  const pre = useSyncExternalStore(imagePrefetch.subscribe, () => imagePrefetch.state);
  if (!client || !st) return null;
  return (
    <div className="rounded-lg bg-surface p-4 font-mono text-xs">
      <h2 className="mb-2 text-lg">Big Screen</h2>
      <p className="text-muted">
        Verbunden mit <span className="text-text">{st.status?.device ?? st.info.deviceName}</span> ({location.host})
        {st.online ? '' : ' — Handy schläft, App am Handy öffnen'}.
      </p>
      <p className="mt-1 text-muted">Scanner, Updates und Sicherungen gibt es am Handy.</p>
      {pre.total > 0 && (
        <p className="mt-1 text-muted">
          Kartenbilder kommen vom Handy.{' '}
          {pre.running ? `Lade Bilder von Sammlung und Decks vor: ${pre.done} / ${pre.total}` : `${pre.done} Bilder von Sammlung und Decks vorgeladen.`}
        </p>
      )}
      <div className="mt-3">
        <PixelCheckbox checked={clearCatalog} onChange={setClearCatalog}>Auch den Katalog löschen (fremder PC)</PixelCheckbox>
      </div>
      <button disabled={busy} onClick={() => { setBusy(true); void client.disconnect({ clearCatalog }).finally(() => setBusy(false)); }}
        className="mt-2 border-2 border-border px-3 py-1.5 text-sm text-text hover:border-danger hover:text-danger disabled:opacity-40">
        Verbindung trennen
      </button>
    </div>
  );
}
