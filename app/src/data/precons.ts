import {
  db, getMeta, setMeta, whereAnyOf, addOwnedBatch, removeOwnedBatch, ownedRowKeys, createDeck, deleteDeck, writeGateway,
} from '../db/db';
import { NdjsonBuffer } from './ndjson';
import {
  parsePreconRow, preconSearchText, preconBookings, deckFromPrecon, planRemoval,
  type PreconHead, type PreconRow, type PrintingInfo,
} from '../domain/precons';
import type { Card, OwnedPrecon, Precon } from '../domain/types';
import { isTokenCard } from '../domain/tokens';
import { getCards } from './cards';
import { autoBackup } from './backups';

/**
 * Fertigdecks (M19): `precons.ndjson` aus dem Katalog in die Tabelle `precons` einspielen
 * (einmal je Katalogstand, wie die Kombos) und Fertigdecks in die Sammlung buchen oder
 * wieder herausnehmen. Daten von MTGJSON.
 */

const VERSION_KEY = 'preconsVersion';
export const PRECONS_META_KEY = 'preconsMeta';

export async function hasPreconData(): Promise<boolean> {
  return (await db.precons.count()) > 0;
}

async function readPrecons(url: string, gzip: boolean, onProgress?: (done: number) => void): Promise<{ head: PreconHead; rows: PreconRow[] }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Fertigdecks nicht gefunden (${res.status})`);
  const reader = (gzip ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body).getReader();
  const decoder = new TextDecoder();
  const buf = new NdjsonBuffer<PreconHead | PreconRow>();
  let head: PreconHead | null = null;
  const rows: PreconRow[] = [];
  const take = (items: (PreconHead | PreconRow)[]) => {
    for (const it of items) {
      if (!head) {
        if (Array.isArray(it) || !('printings' in it)) throw new Error('Fertigdeck-Datei ohne Kopf');
        head = it;
      } else rows.push(it as PreconRow);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    take(buf.push(decoder.decode(value, { stream: true })));
    onProgress?.(rows.length);
  }
  take(buf.flush());
  if (!head) throw new Error('Fertigdeck-Datei leer');
  return { head, rows };
}

/** Einmal je Katalogstand, best effort. Fehlt die Datei (älterer Katalog), bleibt alles, wie es ist. */
export async function syncPrecons(
  base: string,
  catalogVersion: string | undefined,
  onProgress?: (done: number) => void,
  gzip = false,
): Promise<'imported' | 'skipped' | 'absent'> {
  if (catalogVersion && (await getMeta<string>(VERSION_KEY)) === catalogVersion && (await hasPreconData())) return 'skipped';
  let file: { head: PreconHead; rows: PreconRow[] };
  try {
    file = await readPrecons(`${base}/precons.ndjson${gzip ? '.gz' : ''}`, gzip, onProgress);
  } catch {
    return 'absent';
  }
  const parsed = file.rows.map((r) => parsePreconRow(file.head, r));

  // Commander-Namen (EN + DE) in den Suchtext — man sucht ein Deck oft nach seinem Commander.
  const cmdPrintings = [...new Set(parsed.flatMap((p) => p.commander.map((c) => c.p)))];
  const prints = await db.printings.bulkGet(cmdPrintings);
  const oracleOf = new Map<string, string>();
  for (const p of prints) if (p) oracleOf.set(p.scryfallId, p.oracleId);
  const oids = [...new Set(oracleOf.values())];
  const [cards, names] = await Promise.all([db.cards.bulkGet(oids), whereAnyOf(db.names, 'oracleId', oids)]);
  const namesOf = new Map<string, string[]>();
  const push = (id: string, n: string) => namesOf.set(id, [...(namesOf.get(id) ?? []), n]);
  for (const c of cards) if (c) push(c.oracleId, c.name);
  for (const n of names) if (n.lang === 'de') push(n.oracleId, n.normName);

  const rows: Precon[] = parsed.map((p) => ({
    ...p,
    search: preconSearchText(p, p.commander.flatMap((c) => namesOf.get(oracleOf.get(c.p) ?? '') ?? [])),
  }));
  await db.transaction('rw', db.precons, async () => {
    await db.precons.clear();
    await db.precons.bulkPut(rows);
  });
  await setMeta(PRECONS_META_KEY, file.head.meta);
  if (catalogVersion) await setMeta(VERSION_KEY, catalogVersion);
  return 'imported';
}

/** Alle Fertigdecks, neueste zuerst. */
export async function listPrecons(): Promise<Precon[]> {
  return (await db.precons.orderBy('date').reverse().toArray());
}

/** Übernommene Fertigdecks, zuletzt hinzugefügte zuerst. */
export async function listOwnedPrecons(): Promise<OwnedPrecon[]> {
  return (await db.ownedPrecons.orderBy('addedAt').reverse().toArray());
}

export interface PreconDetails {
  /** Druckausgabe → Karte (oracleId, Token ja/nein) */
  printings: Map<string, PrintingInfo>;
  /** oracleId → Karte, für Namen, Typen und Manakosten */
  cards: Map<string, Card>;
}

/** Druckausgaben und Karten eines Fertigdecks aus dem Katalog nachschlagen. */
export async function preconDetails(p: Precon): Promise<PreconDetails> {
  const ids = [...new Set([...p.commander, ...p.main, ...p.side, ...p.extra, ...p.tokens].map((c) => c.p))];
  const prints = await db.printings.bulkGet(ids);
  const oracleIds = [...new Set(prints.filter((x) => !!x).map((x) => x!.oracleId))];
  const cards = await getCards(oracleIds);
  const printings = new Map<string, PrintingInfo>();
  for (const pr of prints) if (pr) printings.set(pr.scryfallId, { oracleId: pr.oracleId, token: isTokenCard(cards.get(pr.oracleId)) });
  return { printings, cards };
}

export interface AddPreconResult {
  cards: number;
  tokens: number;
  unknown: number;
  deckId?: number;
  extraCommanders: number;
}

/**
 * Fertigdeck in die Sammlung: vorher eine automatische Sicherung (wie beim CSV-Import),
 * dann alles in einem Rutsch buchen; ein schon gewähltes Artwork bleibt. Auf Wunsch gleich
 * als Deck anlegen. Gemerkt wird genau das Gebuchte — fürs Wieder-Entfernen.
 */
export async function addPreconToCollection(
  p: Precon,
  opts: { copies: number; withTokens: boolean; createDeck: boolean },
): Promise<AddPreconResult> {
  const gw = writeGateway();
  if (gw) return gw('addPrecon', [p.key, opts]) as Promise<AddPreconResult>;
  const { printings } = await preconDetails(p);
  const booking = preconBookings(p, printings, opts);
  await autoBackup('vor-fertigdeck').catch(() => null);
  await addOwnedBatch(booking.items.map((b) => ({ ...b, source: 'precon' as const })), { keepExisting: true });
  let deckId: number | undefined;
  let extraCommanders = 0;
  if (opts.createDeck) {
    const made = deckFromPrecon(p, printings);
    deckId = await createDeck(made.deck);
    extraCommanders = made.extraCommanders;
  }
  await db.ownedPrecons.add({
    key: p.key,
    name: p.name,
    set: p.set,
    addedAt: Date.now(),
    copies: opts.copies,
    ...(deckId != null ? { deckId } : {}),
    items: booking.items,
  });
  return { cards: booking.cards, tokens: booking.tokens, unknown: booking.unknown, deckId, extraCommanders };
}

/** Vorschau fürs Entfernen: wie viele Karten abgezogen würden und wie viele schon fehlen. */
export async function previewPreconRemoval(op: OwnedPrecon): Promise<{ total: number; missing: number }> {
  const { key, have } = await ownedRowKeys(op.items);
  const plan = planRemoval(op.items, key, have);
  return { total: plan.total, missing: plan.missing };
}

/** Fertigdeck wieder aus der Sammlung nehmen (nie unter 0); das Deck auf Wunsch mit. */
export async function removePreconFromCollection(op: OwnedPrecon, opts: { deleteDeck: boolean }): Promise<number> {
  const gw = writeGateway();
  if (gw) return gw('removePrecon', [op.id, opts]) as Promise<number>;
  await autoBackup('vor-fertigdeck-weg').catch(() => null);
  const { key, have } = await ownedRowKeys(op.items);
  const plan = planRemoval(op.items, key, have);
  const removed = await removeOwnedBatch(plan.take);
  if (opts.deleteDeck && op.deckId != null) await deleteDeck(op.deckId);
  if (op.id != null) await db.ownedPrecons.delete(op.id);
  return removed;
}
