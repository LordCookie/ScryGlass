import { db } from '../db/db';
import { normalizeName } from '../domain/nameMatch';
import type { Card } from '../domain/types';

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
      const built = cards.map((c) => ({
        card: c,
        nameLower: c.name.toLowerCase(),
        hay: (
          c.name +
          ' ' +
          c.typeLine +
          ' ' +
          c.oracleText +
          ' ' +
          (deByOracle.get(c.oracleId)?.join(' ') ?? '')
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
  const idx = await ensureIndex();
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
  return scored.slice(0, limit).map((s) => s.entry.card);
}
