import { db } from '../db/db';
import { normalizeName } from '../domain/nameMatch';
import type { Card } from '../domain/types';
import { matchesCardFilter, hasCardFilter, germanTypeWords, collectSubtypes, type CardFilter } from '../domain/cardFilter';
import { isTokenCard } from '../domain/tokens';
import { loadTokenCatalog } from './tokenCatalog';

/**
 * Katalogsuche für Deckbau, manuelles Hinzufügen und den Scanner-Fallback.
 *
 * Neu: sucht nicht nur über den Namen, sondern auch über Typzeile UND Regeltext
 * (Oracle-Text) — inkl. deutscher Namen. So findet man Karten „über Wörter im
 * Mittelteil" (z. B. „ninjutsu", „draw a card", „Fliegend").
 *
 * Dafür wird beim ersten Bedarf ein In-Memory-Suchindex aufgebaut (34k Karten +
 * DE-Namen zu einem gelowercten „Heuhaufen" je Karte). Lazy — belastet den Start
 * nicht; nach einem Katalog-Update per `invalidateSearchIndex()` verwerfen.
 * Tokens/Embleme gehören nicht hinein (Deckbau, M14) — die sucht `searchTokens`.
 */

interface SearchEntry {
  card: Card;
  /** name + typeLine + oracleText + DE-Namen, alles lowercase — der Suchraum. */
  hay: string;
  nameLower: string;
}

let index: SearchEntry[] | null = null;
let building: Promise<SearchEntry[]> | null = null;

export function invalidateSearchIndex(): void {
  index = null;
  building = null;
  subtypes = null;
}

async function ensureIndex(): Promise<SearchEntry[]> {
  if (index) return index;
  if (!building) {
    building = (async () => {
      const [cards, names] = await Promise.all([db.cards.toArray(), db.names.toArray()]);
      // deutsche Namen je oracleId sammeln (für DE-Suche im Heuhaufen).
      const deByOracle = new Map<string, string[]>();
      for (const n of names) {
        if (n.lang !== 'en') {
          const a = deByOracle.get(n.oracleId);
          if (a) a.push(n.normName);
          else deByOracle.set(n.oracleId, [n.normName]);
        }
      }
      const built = cards.filter((c) => !isTokenCard(c)).map((c) => ({
        card: c,
        nameLower: c.name.toLowerCase(),
        hay: (
          c.name +
          ' ' +
          c.typeLine +
          ' ' +
          c.oracleText +
          ' ' +
          (deByOracle.get(c.oracleId)?.join(' ') ?? '') +
          ' ' +
          // „kreatur", „kobold" … — damit auch deutsche Typwörter treffen.
          germanTypeWords(c.typeLine)
        ).toLowerCase(),
      }));
      index = built;
      return built;
    })();
  }
  return building;
}

/**
 * Sucht Karten. Reihenfolge der Relevanz: exakter Name → Name-Präfix → Name enthält
 * → Typ enthält → nur im Regeltext gefunden. Alle Suchwörter müssen vorkommen.
 */
export async function searchCards(query: string, limit = 20): Promise<Card[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return scoreEntries(await ensureIndex(), query).slice(0, limit).map((s) => s.entry.card);
}

export interface CatalogResult {
  cards: Card[];
  /** alle Treffer (für „N Treffer" / „Mehr anzeigen") */
  total: number;
}

/**
 * Katalogsuche mit Filtern (Such-Tab). Mit Suchbegriff: Relevanz wie `searchCards`;
 * nur mit Filtern: der ganze Katalog gefiltert, alphabetisch. Ohne beides: nichts.
 * `onlyIds`: optional nur diese Karten (z. B. „nur im Bestand").
 */
export async function searchCatalog(
  query: string,
  filter: CardFilter,
  limit: number,
  onlyIds?: ReadonlySet<string>,
): Promise<CatalogResult> {
  const q = query.trim();
  if (!q && !hasCardFilter(filter) && !onlyIds) return { cards: [], total: 0 };
  const idx = await ensureIndex();
  const keep = (c: Card) => matchesCardFilter(c, filter) && (!onlyIds || onlyIds.has(c.oracleId));
  const hits = q
    ? scoreEntries(idx, query).map((s) => s.entry.card).filter(keep)
    : idx.map((e) => e.card).filter(keep).sort((a, b) => a.name.localeCompare(b.name));
  return { cards: hits.slice(0, limit), total: hits.length };
}

/** Spielsteine/Embleme nach Name oder Typ (Sammlung → Tokens, manuell hinzufügen). */
export async function searchTokens(query: string, limit = 20): Promise<Card[]> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const q = words.join(' ');
  const hits: { card: Card; score: number }[] = [];
  for (const card of (await loadTokenCatalog()).cards.values()) {
    const name = card.name.toLowerCase();
    const hay = `${name} ${card.typeLine.toLowerCase()} ${card.oracleText.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    hits.push({ card, score: name === q ? 3 : name.startsWith(q) ? 2 : name.includes(q) ? 1 : 0 });
  }
  hits.sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name) || a.card.typeLine.localeCompare(b.card.typeLine));
  return hits.slice(0, limit).map((h) => h.card);
}

let subtypes: string[] | null = null;

/** Alle Untertypen im Katalog (Goblin, Elf, Equipment …) — Vorschläge im Such-Filter. */
export async function catalogSubtypes(): Promise<string[]> {
  if (subtypes) return subtypes;
  const idx = await ensureIndex();
  subtypes = collectSubtypes(idx.map((e) => e.card.typeLine));
  return subtypes;
}

/** Relevanz-Bewertung aller Einträge, die alle Suchwörter enthalten (absteigend). */
function scoreEntries(idx: readonly SearchEntry[], query: string): { entry: SearchEntry; score: number }[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  // Auch die normalisierte Form testen (deutsche Namen liegen ohne Diakritika vor).
  const qNorm = normalizeName(query);

  const scored: { entry: SearchEntry; score: number }[] = [];
  for (const entry of idx) {
    let ok = true;
    for (const w of words) {
      if (!entry.hay.includes(w)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    let score: number;
    if (entry.nameLower === q) score = 100;
    else if (entry.nameLower.startsWith(q)) score = 70;
    else if (qNorm && entry.card.normName.startsWith(qNorm)) score = 65;
    else if (entry.nameLower.includes(q)) score = 40;
    else if (entry.card.typeLine.toLowerCase().includes(q)) score = 15;
    else score = 5; // nur im Regeltext getroffen
    scored.push({ entry, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.card.name.length - b.entry.card.name.length ||
      a.entry.card.name.localeCompare(b.entry.card.name),
  );
  return scored;
}
