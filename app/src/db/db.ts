import Dexie, { type Table } from 'dexie';
import type {
  Card,
  Printing,
  NameEntry,
  TrigramEntry,
  HashEntry,
  ScanLog,
  Owned,
  Deck,
  InboxBasket,
  Finish,
  OwnedSource,
} from '../domain/types';

/**
 * Persistenz via IndexedDB/Dexie (PLAN.md § 3). Kein LocalStorage.
 *
 * Der Katalog (cards/printings/names/trigrams) wird per Sync gefüllt (§ 4) und
 * beim Update nur ge-`bulkPut`t — `owned`/`decks` werden dabei NIE angefasst.
 */

export interface MetaEntry {
  key: string;
  value: unknown;
}

export class ScryGlassDB extends Dexie {
  cards!: Table<Card, string>; // PK: oracleId
  printings!: Table<Printing, string>; // PK: scryfallId
  names!: Table<NameEntry, [string, string, string]>; // PK: [normName+oracleId+lang]
  trigrams!: Table<TrigramEntry, string>; // PK: trigram
  hashes!: Table<HashEntry, string>; // PK: scryfallId (Bild-pHash, Scanner v2)
  scans!: Table<ScanLog, number>; // PK: ++id (Fixture-Sammlung)
  owned!: Table<Owned, number>; // PK: ++id
  decks!: Table<Deck, number>; // PK: ++id
  inbox!: Table<InboxBasket, string>; // PK: basketId
  meta!: Table<MetaEntry, string>; // PK: key

  constructor(name = 'scryglass') {
    super(name);
    // Schema aus PLAN.md § 3. `names` bekommt einen Auto-PK, weil ein normName
    // mehrfach vorkommt (DE+EN, Kollisionen) — Suche läuft über den Index normName.
    this.version(1).stores({
      cards: 'oracleId, normName, cmc, *colorIdentity',
      printings: 'scryfallId, oracleId, set, [set+collectorNumber]',
      // normName ist nicht eindeutig (DE/EN, Kollisionen) → zusammengesetzter
      // natürlicher PK, damit der Katalog-Re-Import idempotent bleibt (§ 4).
      names: '[normName+oracleId+lang], normName, oracleId, lang',
      trigrams: 'trigram',
      owned: '++id, oracleId, printingId, [oracleId+finish]',
      decks: '++id, name, format, updatedAt',
      inbox: 'basketId, receivedAt, status',
      meta: 'key',
    });
    // v2: Bild-Hash-Index fürs Scanner-Matching (Scanner v2, optional befüllt).
    this.version(2).stores({
      hashes: 'scryfallId, oracleId',
    });
    // v3: Scan-Protokoll zum Sammeln echter OCR-/Bild-Fixtures (§ 5).
    this.version(3).stores({
      scans: '++id, at',
    });
  }
}

export const db = new ScryGlassDB();

// --- Meta -------------------------------------------------------------------

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

// --- Sammlung (owned) -------------------------------------------------------
// v1 zählt auf Oracle-Ebene je Finish (PLAN.md § 3). Ein Bestand ist eindeutig
// über [oracleId+finish]; printingId wird mitgeschrieben, sobald bekannt.

/**
 * Ändert den Bestand um `delta` (+ beim Erfassen, − beim Undo). Fällt die Menge
 * auf 0, wird der Eintrag gelöscht. Transaktional gegen parallele Schnell-Erfassung.
 */
export async function addOwned(
  oracleId: string,
  finish: Finish = 'nonfoil',
  delta = 1,
  opts: { printingId?: string; source?: OwnedSource; peerDevice?: string } = {},
): Promise<number> {
  return db.transaction('rw', db.owned, async () => {
    const existing = await db.owned.where('[oracleId+finish]').equals([oracleId, finish]).first();
    const qty = (existing?.qty ?? 0) + delta;
    if (qty <= 0) {
      if (existing?.id != null) await db.owned.delete(existing.id);
      return 0;
    }
    await db.owned.put({
      id: existing?.id,
      oracleId,
      finish,
      qty,
      printingId: opts.printingId ?? existing?.printingId,
      addedAt: existing?.addedAt ?? Date.now(),
      source: opts.source ?? existing?.source ?? 'manual',
      peerDevice: opts.peerDevice ?? existing?.peerDevice,
    });
    return qty;
  });
}

/** Trägt mehrere Bestände auf einmal ein (Scan-Korb-Übernahme, Peer-Import). */
export async function addOwnedBatch(
  items: {
    oracleId: string;
    finish?: Finish;
    qty?: number;
    printingId?: string;
    source?: OwnedSource;
    peerDevice?: string;
  }[],
): Promise<void> {
  await db.transaction('rw', db.owned, async () => {
    for (const it of items) {
      const finish = it.finish ?? 'nonfoil';
      const existing = await db.owned
        .where('[oracleId+finish]')
        .equals([it.oracleId, finish])
        .first();
      await db.owned.put({
        id: existing?.id,
        oracleId: it.oracleId,
        finish,
        qty: (existing?.qty ?? 0) + (it.qty ?? 1),
        printingId: it.printingId ?? existing?.printingId,
        addedAt: existing?.addedAt ?? Date.now(),
        source: it.source ?? existing?.source ?? 'manual',
        peerDevice: it.peerDevice ?? existing?.peerDevice,
      });
    }
  });
}

/** Merkt die gewählte Druckausgabe (Artwork) für alle Bestände einer Karte —
 *  damit Sammlung/Detail dieses Artwork anzeigen (PLAN.md § 3, printingId). */
export async function setOwnedPrinting(oracleId: string, printingId: string): Promise<void> {
  await db.transaction('rw', db.owned, async () => {
    const rows = await db.owned.where('oracleId').equals(oracleId).toArray();
    for (const r of rows) if (r.id != null) await db.owned.update(r.id, { printingId });
  });
}

/** Ersetzt die komplette Sammlung (für Import/Restore aus dem Backup). */
export async function replaceOwned(entries: Owned[]): Promise<void> {
  await db.transaction('rw', db.owned, async () => {
    await db.owned.clear();
    if (entries.length > 0) await db.owned.bulkPut(entries.map(({ id: _id, ...e }) => e as Owned));
  });
}

// --- Decks ------------------------------------------------------------------

export async function listDecks(): Promise<Deck[]> {
  const all = await db.decks.toArray();
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveDeck(deck: Deck): Promise<number> {
  const id = await db.decks.put({ ...deck, updatedAt: Date.now() });
  return id;
}

export async function deleteDeck(id: number): Promise<void> {
  await db.decks.delete(id);
}

// --- Eingang (inbox, Peer-Scanning) -----------------------------------------

/** Legt einen empfangenen Korb ab; dedupliziert nach basketId (idempotent, § 8). */
export async function putInboxBasket(basket: InboxBasket): Promise<boolean> {
  return db.transaction('rw', db.inbox, async () => {
    const existing = await db.inbox.get(basket.basketId);
    if (existing) return false; // schon da — kein Doppel-Bestand
    await db.inbox.put(basket);
    return true;
  });
}

export async function listInbox(): Promise<InboxBasket[]> {
  const all = await db.inbox.toArray();
  return all.sort((a, b) => b.receivedAt - a.receivedAt);
}

export async function setInboxStatus(
  basketId: string,
  status: InboxBasket['status'],
): Promise<void> {
  const b = await db.inbox.get(basketId);
  if (b) await db.inbox.put({ ...b, status });
}

export async function deleteInbox(basketId: string): Promise<void> {
  await db.inbox.delete(basketId);
}

// --- Scan-Protokoll (Fixture-Sammlung, § 5) ---------------------------------

/** Protokolliert einen Scan; gibt die id zurück (für ein späteres Rückgängig). */
export async function logScan(entry: Omit<ScanLog, 'id'>): Promise<number | undefined> {
  try {
    const id = await db.scans.add(entry as ScanLog);
    // Nicht unbegrenzt wachsen lassen — die ältesten über 2000 kappen.
    const n = await db.scans.count();
    if (n > 2000) {
      const old = await db.scans.orderBy('at').limit(n - 2000).primaryKeys();
      await db.scans.bulkDelete(old);
    }
    return id;
  } catch {
    /* Protokoll ist best-effort — darf den Scan nie stören. */
    return undefined;
  }
}

/** Rückgängig gemachte Übernahme als Fehltreffer markieren (bleibt als Tuning-Signal). */
export async function markScanRejected(id: number): Promise<void> {
  try {
    await db.scans.update(id, { rejected: true });
  } catch {
    /* best-effort */
  }
}

export async function listScans(): Promise<ScanLog[]> {
  return db.scans.orderBy('at').reverse().toArray();
}

export async function clearScans(): Promise<void> {
  await db.scans.clear();
}
