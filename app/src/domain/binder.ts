/**
 * Sammelordner (PLAN.md M22): Seiten zu 9 Fächern, sortiert wie in einem echten Ordner,
 * und die Set-Checkliste — jede Karte eines Sets einmal, eigene markiert. Varianten
 * derselben Karte (Showcase, Alt-Art) zählen einmal, wie im Set-Fortschritt der Statistik.
 * Rein und testbar.
 */
import type { Card } from './types';

export const POCKETS = 9;

export function pageCount(items: number, perPage = POCKETS): number {
  return Math.max(1, Math.ceil(items / perPage));
}

/** Sammlernummern wie gedruckt: „2" < „10" < „10a" < „★12". */
export function compareCollector(a: string, b: string): number {
  const na = parseInt(a.replace(/^\D+/, ''), 10);
  const nb = parseInt(b.replace(/^\D+/, ''), 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  if (Number.isNaN(na) !== Number.isNaN(nb)) return Number.isNaN(na) ? 1 : -1;
  return a.localeCompare(b);
}

/** Ordner-Reihenfolge nach Farbe: W, U, B, R, G, mehrfarbig, farblos, Länder. */
export function colorGroup(card: Pick<Card, 'colors' | 'typeLine'>): number {
  if (/\bLand\b/.test(card.typeLine)) return 7;
  if (card.colors.length > 1) return 5;
  if (card.colors.length === 0) return 6;
  return Math.max(0, ['W', 'U', 'B', 'R', 'G'].indexOf(card.colors[0]));
}

export type BinderSort = 'set' | 'farbe' | 'name';

export interface BinderItem {
  card: Pick<Card, 'name' | 'colors' | 'typeLine'>;
  set?: string;
  collectorNumber?: string;
}

export function sortBinder<T extends BinderItem>(items: readonly T[], sort: BinderSort): T[] {
  const byName = (a: T, b: T) => a.card.name.localeCompare(b.card.name);
  const out = [...items];
  if (sort === 'name') return out.sort(byName);
  if (sort === 'farbe') return out.sort((a, b) => colorGroup(a.card) - colorGroup(b.card) || byName(a, b));
  return out.sort((a, b) =>
    (a.set ?? '￿').localeCompare(b.set ?? '￿') ||
    compareCollector(a.collectorNumber ?? '', b.collectorNumber ?? '') ||
    byName(a, b));
}

export interface ChecklistEntry {
  oracleId: string;
  scryfallId: string;
  collectorNumber: string;
  owned: boolean;
}

/**
 * Checkliste eines Sets: je Karte ein Fach (kleinste Sammlernummer, englischer Druck
 * bevorzugt; hat man eine Ausgabe aus diesem Set gewählt, deren Bild). Tokens nicht.
 */
export function setChecklist(
  printings: readonly { scryfallId: string; oracleId: string; collectorNumber: string; lang: string }[],
  owned: ReadonlySet<string>,
  tokens: ReadonlySet<string> = new Set(),
  chosen: ReadonlyMap<string, string> = new Map(),
): ChecklistEntry[] {
  const best = new Map<string, (typeof printings)[number]>();
  for (const p of printings) {
    if (tokens.has(p.oracleId)) continue;
    const cur = best.get(p.oracleId);
    const better = !cur ||
      (p.lang === 'en' && cur.lang !== 'en') ||
      (p.lang === cur.lang && compareCollector(p.collectorNumber, cur.collectorNumber) < 0);
    if (better) best.set(p.oracleId, p);
  }
  const ids = new Set(printings.map((p) => p.scryfallId));
  return [...best.values()]
    .sort((a, b) => compareCollector(a.collectorNumber, b.collectorNumber))
    .map((p) => {
      const pick = chosen.get(p.oracleId);
      return {
        oracleId: p.oracleId,
        scryfallId: pick && ids.has(pick) ? pick : p.scryfallId,
        collectorNumber: p.collectorNumber,
        owned: owned.has(p.oracleId),
      };
    });
}
