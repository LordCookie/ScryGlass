import { db, addOwnedBatch, whereAnyOf } from '../db/db';
import type { Finish } from '../domain/types';
import type { CsvImportRow } from '../domain/collectionCsv';
import { normalizeName } from '../domain/nameMatch';
import { isTokenCard } from '../domain/tokens';
import { findPrinting } from './printingLookup';
import { autoBackup } from './backups';

/**
 * Sammlungs-CSV (ManaBox, Moxfield …) auf den Katalog auflösen und übernehmen.
 * Reihenfolge je Zeile: Scryfall-ID → Set + Sammlernummer → Name (EN oder DE).
 * Fremdsprachige Ausgaben (ja, fr …) hat der Katalog nicht — die landen über
 * Set + Nummer bei der englischen Ausgabe, sonst über den Namen.
 */

export interface ImportItem {
  oracleId: string;
  finish: Finish;
  qty: number;
  printingId?: string;
  kind: CsvImportRow['kind'];
}

export interface ResolvedCsv {
  items: ImportItem[];
  /** Nicht gefundene Zeilen (Name bzw. Set/Nummer) — zur Anzeige. */
  unresolved: { label: string; qty: number; kind: CsvImportRow['kind'] }[];
}

export async function resolveCsvRows(rows: readonly CsvImportRow[]): Promise<ResolvedCsv> {
  const hit: ({ oracleId: string; printingId?: string } | undefined)[] = new Array(rows.length);

  // 1) Scryfall-ID — ein einziger bulkGet für alle Zeilen.
  const ids = rows.map((r) => r.scryfallId ?? '');
  const prints = await db.printings.bulkGet(ids);
  prints.forEach((p, i) => {
    if (p && rows[i].scryfallId) hit[i] = { oracleId: p.oracleId, printingId: p.scryfallId };
  });

  // 2) Set + Sammlernummer (bevorzugt die Sprache der Zeile, sonst Englisch).
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (hit[i] || !r.setCode || !r.collectorNumber) continue;
    const p = await findPrinting(r.setCode, r.collectorNumber, r.lang);
    if (p) hit[i] = { oracleId: p.oracleId, printingId: p.scryfallId };
  }

  // 3) Name über den Namensindex (EN + DE), dann Karten-Namen (Tokens stehen nur dort).
  const open = rows.map((r, i) => (hit[i] ? '' : normalizeName(r.name))).filter(Boolean);
  if (open.length > 0) {
    const byName = new Map<string, string>();
    for (const n of await whereAnyOf(db.names, 'normName', open)) {
      if (!byName.has(n.normName)) byName.set(n.normName, n.oracleId);
    }
    const rest = open.filter((n) => !byName.has(n));
    // Echte Karte vor gleichnamigem Token („Treasure" als Karte gibt es nicht, „Soldier" schon).
    for (const c of (await whereAnyOf(db.cards, 'normName', rest)).sort((a, b) => Number(isTokenCard(a)) - Number(isTokenCard(b)))) {
      if (!byName.has(c.normName)) byName.set(c.normName, c.oracleId);
    }
    rows.forEach((r, i) => {
      const id = hit[i] ? undefined : byName.get(normalizeName(r.name));
      if (id) hit[i] = { oracleId: id };
    });
  }

  const items: ImportItem[] = [];
  const unresolved: ResolvedCsv['unresolved'] = [];
  rows.forEach((r, i) => {
    const h = hit[i];
    if (h) items.push({ ...h, finish: r.finish, qty: r.qty, kind: r.kind });
    else {
      const label = r.name || [r.setCode?.toUpperCase(), r.collectorNumber].filter(Boolean).join(' ') || r.scryfallId || '?';
      unresolved.push({ label, qty: r.qty, kind: r.kind });
    }
  });
  return { items, unresolved };
}

/**
 * Übernehmen — vorher sichern (App). `replace` leert die Sammlung erst; Decks und
 * Token-Zähler bleiben. Gleiche Karten werden wie beim Scannen zusammengezählt.
 */
export async function applyCsvImport(items: readonly ImportItem[], mode: 'add' | 'replace'): Promise<void> {
  await autoBackup(mode === 'replace' ? 'vor-csv-ersetzen' : 'vor-csv-import');
  await db.transaction('rw', db.owned, db.cards, async () => {
    if (mode === 'replace') await db.owned.clear();
    // Ohne `source`: vorhandene Bestände behalten ihre Herkunft, neue zählen als „manual".
    await addOwnedBatch(items.map(({ oracleId, finish, qty, printingId }) => ({ oracleId, finish, qty, printingId })));
  });
}
