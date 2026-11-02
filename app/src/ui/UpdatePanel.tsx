import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { APP_VERSION } from '../version';
import {
  checkForUpdates, currentUpdateStatus, downloadAndInstall, openInstallSettings, applyRemoteCatalog,
  canDownloadUpdates, UpdateError, RELEASES_PAGE, type InstallStep, type CatalogStep,
} from '../data/updates';
import { fetchRemoteVersion, applyUpdate, getLocalCatalogVersion, type CatalogVersion } from '../data/catalog';
import { invalidateNameIndex } from '../data/matcher';
import { invalidateSearchIndex } from '../data/search';
import { loadTokenCatalog } from '../data/tokenCatalog';
import { hasAppUpdater } from '../native/appUpdater';
import { noteLines, catalogDate, formatMb, isNewerCatalog } from '../domain/updates';

/**
 * „Mehr" → Updates (PLAN.md M15): App-Update von GitHub (laden, prüfen, installieren)
 * und Katalog-Update (wöchentlich neu gebaut). Der Punkt am „Mehr"-Tab und „Was ist neu"
 * hängen in App.tsx.
 */

const dateTime = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** Patch Notes als schlichte Zeilen (Überschrift / Punkt / Absatz). */
export function ReleaseNotes({ md }: { md: string }) {
  const lines = noteLines(md);
  if (lines.length === 0) return <p className="text-xs text-muted">Keine Patch Notes.</p>;
  return (
    <div className="space-y-1 font-mono text-xs leading-relaxed">
      {lines.map((l, i) =>
        l.kind === 'heading' ? (
          <p key={i} className="pt-1 font-hud text-[9px] text-text">{l.text.toUpperCase()}</p>
        ) : l.kind === 'bullet' ? (
          <p key={i} className="flex gap-2 text-muted"><span className="text-accent">▪</span><span>{l.text}</span></p>
        ) : (
          <p key={i} className="text-muted">{l.text}</p>
        ),
      )}
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-2 w-full bg-bg">
      <div className="h-2 bg-fill" style={{ width: `${Math.min(100, (value / Math.max(1, max)) * 100)}%` }} />
    </div>
  );
}

function stepText(s: InstallStep): string {
  if (s.phase === 'sicherung') return 'Sichere deine Sammlung…';
  if (s.phase === 'download') return `Lade ${formatMb(s.done)} von ${formatMb(s.total)}…`;
  if (s.phase === 'pruefen') return 'Prüfe die Datei (Prüfsumme, Signatur)…';
  return 'Android fragt jetzt nach der Installation — bestätigen, danach „Öffnen" tippen.';
}

export function AppUpdateSection() {
  const status = useLiveQuery(() => currentUpdateStatus(), []);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [step, setStep] = useState<InstallStep | null>(null);
  const [needPerm, setNeedPerm] = useState(false);
  const app = status?.app;
  const native = hasAppUpdater();
  // Taucht eine neue Version auf, ist ein altes „neueste Version" überholt.
  useEffect(() => {
    if (app) setMsg(null);
  }, [app?.version]);

  async function check() {
    setChecking(true);
    setMsg(null);
    try {
      const s = await checkForUpdates(true);
      if (!s?.app) setMsg('Du hast die neueste Version.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function install() {
    if (!app) return;
    setMsg(null);
    setNeedPerm(false);
    try {
      await downloadAndInstall(app, setStep);
    } catch (e) {
      setStep(null);
      if (e instanceof UpdateError && e.code === 'ERLAUBNIS') setNeedPerm(true);
      else setMsg((e as Error).message);
    }
  }

  return (
    <div className="rounded-lg bg-surface p-4">
      <h2 className="mb-1 font-mono text-lg">App-Update</h2>
      <p className="mb-3 font-mono text-xs text-muted">
        Installiert: {APP_VERSION}
        {status?.checkedAt ? ` · zuletzt geprüft ${dateTime.format(status.checkedAt)}` : ''}
      </p>

      {app ? (
        <div className="space-y-3">
          <p className="font-mono text-sm text-accent">
            Neue Version {app.version}{app.publishedAt ? ` vom ${dateOnly.format(new Date(app.publishedAt))}` : ''}
          </p>
          <div className="max-h-64 overflow-y-auto border-2 border-border p-2">
            <ReleaseNotes md={app.notes} />
          </div>

          {!native ? (
            <a href={app.pageUrl ?? RELEASES_PAGE} target="_blank" rel="noreferrer"
              className="inline-block rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">
              Zur Release-Seite
            </a>
          ) : step ? (
            <div className="space-y-1 font-mono text-xs">
              {step.phase === 'download' && <Bar value={step.done} max={step.total} />}
              <p className={step.phase === 'installer' ? 'text-ok' : 'text-accent'}>{stepText(step)}</p>
              {step.phase === 'installer' && (
                <button onClick={() => setStep(null)} className="text-muted underline hover:text-text">
                  Abgebrochen? Nochmal versuchen
                </button>
              )}
            </div>
          ) : (
            <button onClick={() => void install()} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">
              Herunterladen und installieren ({formatMb(app.apk.size)})
            </button>
          )}

          {needPerm && (
            <div className="space-y-2 bg-warn/15 p-3 font-mono text-xs text-warn">
              <p>Android fragt einmalig, ob ScryGlass Updates installieren darf. Schalte dort „Dieser Quelle vertrauen" ein, komm zurück und tippe nochmal auf „Herunterladen und installieren".</p>
              <button onClick={() => void openInstallSettings()} className="bg-accent px-3 py-1 text-on-accent">Erlauben</button>
            </div>
          )}
          {native && !step && <p className="font-mono text-[10px] text-muted">Vorher wird deine Sammlung automatisch gesichert (Backup → Automatische Sicherungen).</p>}
          <div>
            <button onClick={() => void check()} disabled={checking || !!step}
              className="font-mono text-[10px] text-muted underline hover:text-text disabled:opacity-40">
              {checking ? 'Prüfe…' : 'Nochmal prüfen'}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => void check()} disabled={checking}
          className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent disabled:opacity-40">
          {checking ? 'Prüfe…' : 'Nach Updates suchen'}
        </button>
      )}
      {msg && <p className="mt-2 font-mono text-xs text-muted">{msg}</p>}
    </div>
  );
}

/** Mobilfunk statt WLAN? (Network Information API — Chrome/Android-WebView kennt sie.) */
function onCellular(): boolean {
  return (navigator as Navigator & { connection?: { type?: string } }).connection?.type === 'cellular';
}

export function CatalogUpdateSection() {
  const local = useLiveQuery(() => getLocalCatalogVersion(), []);
  const status = useLiveQuery(() => currentUpdateStatus(), []);
  const [counts, setCounts] = useState<{ cards: number; tokens: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [step, setStep] = useState<CatalogStep | null>(null);
  // Browser (Entwicklung): nur der eingebaute Katalog unter /catalog.
  const [embedded, setEmbedded] = useState<CatalogVersion | null>(null);
  const remote = canDownloadUpdates();
  const update = status?.catalog;

  const recount = async () => {
    const [n, t] = await Promise.all([db.cards.count(), loadTokenCatalog()]);
    setCounts({ cards: n - t.oracleIds.size, tokens: t.oracleIds.size });
  };
  useEffect(() => { void recount(); }, [local]);

  async function check() {
    setChecking(true);
    setMsg(null);
    try {
      if (remote) {
        const s = await checkForUpdates(true);
        if (!s?.catalog) setMsg('Der Katalog ist aktuell.');
      } else {
        const v = await fetchRemoteVersion();
        const newer = v && isNewerCatalog(v.catalogVersion, local) ? v : null;
        setEmbedded(newer);
        if (!newer) setMsg('Der Katalog ist aktuell.');
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function load() {
    setMsg(null);
    try {
      if (remote) {
        const v = await applyRemoteCatalog(setStep);
        setMsg(`Katalog vom ${catalogDate(v)} eingespielt.`);
      } else if (embedded) {
        await applyUpdate(embedded, { onProgress: (progress) => setStep({ phase: 'katalog', progress }) });
        invalidateNameIndex();
        invalidateSearchIndex();
        setEmbedded(null);
      }
    } catch (e) {
      setMsg(`Update abgebrochen: ${(e as Error).message}`);
    } finally {
      setStep(null);
    }
  }

  const available = remote ? update : embedded ? { version: embedded.catalogVersion, bytes: 0 } : undefined;

  return (
    <div className="rounded-lg bg-surface p-4">
      <h2 className="mb-1 font-mono text-lg">Katalog</h2>
      <p className="mb-3 font-mono text-xs text-muted">
        Stand {catalogDate(local)}
        {counts ? ` · ${counts.cards.toLocaleString('de-DE')} Karten${counts.tokens ? ` + ${counts.tokens.toLocaleString('de-DE')} Tokens` : ''}` : ''}
        {remote ? ' · neue Sets kommen wöchentlich' : ''}
      </p>

      {step ? (
        <div className="space-y-1 font-mono text-xs text-accent">
          {step.phase === 'katalog' ? (
            <>
              <Bar value={step.progress.overallDone} max={step.progress.overallTotal} />
              <p>Karten {step.progress.overallDone.toLocaleString('de-DE')} / {step.progress.overallTotal.toLocaleString('de-DE')}</p>
            </>
          ) : (
            <p>Bild-Abgleich: {step.done.toLocaleString('de-DE')} Bilder</p>
          )}
          <p className="text-muted">Nicht schließen — die Sammlung bleibt unberührt.</p>
        </div>
      ) : available ? (
        <div className="space-y-2">
          <p className="font-mono text-sm text-accent">
            Neuer Katalog vom {catalogDate(available.version)}{available.bytes ? ` · ca. ${formatMb(available.bytes)}` : ''}
          </p>
          {onCellular() && <p className="font-mono text-xs text-warn">Du bist im Mobilfunknetz — lieber im WLAN laden.</p>}
          <button onClick={() => void load()} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">
            Katalog laden
          </button>
        </div>
      ) : (
        <button onClick={() => void check()} disabled={checking}
          className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent disabled:opacity-40">
          {checking ? 'Prüfe…' : 'Nach neuem Katalog suchen'}
        </button>
      )}
      {msg && <p className="mt-2 font-mono text-xs text-muted">{msg}</p>}
    </div>
  );
}
