import { db, getMeta, setMeta, whereAnyOf } from '../db/db';
import { NdjsonBuffer } from './ndjson';
import {
  packCombos, indexCombos, findCombos, comboCards, comboResults, colorMask, resultLabel,
  type ComboHead, type ComboHit, type ComboIndex, type ComboRow, type ComboStore,
} from '../domain/combos';
import type { DeckCombo, DeckCombos } from '../domain/deckCheck';
import type { Card, Deck } from '../domain/types';
import { normalizeName } from '../domain/nameMatch';

/**
 * Kombo-Daten (Commander Spellbook, M17): `combos.ndjson` aus dem Katalog laden, als
 * EIN kompakter Datensatz in `meta` ablegen (Typed Arrays, ~5 MB) und erst bei Bedarf
 * in den Speicher holen — Kombos sind ein Zusatz für die, die sie brauchen.
 * Fehlt die Datei (älterer Katalog), passiert einfach nichts.
 */

const STORE_KEY = 'combos';
const VERSION_KEY = 'combosVersion';

export async function hasComboData(): Promise<boolean> {
  return (await db.meta.where('key').equals(STORE_KEY).count()) > 0;
}

/** combos.ndjson lesen: erste Zeile Kopf, danach Zeilen. */
async function readCombos(url: string, gzip: boolean, onProgress?: (done: number) => void): Promise<ComboStore> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Kombos nicht gefunden (${res.status})`);
  const reader = (gzip ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body).getReader();
  const decoder = new TextDecoder();
  const buf = new NdjsonBuffer<ComboHead | ComboRow>();
  let head: ComboHead | null = null;
  const rows: ComboRow[] = [];
  const take = (items: (ComboHead | ComboRow)[]) => {
    for (const it of items) {
      if (!head) {
        if (Array.isArray(it) || !('cards' in it)) throw new Error('Kombo-Datei ohne Kopf');
        head = it;
      } else rows.push(it as ComboRow);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    take(buf.push(decoder.decode(value, { stream: true })));
    onProgress?.(rows.length);
  }
  take(buf.flush());
  if (!head) throw new Error('Kombo-Datei leer');
  return packCombos(head, rows);
}

/** Wie der Bild-Abgleich: einmal je Katalogstand, best effort. */
export async function syncCombos(
  base: string,
  catalogVersion: string | undefined,
  onProgress?: (done: number) => void,
  gzip = false,
): Promise<'imported' | 'skipped' | 'absent'> {
  if (catalogVersion && (await getMeta<string>(VERSION_KEY)) === catalogVersion && (await hasComboData())) return 'skipped';
  let store: ComboStore;
  try {
    store = await readCombos(`${base}/combos.ndjson${gzip ? '.gz' : ''}`, gzip, onProgress);
  } catch {
    return 'absent'; // älterer Katalog ohne Kombos (oder Dev-Server liefert index.html)
  }
  await setMeta(STORE_KEY, store);
  if (catalogVersion) await setMeta(VERSION_KEY, catalogVersion);
  invalidateComboIndex();
  return 'imported';
}

let indexPromise: Promise<ComboIndex | null> | null = null;

/** Index im Speicher (einmal je Sitzung); null, wenn es keine Kombo-Daten gibt. */
export function loadComboIndex(): Promise<ComboIndex | null> {
  indexPromise ??= getMeta<ComboStore>(STORE_KEY).then((s) => (s ? indexCombos(s) : null));
  return indexPromise;
}

export function invalidateComboIndex(): void {
  indexPromise = null;
  namesPromise = null;
}

export interface ComboNames {
  /** oracleId → englischer Name (Anzeige) */
  name: Map<string, string>;
  /** normalisierte Namen (EN + DE) → oracleId, für die Suche nach Karte */
  search: { norm: string; oracleId: string }[];
}

let namesPromise: Promise<ComboNames> | null = null;

/** Namen aller Kombo-Karten (rund 7.000), für Anzeige und Suche. */
export function loadComboNames(ix: ComboIndex): Promise<ComboNames> {
  namesPromise ??= (async () => {
    const ids = ix.store.cards;
    const [cards, de] = await Promise.all([
      db.cards.bulkGet(ids),
      whereAnyOf(db.names, 'oracleId', ids),
    ]);
    const name = new Map<string, string>();
    const search: ComboNames['search'] = [];
    cards.forEach((c) => {
      if (!c) return;
      name.set(c.oracleId, c.name);
      search.push({ norm: c.normName || normalizeName(c.name), oracleId: c.oracleId });
    });
    for (const n of de) if (n.lang === 'de') search.push({ norm: n.normName, oracleId: n.oracleId });
    return { name, search };
  })();
  return namesPromise;
}

/** Kombo-Karten, deren Name (EN oder DE) den Suchtext enthält. */
export function matchComboCards(names: ComboNames, query: string, limit = 40): string[] {
  const q = normalizeName(query);
  if (!q) return [];
  const out = new Set<string>();
  // Erst Namensanfänge, dann irgendwo im Namen — „kiki" bringt Kiki-Jiki vor Karten, die es nur enthalten.
  for (const pass of [(n: string) => n.startsWith(q), (n: string) => n.includes(q)]) {
    for (const s of names.search) {
      if (out.size >= limit) break;
      if (pass(s.norm)) out.add(s.oracleId);
    }
  }
  return [...out];
}

/**
 * Kombos im Deck und solche, denen genau eine Karte fehlt (für den Deck-Check). Commander-
 * Pflichtkarten zählen nur als Commander; bei „fehlt eine" nur, was zur Farbidentität passt.
 * Die aus der Sammlung stehen vorn — das kann nur eine App, die deine Karten kennt.
 */
export async function deckCombos(deck: Deck, cards: ReadonlyMap<string, Card>, owned: ReadonlySet<string>): Promise<DeckCombos | undefined> {
  const ix = await loadComboIndex();
  if (!ix) return undefined;
  const names = await loadComboNames(ix);
  const inDeck = new Set(deck.cards.map((c) => c.oracleId));
  const leads = deck.format === 'commander' || deck.format === 'brawl';
  if (leads && deck.commanderId) inDeck.add(deck.commanderId);
  const commander = new Set(leads && deck.commanderId ? [deck.commanderId] : []);
  const identity = leads && deck.commanderId ? colorMask((cards.get(deck.commanderId)?.colorIdentity ?? []).join('')) : 0x1f;
  const s = ix.store;
  const view = (h: ComboHit): DeckCombo => ({
    id: s.ids[h.i],
    names: comboCards(ix, h.i).map((id) => names.name.get(id) ?? id),
    stars: s.stars[h.i],
    mv: s.mv[h.i],
    results: comboResults(ix, h.i).map(resultLabel),
  });
  const hits = findCombos(ix, inDeck, { maxMissing: 1, commander });
  const included = hits.filter((h) => h.missing.length === 0).map(view);
  const almost = hits
    .filter((h) => h.missing.length === 1 && (s.colors[h.i] & ~identity) === 0)
    .map((h) => ({ ...view(h), missing: names.name.get(h.missing[0]) ?? h.missing[0], owned: owned.has(h.missing[0]) }))
    .sort((a, b) => Number(b.owned) - Number(a.owned) || b.stars - a.stars);
  return { included, almost };
}
