import Dexie, { type Table } from 'dexie';
import type {
  Card,
  Printing,
  NameEntry,
  HashEntry,
  ScanLog,
  Owned,
  Deck,
  InboxBasket,
  Finish,
  OwnedSource,
  OwnedBooking,
  Precon,
  OwnedPrecon,
} from '../domain/types';
import type { PriceEntry } from '../domain/prices';
import { inverseOps, type DeckHistoryEntry } from '../domain/deckHistory';
import type { ValueSnapshot } from '../domain/valueHistory';
import { isTokenCard } from '../domain/tokens';
import { applyDeckOp, type DeckOp } from '../domain/deckOps';
import { changeFeedMiddleware } from './changeFeed';

/**
 * Persistenz via IndexedDB/Dexie (PLAN.md § 3). Kein LocalStorage.
 *
 * Der Katalog (cards/printings/names) wird per Sync gefüllt (§ 4) und beim Update
 * nur ergänzt/überschrieben — `owned`/`decks` werden dabei NIE angefasst.
 */

export interface MetaEntry {
  key: string;
  value: unknown;
}

export class ScryGlassDB extends Dexie {
  cards!: Table<Card, string>; // PK: oracleId
  printings!: Table<Printing, string>; // PK: scryfallId
  names!: Table<NameEntry, [string, string, string]>; // PK: [normName+oracleId+lang]
  hashes!: Table<HashEntry, string>; // PK: scryfallId (Bild-pHash, Scanner v2)
  scans!: Table<ScanLog, number>; // PK: ++id (Fixture-Sammlung)
  prices!: Table<PriceEntry, string>; // PK: key (Ausgabe oder „oracle:…")
  owned!: Table<Owned, number>; // PK: ++id
  decks!: Table<Deck, number>; // PK: ++id
  inbox!: Table<InboxBasket, string>; // PK: basketId
  precons!: Table<Precon, string>; // PK: key (Fertigdecks, Katalogdaten — M19)
  ownedPrecons!: Table<OwnedPrecon, number>; // PK: ++id (übernommene Fertigdecks)
  deckHistory!: Table<DeckHistoryEntry, number>; // PK: ++id (Deck-Verlauf, M22)
  valueHistory!: Table<ValueSnapshot, string>; // PK: day (Wert-Verlauf, M22)
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
    // v4: Preise (live von Scryfall, mit Zeitstempel gecacht — offline der letzte Stand).
    this.version(4).stores({
      prices: 'key, at',
    });
    // v5: Layout-Index — Tokens/Embleme schnell finden (Großes Token-Update, M14).
    this.version(5).stores({
      cards: 'oracleId, normName, cmc, *colorIdentity, layout',
    });
    // v6: Trigramm-Tabelle weg — der Namensindex baut die Trigramme selbst im RAM
    // (domain/nameMatch, 0.2.7). Gibt ~34 MB frei.
    this.version(6).stores({
      trigrams: null,
    });
    // v7: Fertigdecks (M19) — Katalogliste aus MTGJSON und die übernommenen.
    this.version(7).stores({
      precons: 'key, group, date',
      ownedPrecons: '++id, key, addedAt',
    });
    // v8 (M22): Deck-Verlauf (jede Änderung mit dem Weg zurück) und Wert-Verlauf (je Tag).
    this.version(8).stores({
      deckHistory: '++id, deckId, at',
      valueHistory: 'day',
    });
  }
}

export const db = new ScryGlassDB();
// Änderungen an Sammlung, Decks & Co. melden (Big Screen, M18) — ohne Zuhörer ohne Kosten.
db.use(changeFeedMiddleware);

// --- Big Screen: Schreib-Gateway (PLAN.md M18) ---------------------------------
// Im Browser (Fernbetrieb) schreibt nur das Handy. Ist ein Gateway gesetzt, gehen alle
// Schreibfunktionen für Sammlung, Decks, Tokens und Fertigdecks als Auftrag ans Handy;
// das führt dieselbe Funktion aus und meldet die Änderung zurück. Am Handy: kein Gateway.

export type WriteGateway = (op: string, args: unknown[]) => Promise<unknown>;
let gateway: WriteGateway | null = null;

export function setWriteGateway(g: WriteGateway | null): void {
  gateway = g;
}

export function writeGateway(): WriteGateway | null {
  return gateway;
}

// --- Meta -------------------------------------------------------------------

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

// --- Viele Schlüssel auf einmal ---------------------------------------------

/**
 * Alle Zeilen zu vielen Schlüsseln eines Index — statt `where(index).anyOf(keys)`.
 * Dexie springt bei `anyOf` per Cursor von Schlüssel zu Schlüssel, jeder Sprung ist ein
 * eigener Umlauf: 400 verstreute Karten brauchten im Browser 7 s. Hier läuft je Schlüssel
 * eine `equals`-Abfrage (ein einziges getAll), alle parallel in EINER Lesetransaktion.
 * Reihenfolge wie bei `anyOf`: aufsteigend nach Schlüssel, darin nach Primärschlüssel.
 */
export function whereAnyOf<T, K>(table: Table<T, K>, index: string, keys: readonly string[]): Promise<T[]> {
  const uniq = [...new Set(keys)].sort();
  if (uniq.length === 0) return Promise.resolve([]);
  return db.transaction('r', table, async () =>
    (await Promise.all(uniq.map((k) => table.where(index).equals(k).toArray()))).flat(),
  );
}

// --- Sammlung (owned) -------------------------------------------------------
// v1 zählt auf Oracle-Ebene je Finish (PLAN.md § 3). Ein Bestand ist eindeutig
// über [oracleId+finish]; printingId wird mitgeschrieben, sobald bekannt.
// Ausnahme Tokens (M14): die zählen je Artwork, also über [oracleId+finish+printingId].

/** Bestandszeile zu einer Karte bzw. (Token) zu genau dieser Druckausgabe. */
async function findOwned(oracleId: string, finish: Finish, printingId: string | undefined): Promise<Owned | undefined> {
  const rows = db.owned.where('[oracleId+finish]').equals([oracleId, finish]);
  if (!isTokenCard(await db.cards.get(oracleId))) return rows.first();
  return rows.filter((r) => r.printingId === printingId).first();
}

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
  if (gateway) return gateway('addOwned', [oracleId, finish, delta, opts]) as Promise<number>;
  return db.transaction('rw', db.owned, db.cards, async () => {
    const existing = await findOwned(oracleId, finish, opts.printingId);
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

/** Trägt mehrere Bestände auf einmal ein (Scan-Korb-Übernahme, Peer-Import, Fertigdecks).
 *  `keepExisting`: Artwork und Herkunft vorhandener Bestände bleiben, Ausgabe und Quelle
 *  gelten nur für neue Karten (Fertigdecks bringen ihre eigene Ausgabe mit, M19). */
export async function addOwnedBatch(
  items: {
    oracleId: string;
    finish?: Finish;
    qty?: number;
    printingId?: string;
    source?: OwnedSource;
    peerDevice?: string;
  }[],
  opts: { keepExisting?: boolean } = {},
): Promise<void> {
  if (gateway) {
    await gateway('addOwnedBatch', [items, opts]);
    return;
  }
  await db.transaction('rw', db.owned, db.cards, async () => {
    for (const it of items) {
      const finish = it.finish ?? 'nonfoil';
      const existing = await findOwned(it.oracleId, finish, it.printingId);
      await db.owned.put({
        id: existing?.id,
        oracleId: it.oracleId,
        finish,
        qty: (existing?.qty ?? 0) + (it.qty ?? 1),
        printingId: opts.keepExisting ? existing?.printingId ?? it.printingId : it.printingId ?? existing?.printingId,
        addedAt: existing?.addedAt ?? Date.now(),
        source: (opts.keepExisting ? existing?.source ?? it.source : it.source ?? existing?.source) ?? 'manual',
        peerDevice: it.peerDevice ?? existing?.peerDevice,
      });
    }
  });
}

/** Zieht mehrere Bestände ab (Fertigdeck wieder entfernen, M19) — nie unter 0, bei 0
 *  verschwindet die Zeile. Gibt zurück, wie viele Karten wirklich abgezogen wurden. */
export async function removeOwnedBatch(items: readonly OwnedBooking[]): Promise<number> {
  if (gateway) return gateway('removeOwnedBatch', [items]) as Promise<number>;
  return db.transaction('rw', db.owned, db.cards, async () => {
    let removed = 0;
    for (const it of items) {
      const existing = await findOwned(it.oracleId, it.finish, it.printingId);
      if (!existing?.id) continue;
      const n = Math.min(existing.qty, it.qty);
      removed += n;
      if (existing.qty - n <= 0) await db.owned.delete(existing.id);
      else await db.owned.update(existing.id, { qty: existing.qty - n });
    }
    return removed;
  });
}

/** Bestandszeile, auf die eine Buchung fällt — als Schlüssel (Karten je Karte + Ausführung,
 *  Tokens je Artwork). Für die Vorschau beim Entfernen. */
export async function ownedRowKeys(items: readonly OwnedBooking[]): Promise<{ key: (b: OwnedBooking) => string; have: Map<string, number> }> {
  const ids = [...new Set(items.map((b) => b.oracleId))];
  const [cards, rows] = await Promise.all([db.cards.bulkGet(ids), whereAnyOf(db.owned, 'oracleId', ids)]);
  const token = new Set(cards.filter((c) => isTokenCard(c)).map((c) => c!.oracleId));
  const key = (b: Pick<OwnedBooking, 'oracleId' | 'finish' | 'printingId'>) =>
    token.has(b.oracleId) ? `${b.oracleId}|${b.finish}|${b.printingId ?? ''}` : `${b.oracleId}|${b.finish}`;
  const have = new Map<string, number>();
  for (const r of rows) have.set(key(r), (have.get(key(r)) ?? 0) + r.qty);
  return { key, have };
}

/** Merkt die gewählte Druckausgabe (Artwork) für alle Bestände einer Karte —
 *  damit Sammlung/Detail dieses Artwork anzeigen (PLAN.md § 3, printingId).
 *  Nicht für Tokens: dort IST die Ausgabe der Bestand (je Artwork gezählt). */
export async function setOwnedPrinting(oracleId: string, printingId: string): Promise<void> {
  if (gateway) {
    await gateway('setOwnedPrinting', [oracleId, printingId]);
    return;
  }
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

/** Ganzes Deck speichern — nur für Wiederherstellen; Änderungen laufen über `changeDeck`. */
export async function saveDeck(deck: Deck): Promise<number> {
  if (gateway) return gateway('saveDeck', [deck]) as Promise<number>;
  const id = await db.decks.put({ ...deck, updatedAt: Date.now() });
  return id;
}

/** Neues Deck anlegen; gibt die ID zurück. */
export async function createDeck(deck: Omit<Deck, 'id'>): Promise<number> {
  if (gateway) return gateway('createDeck', [deck]) as Promise<number>;
  const { id: _id, ...rest } = deck as Deck;
  return db.decks.add({ ...rest, updatedAt: Date.now() });
}

/** Einen Schritt auf den aktuellen Stand des Decks anwenden (M18) — keine verlorenen Änderungen,
 *  wenn Handy und Browser dasselbe Deck bearbeiten. Gelöschtes Deck → Fehler. */
export async function changeDeck(id: number, op: DeckOp): Promise<void> {
  if (gateway) {
    await gateway('changeDeck', [id, op]);
    return;
  }
  await db.transaction('rw', db.decks, db.deckHistory, async () => {
    const deck = await db.decks.get(id);
    if (!deck) throw new Error('Das Deck gibt es nicht mehr — vielleicht am Handy gelöscht.');
    await db.decks.put(applyDeckOp(deck, op));
    // Deck-Verlauf (M22): was geändert wurde und wie es zurückgeht.
    const undo = inverseOps(deck, op);
    if (undo.length) await db.deckHistory.add({ deckId: id, at: Date.now(), op, undo });
  });
}

export async function deleteDeck(id: number): Promise<void> {
  if (gateway) {
    await gateway('deleteDeck', [id]);
    return;
  }
  await db.transaction('rw', db.decks, db.deckHistory, async () => {
    await db.decks.delete(id);
    await db.deckHistory.where('deckId').equals(id).delete();
  });
}

/** Wert der Sammlung für heute merken (M22) — ein Eintrag je Tag, der letzte gilt. */
export async function recordValue(snap: ValueSnapshot): Promise<void> {
  if (gateway) {
    await gateway('recordValue', [snap]);
    return;
  }
  await db.valueHistory.put(snap);
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
