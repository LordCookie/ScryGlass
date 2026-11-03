import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { APP_VERSION } from '../version';
import {
  checkForUpdates, currentUpdateStatus, openInstallSettings, canDownloadUpdates, UpdateError, RELEASES_PAGE,
  appUpdateJob, startAppUpdate, catalogJob, startCatalogUpdate, type InstallStep, type CatalogStep,
} from '../data/updates';
import { fetchRemoteVersion, getLocalCatalogVersion, type CatalogVersion } from '../data/catalog';
import { loadTokenCatalog } from '../data/tokenCatalog';
import { hasAppUpdater } from '../native/appUpdater';
import { noteLines, catalogDate, formatMb, isNewerCatalog } from '../domain/updates';
import { useJob } from './useJob';

/**
 * „Mehr" → Updates (PLAN.md M15): App-Update von GitHub (laden, prüfen, installieren)
 * und Katalog-Update (wöchentlich neu gebaut). Beide laufen als Hintergrund-Aufgabe
 * (data/job) — der Bildschirm zeigt nur den Stand. Der Punkt am „Mehr"-Tab, die
 * Fortschrittsleiste in den anderen Tabs und „Was ist neu" hängen in App.tsx.
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
  return 'Prüfe die Datei (Prüfsumme, Signatur)…';
}

const pct = (done: number, total: number) => `${Math.min(100, Math.round((done / Math.max(1, total)) * 100))} %`;

/** Text + Balken für ein laufendes Katalog-Update (hier und in der Leiste über den Tabs). */
function catalogProgress(s: CatalogStep | null): { label: string; done: number; total: number } {
  if (!s) return { label: 'Katalog: verbinde…', done: 0, total: 1 };
  if (s.phase === 'katalog') {
    const { overallDone: done, overallTotal: total } = s.progress;
    return { label: `Katalog wird geladen · ${pct(done, total)}`, done, total };
  }
  return { label: `Bild-Abgleich · ${pct(s.done, s.total)}`, done: s.done, total: s.total };
}

export function AppUpdateSection() {
  const status = useLiveQuery(() => currentUpdateStatus(), []);
  const job = useJob(appUpdateJob);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const app = status?.app;
  const native = hasAppUpdater();
  const step = job.step;
  const needPerm = job.error instanceof UpdateError && job.error.code === 'ERLAUBNIS';
  const jobMsg = job.error && !needPerm ? (job.error as Error).message : null;
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

  // Läuft im Hintergrund weiter, auch wenn man „Mehr" verlässt (data/job).
  function install() {
    if (!app) return;
    setMsg(null);
    void startAppUpdate(app);
  }

  const shown = msg ?? jobMsg;
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
          ) : job.running ? (
            <div className="space-y-1 font-mono text-xs">
              {step?.phase === 'download' && <Bar value={step.done} max={step.total} />}
              <p className="text-accent">{step ? stepText(step) : 'Starte…'}</p>
            </div>
          ) : job.result === 'installer' ? (
            <div className="space-y-1 font-mono text-xs">
              <p className="text-ok">Android fragt jetzt nach der Installation — bestätigen, danach „Öffnen" tippen.</p>
              <button onClick={() => appUpdateJob.reset()} className="text-muted underline hover:text-text">
                Abgebrochen? Nochmal versuchen
              </button>
            </div>
          ) : (
            <button onClick={install} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">
              Herunterladen und installieren ({formatMb(app.apk.size)})
            </button>
          )}

          {needPerm && (
            <div className="space-y-2 bg-warn/15 p-3 font-mono text-xs text-warn">
              <p>Android fragt einmalig, ob ScryGlass Updates installieren darf. Schalte dort „Dieser Quelle vertrauen" ein, komm zurück und tippe nochmal auf „Herunterladen und installieren".</p>
              <button onClick={() => void openInstallSettings()} className="bg-accent px-3 py-1 text-on-accent">Erlauben</button>
            </div>
          )}
          {native && !job.running && job.result == null && (
            <p className="font-mono text-[10px] text-muted">Vorher wird deine Sammlung automatisch gesichert (Backup → Automatische Sicherungen).</p>
          )}
          <div>
            <button onClick={() => void check()} disabled={checking || job.running}
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
      {shown && <p className="mt-2 font-mono text-xs text-muted">{shown}</p>}
      {app && native && jobMsg && (
        <a href={app.pageUrl ?? RELEASES_PAGE} target="_blank" rel="noreferrer"
          className="mt-1 inline-block font-mono text-xs text-accent underline">
          Oder von Hand laden (Release-Seite)
        </a>
      )}
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
  const job = useJob(catalogJob);
  const [counts, setCounts] = useState<{ cards: number; tokens: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
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

  // Läuft im Hintergrund weiter, auch wenn man „Mehr" verlässt (data/job).
  function load() {
    setMsg(null);
    if (remote) void startCatalogUpdate({ kind: 'github' });
    else if (embedded) void startCatalogUpdate({ kind: 'eingebaut', version: embedded });
  }

  const embeddedNewer = embedded && isNewerCatalog(embedded.catalogVersion, local) ? embedded : null;
  const available = remote ? update : embeddedNewer ? { version: embeddedNewer.catalogVersion, bytes: 0 } : undefined;
  const progress = catalogProgress(job.step);
  const jobMsg = job.error
    ? `Update abgebrochen: ${(job.error as Error).message}`
    : job.result ? `Katalog vom ${catalogDate(job.result)} eingespielt.` : null;
  const shown = msg ?? jobMsg;

  return (
    <div className="rounded-lg bg-surface p-4">
      <h2 className="mb-1 font-mono text-lg">Katalog</h2>
      <p className="mb-3 font-mono text-xs text-muted">
        Stand {catalogDate(local)}
        {counts ? ` · ${counts.cards.toLocaleString('de-DE')} Karten${counts.tokens ? ` + ${counts.tokens.toLocaleString('de-DE')} Tokens` : ''}` : ''}
        {remote ? ' · neue Sets kommen wöchentlich' : ''}
      </p>

      {job.running ? (
        <div className="space-y-1 font-mono text-xs text-accent">
          <Bar value={progress.done} max={progress.total} />
          <p>{progress.label}</p>
          <p className="text-muted">Läuft weiter, auch wenn du den Tab wechselst. Die Sammlung bleibt unberührt.</p>
        </div>
      ) : available ? (
        <div className="space-y-2">
          <p className="font-mono text-sm text-accent">
            Neuer Katalog vom {catalogDate(available.version)}{available.bytes ? ` · ca. ${formatMb(available.bytes)}` : ''}
          </p>
          {onCellular() && <p className="font-mono text-xs text-warn">Du bist im Mobilfunknetz — lieber im WLAN laden.</p>}
          <button onClick={load} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">
            Katalog laden
          </button>
        </div>
      ) : (
        <button onClick={() => void check()} disabled={checking}
          className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent disabled:opacity-40">
          {checking ? 'Prüfe…' : 'Nach neuem Katalog suchen'}
        </button>
      )}
      {shown && <p className="mt-2 font-mono text-xs text-muted">{shown}</p>}
    </div>
  );
}

/**
 * Läuft ein Update, während man in einem anderen Tab ist: schmale Leiste unter dem Kopf
 * (App.tsx), damit man sieht, dass es weitergeht. Tippen führt zu „Mehr".
 */
export function UpdateProgressStrip({ onOpen }: { onOpen: () => void }) {
  const catalog = useJob(catalogJob);
  const app = useJob(appUpdateJob);
  let p: { label: string; done: number; total: number } | null = null;
  if (catalog.running) p = catalogProgress(catalog.step);
  else if (app.running) {
    const s = app.step;
    p = s?.phase === 'download'
      ? { label: `App-Update wird geladen · ${pct(s.done, s.total)}`, done: s.done, total: s.total }
      : { label: s ? stepText(s) : 'App-Update startet…', done: 0, total: 1 };
  }
  if (!p) return null;
  return (
    <button onClick={onOpen} className="mx-4 mb-2 block space-y-1 rounded-md bg-accent/10 px-3 py-2 text-left font-mono text-xs text-accent">
      <span className="block">{p.label}</span>
      <Bar value={p.done} max={p.total} />
    </button>
  );
}
