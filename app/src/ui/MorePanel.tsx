import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { db, listScans, clearScans } from '../db/db';
import { serializeCollection, parseCollection, CollectionImportError } from '../domain/collectionIo';
import { toMoxfieldCsv, parseCollectionCsv, type CsvRow } from '../domain/collectionCsv';
import { documentsBackupName } from '../domain/updates';
import { getCards } from '../data/cards';
import {
  applyBackup, listAutoBackups, restoreAutoBackup, shareAutoBackup, saveBackupToDocuments, markSafeBackup,
  lastSafeBackup, backupReminder, type AutoBackup,
} from '../data/backups';
import { resolveCsvRows, applyCsvImport, type ResolvedCsv, type ImportItem } from '../data/collectionImport';
import { AppUpdateSection, CatalogUpdateSection } from './UpdatePanel';
import { initFeedbackPrefs, getVibration, setVibration, hapticTap } from '../native/feedback';
import { PixelIcon } from './PixelIcon';
import { THEMES, currentTheme, chooseTheme, type ThemeKey } from './themes';
import { PeerPanel } from './PeerPanel';
import { APP_VERSION } from '../version';
import { getScanDiag, setScanDiag } from '../data/scanDiag';
import { getTokenCount } from '../data/tokens';
import { PixelCheckbox } from './PixelCheckbox';

/** „Mehr": Updates, Einstellungen, Backup/Export, Rechtliches (PLAN.md § 5, § 4, § 12, M15). */

function downloadWeb(filename: string, content: string, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Datei speichern/teilen. Nativ (Android): in den Cache schreiben und die Teilen-
 * Funktion öffnen (Blob-Downloads sind im WebView unzuverlässig). Web: klassischer
 * Download. Rückgabe: true, wenn ausgelöst.
 */
async function saveFile(filename: string, content: string, type = 'application/json'): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await Filesystem.writeFile({
        path: filename,
        data: content,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });
      await Share.share({ title: filename, url: res.uri });
      return true;
    } catch {
      return false; // Teilen abgebrochen o. Ä.
    }
  }
  downloadWeb(filename, content, type);
  return true;
}

/** In die Zwischenablage legen — robust: erst Clipboard-API, dann Textarea-Fallback
 *  (Datei-Downloads sind im Android-WebView oft unzuverlässig). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fallback unten */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function MorePanel() {
  return (
    <section className="space-y-3">
      {/* Updates oben — dorthin zeigt der Punkt am „Mehr"-Tab (M15). */}
      <AppUpdateSection />
      <CatalogUpdateSection />
      <SettingsSection />
      {/* Gemeinsam scannen — früher eigener Tab, jetzt hier (Platz für die Suche). */}
      <PeerPanel />
      <BackupSection />
      <ScanLogSection />
      <AboutSection />
    </section>
  );
}

/** Einstellungen: Vibration für Scanner & Decks (app-weit, native/feedback.ts) und Farbschema (ui/themes.ts). */
function SettingsSection() {
  const [vibrate, setVibrate] = useState(getVibration());
  const [theme, setTheme] = useState<ThemeKey>(currentTheme());

  function pickTheme(key: ThemeKey) {
    chooseTheme(key);
    setTheme(key);
    hapticTap();
  }

  useEffect(() => {
    void initFeedbackPrefs().then(() => setVibrate(getVibration()));
  }, []);

  function toggle() {
    const next = !vibrate;
    setVibration(next);
    setVibrate(next);
    if (next) hapticTap(); // gleich spüren, dass es wieder an ist
  }

  return (
    <div className="rounded-lg bg-surface p-4">
      <h2 className="mb-3 font-mono text-lg">Einstellungen</h2>
      <div className="flex items-center gap-3">
        <PixelIcon name="vibrate" className={vibrate ? 'text-paper' : 'text-muted'} />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm">Vibration</div>
          <div className="text-xs text-muted">
            Beim Hinzufügen (Scan-Korb, Decks) und beim Antippen. Den Ton regelst du über die Android-Lautstärke.
          </div>
        </div>
        <button onClick={toggle} aria-pressed={vibrate}
          className={`shrink-0 px-3 py-1.5 font-mono text-sm ${vibrate ? 'bg-fill text-paper' : 'bg-bg text-muted'}`}>
          {vibrate ? 'An' : 'Aus'}
        </button>
      </div>

      {/* Farbschema: Vorschau-Kacheln, Auswahl wirkt sofort und wird gemerkt. */}
      <div className="mt-5">
        <div className="mb-2 font-mono text-sm">Farbschema</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {THEMES.map((t) => (
            <button
              key={t.key}
              onClick={() => pickTheme(t.key)}
              aria-pressed={theme === t.key}
              className={`border-2 p-2 text-left font-mono text-xs ${theme === t.key ? 'border-paper text-paper' : 'border-border text-muted'}`}
            >
              <span className="mb-1.5 flex" aria-hidden>
                {t.swatches.map((c) => (
                  <span key={c} className="h-4 flex-1" style={{ background: c }} />
                ))}
              </span>
              {t.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Scanner-Protokoll exportieren (PLAN.md § 5): echte OCR-/Bild-Ergebnisse mit der
 * bestätigten Karte als Ground Truth — die Basis, um Scanner-Schwellen zu tunen.
 */
function ScanLogSection() {
  const [count, setCount] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [diag, setDiag] = useState(false);

  useEffect(() => {
    void db.scans.count().then(setCount);
    void getScanDiag().then(setDiag);
  }, []);

  function toggleDiag(on: boolean) {
    setDiag(on);
    void setScanDiag(on);
  }

  /** `withCrops`: Ausschnitt-Bildchen mitnehmen (nur für „Als Datei" — in der
   *  Zwischenablage wären sie zu lang). */
  async function buildJson(withCrops: boolean): Promise<string | null> {
    const scans = await listScans();
    if (scans.length === 0) {
      setMsg('Noch keine Scans protokolliert.');
      return null;
    }
    const ids = new Set<string>();
    for (const s of scans) {
      if (s.ocrBestOracle) ids.add(s.ocrBestOracle);
      if (s.hashOracle) ids.add(s.hashOracle);
      ids.add(s.chosenOracle);
    }
    const cards = await getCards([...ids]);
    const rows = scans.map((s) => ({
      at: new Date(s.at).toISOString(),
      via: s.via,
      ocrRaw: s.ocrRaw,
      chosen: s.chosenName,
      ocrBest: s.ocrBestOracle ? (cards.get(s.ocrBestOracle)?.name ?? s.ocrBestOracle) : null,
      ocrScore: s.ocrScore,
      ocrMethod: s.ocrMethod,
      ocrCorrect: s.ocrBestOracle ? s.ocrBestOracle === s.chosenOracle : null,
      hashCard: s.hashOracle ? (cards.get(s.hashOracle)?.name ?? s.hashOracle) : null,
      hashDist: s.hashDist,
      hashMargin: s.hashMargin,
      hashCorrect: s.hashOracle ? s.hashOracle === s.chosenOracle : null,
      // Tuning-Signale (Schärfe-Gate, OCR-Sicherheit) + vom Nutzer verworfene Übernahmen.
      sharpness: s.sharpness != null ? Math.round(s.sharpness) : null,
      ocrConf: s.ocrConf != null ? Math.round(s.ocrConf) : null,
      printRead: s.printRead ?? null,
      rejected: s.rejected ?? false,
      // Diagnose (§ 6.2): Abstand zur bestätigten Karte, Abbildung, Ausschnitt.
      hashDistChosen: s.hashDistChosen ?? null,
      cropMap: s.cropMap ?? null,
      cropSnapped: s.cropSnapped ?? null,
      ...(withCrops ? { crop: s.crop ?? null } : { hasCrop: !!s.crop }),
    }));
    return JSON.stringify(rows, null, 2);
  }

  async function copyJson() {
    const json = await buildJson(false);
    if (!json) return;
    const ok = await copyToClipboard(json);
    setMsg(ok ? 'In die Zwischenablage kopiert — schick es mir einfach.' : 'Kopieren fehlgeschlagen — probier „Als Datei".');
  }

  async function exportJson() {
    const json = await buildJson(true);
    if (!json) return;
    await saveFile(`scryglass-scans-${new Date().toISOString().slice(0, 10)}.json`, json);
    setMsg('Als Datei exportiert.');
  }

  return (
    <div className="rounded-lg bg-surface p-4">
      <h2 className="mb-2 font-mono text-lg">Scanner-Protokoll</h2>
      <p className="mb-3 text-xs text-muted">
        Zum Verbessern des Scanners: die App merkt sich pro Scan den gelesenen Text, das
        Bild-Ergebnis und die von dir bestätigte Karte. Kopieren/exportieren und mir schicken —
        daraus tune ich die Erkennung. Keine persönlichen Daten.
      </p>
      <PixelCheckbox checked={diag} onChange={toggleDiag} className="mb-1 font-mono text-sm">
        Diagnose: ausgewerteten Ausschnitt zeigen &amp; mitspeichern
      </PixelCheckbox>
      <p className="mb-3 text-xs text-muted">
        Der Scanner zeigt dann unten rechts, was die Bilderkennung wirklich sieht — grün
        umrandet, wenn die Karte eingerastet ist, gelb, wenn nur der Rahmen zählt. Gespeichert
        wird der Ausschnitt mit Rahmen (gelb) und erkannter Karte (grün), ~10 KB je Scan, nur
        auf dem Gerät. Die Bildchen stecken nur im Export „Als Datei".
      </p>
      <p className="mb-2 font-mono text-xs text-muted">{count ?? '…'} Scans gespeichert.</p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void copyJson()} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">
          In Zwischenablage
        </button>
        <button onClick={() => void exportJson()} className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent">
          Als Datei
        </button>
        <button
          onClick={() => { if (confirm('Scan-Protokoll leeren?')) void clearScans().then(() => { setCount(0); setMsg('Geleert.'); }); }}
          className="rounded border border-border px-3 py-1.5 font-mono text-sm text-muted hover:border-danger hover:text-danger"
        >
          Leeren
        </button>
      </div>
      {msg && <p className="mt-2 font-mono text-xs text-muted">{msg}</p>}
    </div>
  );
}

const nfDe = new Intl.NumberFormat('de-DE');
const dayDe = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** „heute", „gestern", „vor 12 Tagen" (nach Kalendertagen). */
function daysAgo(at: number): string {
  const start = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const d = Math.round((start(Date.now()) - start(at)) / 86_400_000);
  return d <= 0 ? 'heute' : d === 1 ? 'gestern' : `vor ${d} Tagen`;
}

/** „1 Zeile", „1.234 Zeilen". */
function plural(n: number, one: string, many: string): string {
  return `${nfDe.format(n)} ${n === 1 ? one : many}`;
}

function BackupSection() {
  const native = Capacitor.isNativePlatform();
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastSafe = useLiveQuery(() => lastSafeBackup(), []);
  const due = useLiveQuery(() => backupReminder(), []) ?? false;
  // Nach einem Import neu einlesen — dabei entsteht eine automatische Sicherung.
  const [backupTick, setBackupTick] = useState(0);

  async function toDocuments() {
    try {
      const r = await saveBackupToDocuments();
      setMsg(`${r.owned} Bestände + ${r.decks} Decks gesichert: ${r.path}`);
    } catch (e) {
      setMsg(`Sichern fehlgeschlagen: ${(e as Error).message}`);
    }
  }

  async function exportJson() {
    const [owned, decks, precons] = await Promise.all([db.owned.toArray(), db.decks.toArray(), db.ownedPrecons.toArray()]);
    const ok = await saveFile(documentsBackupName(Date.now()), serializeCollection(owned, decks, undefined, await getTokenCount(), precons));
    if (!ok) return;
    await markSafeBackup();
    setMsg(`${owned.length} Bestände + ${decks.length} Decks ${native ? 'geteilt' : 'exportiert'}.`);
  }

  async function exportCsv() {
    const owned = await db.owned.toArray();
    const [cards, prints] = await Promise.all([
      getCards(owned.map((o) => o.oracleId)),
      db.printings.bulkGet(owned.map((o) => o.printingId ?? '')),
    ]);
    // Mit bekannter Ausgabe (gewähltes Artwork, Tokens immer) auch Set + Nummer — sonst
    // wären gleichnamige Tokens („Soldier") beim Import nicht zu unterscheiden.
    const rows: CsvRow[] = owned.map((o, i) => ({
      name: cards.get(o.oracleId)?.name ?? o.oracleId,
      qty: o.qty,
      finish: o.finish,
      lang: prints[i]?.lang ?? 'en',
      setCode: prints[i]?.set,
      collectorNumber: prints[i]?.collectorNumber,
    }));
    await saveFile(`scryglass-collection-${new Date().toISOString().slice(0, 10)}.csv`, toMoxfieldCsv(rows), 'text/csv');
    setMsg(`${rows.length} Zeilen als CSV exportiert (Moxfield/ManaBox).`);
  }

  async function importJson(file: File) {
    try {
      const parsed = parseCollection(await file.text());
      await applyBackup(parsed);
      setMsg(
        `Wiederhergestellt: ${parsed.owned.length} Bestände, ${parsed.decks.length} Decks` +
          (parsed.tokens != null ? `, ${parsed.tokens} Tokens.` : '.'),
      );
    } catch (e) {
      setMsg(e instanceof CollectionImportError ? `Import fehlgeschlagen: ${e.message}` : 'Import fehlgeschlagen.');
    }
  }

  return (
    <div className="rounded-lg bg-surface p-4">
      <h2 className="mb-2 font-mono text-lg">Backup & Export</h2>
      <p className="mb-2 text-xs text-muted">
        {native
          ? 'Die Sammlung liegt nur in der App. „In Dokumente sichern" legt eine Datei in Dokumente/ScryGlass ab — die bleibt auch beim Deinstallieren. Gegen Handy-Verlust: „Backup teilen", z. B. in Drive oder per Mail an dich selbst.'
          : 'Die Sammlung liegt nur in diesem Browser — ein Browser-Reset löscht sie. Regelmäßig sichern.'}
      </p>
      <p className={`mb-3 font-mono text-xs ${due ? 'text-accent' : 'text-muted'}`}>
        Letzte Sicherung außerhalb der App: {lastSafe ? `${dayDe.format(lastSafe)} (${daysAgo(lastSafe)})` : 'noch nie'}
        {due ? ' — Zeit für eine neue.' : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        {native && (
          <button onClick={() => void toDocuments()} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">In Dokumente sichern</button>
        )}
        <button onClick={() => void exportJson()}
          className={native ? 'rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent' : 'rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent'}>
          {native ? 'Backup teilen' : 'JSON-Backup'}
        </button>
        <button onClick={() => void exportCsv()} className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent">CSV-Export</button>
        <button onClick={() => fileRef.current?.click()} className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent">JSON importieren</button>
        <input ref={fileRef} type="file" accept="application/json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ''; }} />
      </div>
      {msg && <p className="mt-2 font-mono text-xs text-muted">{msg}</p>}
      <CsvImportPanel onImported={() => setBackupTick((t) => t + 1)} />
      <AutoBackups key={backupTick} />
    </div>
  );
}

interface CsvPlan {
  source?: string;
  resolved: ResolvedCsv;
  skipped: number;
}

/** Umstieg von ManaBox, Moxfield & Co.: Sammlungs-CSV einlesen, Vorschau zeigen, dann übernehmen. */
function CsvImportPanel({ onImported }: { onImported: () => void }) {
  const native = Capacitor.isNativePlatform();
  const fileRef = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<CsvPlan | null>(null);
  const [withDecks, setWithDecks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function read(file: File) {
    setPlan(null);
    setBusy(true);
    setMsg('Lese Datei …');
    try {
      const parsed = parseCollectionCsv(await file.text());
      setPlan({ source: parsed.source, resolved: await resolveCsvRows(parsed.rows), skipped: parsed.skipped });
      setWithDecks(false);
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof CollectionImportError ? `Import fehlgeschlagen: ${e.message}` : 'Die Datei ließ sich nicht lesen.');
    } finally {
      setBusy(false);
    }
  }

  // ManaBox-Decks und -Listen (oft Wunschlisten) nur auf Wunsch — sie sind nicht sicher Besitz.
  const take = (kind: ImportItem['kind']) => kind === 'collection' || withDecks;
  const items = plan?.resolved.items.filter((i) => take(i.kind)) ?? [];
  const missing = plan?.resolved.unresolved.filter((u) => take(u.kind)) ?? [];
  const cards = items.reduce((n, i) => n + i.qty, 0);
  const extra = plan
    ? [...plan.resolved.items, ...plan.resolved.unresolved].filter((i) => i.kind !== 'collection').reduce((n, i) => n + i.qty, 0)
    : 0;

  async function apply(mode: 'add' | 'replace') {
    const backupNote = native ? ' Der jetzige Stand wird vorher gesichert.' : '';
    if (mode === 'replace' && !window.confirm(`Die ganze Sammlung durch die Datei ersetzen? Decks und Token-Zähler bleiben.${backupNote}`)) return;
    setBusy(true);
    try {
      await applyCsvImport(items, mode);
      setMsg(`${plural(cards, 'Karte', 'Karten')} ${mode === 'replace' ? 'übernommen, die Sammlung ist ersetzt' : 'zur Sammlung hinzugefügt'}.` +
        (native ? ' Der vorige Stand liegt unter „Automatische Sicherungen".' : ''));
      setPlan(null);
      onImported();
    } catch (e) {
      setMsg(`Übernehmen fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t-2 border-border pt-3">
      <h3 className="mb-1 font-hud text-[9px] text-text">VON MANABOX UMSTEIGEN</h3>
      <p className="mb-2 text-[10px] text-muted">
        Sammlung als CSV aus ManaBox, Moxfield oder einer anderen App einlesen. Erkannt wird über
        Scryfall-ID, Set + Nummer oder den Namen (Englisch oder Deutsch). Du siehst erst, was
        erkannt wurde, und entscheidest dann.
      </p>
      <button disabled={busy} onClick={() => fileRef.current?.click()}
        className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent disabled:opacity-40">
        CSV importieren
      </button>
      {/* Ohne accept: Android meldet CSVs mal als text/csv, mal als text/comma-separated-values. */}
      <input ref={fileRef} type="file" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = ''; }} />
      {plan && (
        <div className="mt-3 bg-bg p-3 font-mono text-xs">
          <p className="mb-1 text-text">
            {plan.source ? `${plan.source}-Datei: ` : ''}{plural(cards, 'Karte', 'Karten')} in {plural(items.length, 'Zeile', 'Zeilen')} erkannt.
          </p>
          {missing.length > 0 && (
            <details className="mb-1 text-muted">
              <summary className="cursor-pointer">{plural(missing.length, 'Zeile', 'Zeilen')} nicht gefunden</summary>
              <p className="mt-1">
                {missing.slice(0, 60).map((m) => `${m.qty}× ${m.label}`).join(', ')}{missing.length > 60 ? ' …' : ''}
              </p>
            </details>
          )}
          {plan.skipped > 0 && <p className="mb-1 text-muted">{plural(plan.skipped, 'Zeile', 'Zeilen')} ohne Karte übersprungen.</p>}
          {extra > 0 && (
            <PixelCheckbox checked={withDecks} onChange={setWithDecks} className="my-2">
              Auch {plural(extra, 'Karte', 'Karten')} aus ManaBox-Decks und -Listen übernehmen (Listen sind oft Wunschlisten)
            </PixelCheckbox>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={busy || items.length === 0} onClick={() => void apply('add')}
              className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-40">Zur Sammlung hinzufügen</button>
            <button disabled={busy || items.length === 0} onClick={() => void apply('replace')}
              className="rounded border border-border px-3 py-1.5 text-sm hover:border-danger hover:text-danger disabled:opacity-40">Sammlung ersetzen</button>
            <button disabled={busy} onClick={() => setPlan(null)} className="px-3 py-1.5 text-sm text-muted hover:text-text">Abbrechen</button>
          </div>
        </div>
      )}
      {msg && <p className="mt-2 font-mono text-xs text-muted">{msg}</p>}
    </div>
  );
}

const backupTime = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Automatische Sicherungen vor App-Updates (data/backups, M15) — nur in der App. */
function AutoBackups() {
  const [list, setList] = useState<AutoBackup[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { void listAutoBackups().then(setList); }, []);
  if (!Capacitor.isNativePlatform()) return null;

  async function restore(b: AutoBackup) {
    if (!window.confirm(`Sammlung, Decks und Token-Zähler durch die Sicherung vom ${backupTime.format(b.at)} ersetzen? Der jetzige Stand wird vorher selbst gesichert.`)) return;
    try {
      const r = await restoreAutoBackup(b.name);
      setMsg(`Wiederhergestellt: ${r.owned.length} Bestände, ${r.decks.length} Decks.`);
      setList(await listAutoBackups());
    } catch (e) {
      setMsg(`Wiederherstellen fehlgeschlagen: ${(e as Error).message}`);
    }
  }

  return (
    <div className="mt-4 border-t-2 border-border pt-3">
      <h3 className="mb-1 font-hud text-[9px] text-text">AUTOMATISCHE SICHERUNGEN</h3>
      <p className="mb-2 text-[10px] text-muted">
        Vor jedem App-Update, Import und Wiederherstellen — die letzten drei. Ab Android 11 liegt
        zusätzlich eine Kopie in Dokumente/ScryGlass/Automatisch; zurückholen über „JSON importieren".
      </p>
      {list === null ? null : list.length === 0 ? (
        <p className="font-mono text-xs text-muted">Noch keine.</p>
      ) : (
        <ul className="space-y-1 font-mono text-xs">
          {list.map((b) => (
            <li key={b.name} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-muted">
                {backupTime.format(b.at)} · {b.reason.replace(/^vor-/, 'vor ').replace(/-/g, ' ')}
              </span>
              <button onClick={() => void restore(b)} className="shrink-0 bg-bg px-2 py-1 text-accent hover:text-paper">Wiederherstellen</button>
              <button onClick={() => void shareAutoBackup(b.name).catch(() => {})} className="shrink-0 bg-bg px-2 py-1 text-muted hover:text-paper">Teilen</button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="mt-2 font-mono text-xs text-muted">{msg}</p>}
    </div>
  );
}

function AboutSection() {
  return (
    <div className="rounded-lg bg-surface p-4 text-xs leading-relaxed text-muted">
      <h2 className="mb-2 font-mono text-lg text-text">
        Über ScryGlass <span className="font-hud text-[10px] text-muted">v{APP_VERSION}</span>
      </h2>
      <p className="mb-2">
        Inoffizielles Fan-Projekt. <b>Nicht</b> affiliiert mit oder unterstützt von Wizards of the
        Coast oder Scryfall. Magic: The Gathering und alle zugehörigen Marken sind Eigentum von
        Wizards of the Coast.
      </p>
      <p className="mb-2">
        Kartendaten von <a className="text-accent underline" href="https://scryfall.com" target="_blank" rel="noreferrer">Scryfall</a>.
        Kartenbilder werden zur Laufzeit vom Scryfall-CDN geladen und nur lokal gecacht — nichts wird
        weiterverteilt. Preise sind unverbindliche Richtwerte (Cardmarket in Euro, über
        Scryfall). Keine Cloud, keine Konten, keine Monetarisierung.
      </p>
      <p className="mb-2">
        Kombo-Daten von{' '}
        <a className="text-accent underline" href="https://commanderspellbook.com" target="_blank" rel="noreferrer">Commander Spellbook</a>
        {' '}— danke! Die Sterne sind eine eigene Einstufung von ScryGlass. Rollen im Deck-Check
        (Rampe, Removal …) aus den Community-Tags von{' '}
        <a className="text-accent underline" href="https://tagger.scryfall.com" target="_blank" rel="noreferrer">Scryfall Tagger</a>.
      </p>
      <p className="mb-2">
        Decklisten der Fertigdecks von{' '}
        <a className="text-accent underline" href="https://mtgjson.com" target="_blank" rel="noreferrer">MTGJSON</a>
        {' '}(MIT-Lizenz, © Zach Halpern) — danke!
      </p>
      <p>Quellcode: MIT-Lizenz.</p>
    </div>
  );
}
