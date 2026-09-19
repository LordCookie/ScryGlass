import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { db, replaceOwned, saveDeck, listScans, clearScans } from '../db/db';
import { serializeCollection, parseCollection, CollectionImportError } from '../domain/collectionIo';
import { toMoxfieldCsv, type CsvRow } from '../domain/collectionCsv';
import { getCards } from '../data/cards';
import { fetchRemoteVersion, applyUpdate, getLocalCatalogVersion, type CatalogVersion, type SyncProgress } from '../data/catalog';
import { invalidateNameIndex } from '../data/matcher';

/** „Mehr": Backup/Export, Katalog-Update, Rechtliches (PLAN.md § 5, § 4, § 12). */

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
      <BackupSection />
      <CatalogSection />
      <ScanLogSection />
      <AboutSection />
    </section>
  );
}

/**
 * Scanner-Protokoll exportieren (PLAN.md § 5): echte OCR-/Bild-Ergebnisse mit der
 * bestätigten Karte als Ground Truth — die Basis, um Scanner-Schwellen zu tunen.
 */
function ScanLogSection() {
  const [count, setCount] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void db.scans.count().then(setCount);
  }, []);

  async function buildJson(): Promise<string | null> {
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
    }));
    return JSON.stringify(rows, null, 2);
  }

  async function copyJson() {
    const json = await buildJson();
    if (!json) return;
    const ok = await copyToClipboard(json);
    setMsg(ok ? 'In die Zwischenablage kopiert — schick es mir einfach.' : 'Kopieren fehlgeschlagen — probier „Als Datei".');
  }

  async function exportJson() {
    const json = await buildJson();
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
        daraus tune ich die Erkennung. Keine Bilder, keine persönlichen Daten.
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

function BackupSection() {
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function exportJson() {
    const [owned, decks] = await Promise.all([db.owned.toArray(), db.decks.toArray()]);
    await saveFile(`scryglass-backup-${new Date().toISOString().slice(0, 10)}.json`, serializeCollection(owned, decks));
    setMsg(`${owned.length} Bestände + ${decks.length} Decks exportiert.`);
  }

  async function exportCsv() {
    const owned = await db.owned.toArray();
    const cards = await getCards(owned.map((o) => o.oracleId));
    const rows: CsvRow[] = owned.map((o) => ({
      name: cards.get(o.oracleId)?.name ?? o.oracleId,
      qty: o.qty,
      finish: o.finish,
      lang: 'en',
    }));
    await saveFile(`scryglass-collection-${new Date().toISOString().slice(0, 10)}.csv`, toMoxfieldCsv(rows), 'text/csv');
    setMsg(`${rows.length} Zeilen als CSV exportiert (Moxfield/ManaBox).`);
  }

  async function importJson(file: File) {
    try {
      const parsed = parseCollection(await file.text());
      await replaceOwned(parsed.owned);
      for (const d of parsed.decks) await saveDeck(d);
      setMsg(`Wiederhergestellt: ${parsed.owned.length} Bestände, ${parsed.decks.length} Decks.`);
    } catch (e) {
      setMsg(e instanceof CollectionImportError ? `Import fehlgeschlagen: ${e.message}` : 'Import fehlgeschlagen.');
    }
  }

  return (
    <div className="rounded-lg bg-surface p-4">
      <h2 className="mb-2 font-mono text-lg">Backup & Export</h2>
      <p className="mb-3 text-xs text-muted">IndexedDB kann ein Browser-Reset löschen — regelmäßig sichern.</p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void exportJson()} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">JSON-Backup</button>
        <button onClick={() => void exportCsv()} className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent">CSV-Export</button>
        <button onClick={() => fileRef.current?.click()} className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent">JSON importieren</button>
        <input ref={fileRef} type="file" accept="application/json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ''; }} />
      </div>
      {msg && <p className="mt-2 font-mono text-xs text-muted">{msg}</p>}
    </div>
  );
}

function CatalogSection() {
  const [local, setLocal] = useState<string | undefined>();
  const [check, setCheck] = useState<'idle' | 'loading' | 'done'>('idle');
  const [remote, setRemote] = useState<CatalogVersion | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [cardCount, setCardCount] = useState<number>(0);

  useEffect(() => {
    void getLocalCatalogVersion().then(setLocal);
    void db.cards.count().then(setCardCount);
  }, []);

  async function doCheck() {
    setCheck('loading');
    setRemote(await fetchRemoteVersion());
    setCheck('done');
  }
  async function doUpdate() {
    if (!remote) return;
    await applyUpdate(remote, { onProgress: setProgress });
    invalidateNameIndex();
    setLocal(remote.catalogVersion);
    setRemote(null);
    setCheck('idle');
    setProgress(null);
    setCardCount(await db.cards.count());
  }

  const hasUpdate = check === 'done' && remote != null && remote.catalogVersion !== local;

  return (
    <div className="rounded-lg bg-surface p-4">
      <h2 className="mb-2 font-mono text-lg">Katalog</h2>
      <p className="mb-2 font-mono text-xs text-muted">Version: {local ?? '—'} · {cardCount} Karten lokal</p>
      {progress ? (
        <p className="font-mono text-xs text-accent">Import {progress.phase}: {progress.overallDone}/{progress.overallTotal}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void doCheck()} className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent">
            Auf Update prüfen
          </button>
          {hasUpdate && (
            <button onClick={() => void doUpdate()} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">
              Update laden ({remote?.catalogVersion})
            </button>
          )}
        </div>
      )}
      {check === 'loading' && <p className="mt-2 font-mono text-xs text-muted">Prüfe…</p>}
      {check === 'done' && remote == null && <p className="mt-2 font-mono text-xs text-muted">Kein Netz / kein Katalog erreichbar.</p>}
      {check === 'done' && remote != null && !hasUpdate && <p className="mt-2 font-mono text-xs text-ok">Aktuell.</p>}
    </div>
  );
}

function AboutSection() {
  return (
    <div className="rounded-lg bg-surface p-4 text-xs leading-relaxed text-muted">
      <h2 className="mb-2 font-mono text-lg text-text">Über ScryGlass</h2>
      <p className="mb-2">
        Inoffizielles Fan-Projekt. <b>Nicht</b> affiliiert mit oder unterstützt von Wizards of the
        Coast oder Scryfall. Magic: The Gathering und alle zugehörigen Marken sind Eigentum von
        Wizards of the Coast.
      </p>
      <p className="mb-2">
        Kartendaten von <a className="text-accent underline" href="https://scryfall.com" target="_blank" rel="noreferrer">Scryfall</a>.
        Kartenbilder werden zur Laufzeit vom Scryfall-CDN geladen und nur lokal gecacht — nichts wird
        weiterverteilt. Keine Preise, keine Cloud, keine Konten, keine Monetarisierung.
      </p>
      <p>Quellcode: MIT-Lizenz.</p>
    </div>
  );
}
