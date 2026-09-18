import { useEffect, useRef, useState } from 'react';
import { db, replaceOwned, saveDeck } from '../db/db';
import { serializeCollection, parseCollection, CollectionImportError } from '../domain/collectionIo';
import { toMoxfieldCsv, type CsvRow } from '../domain/collectionCsv';
import { getCards } from '../data/cards';
import { fetchRemoteVersion, applyUpdate, getLocalCatalogVersion, type CatalogVersion, type SyncProgress } from '../data/catalog';
import { invalidateNameIndex } from '../data/matcher';

/** „Mehr": Backup/Export, Katalog-Update, Rechtliches (PLAN.md § 5, § 4, § 12). */

function download(filename: string, content: string, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function MorePanel() {
  return (
    <section className="space-y-3">
      <BackupSection />
      <CatalogSection />
      <AboutSection />
    </section>
  );
}

function BackupSection() {
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function exportJson() {
    const [owned, decks] = await Promise.all([db.owned.toArray(), db.decks.toArray()]);
    download(`scryglass-backup-${new Date().toISOString().slice(0, 10)}.json`, serializeCollection(owned, decks));
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
    download(`scryglass-collection-${new Date().toISOString().slice(0, 10)}.csv`, toMoxfieldCsv(rows), 'text/csv');
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
