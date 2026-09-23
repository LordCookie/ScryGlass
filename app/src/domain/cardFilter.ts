/**
 * Karten-Filter (Farbe, Typ, Manawert, Format) — gemeinsam für die Katalogsuche und
 * die Sammlung. Framework-frei & rein testbar.
 */
import { isLegal, type Card, type FormatId } from './types';

export interface CardFilter {
  /** W U B R G, oder C = farblos (Farbidentität). */
  color: string | null;
  /** englisches Typwort (typeLine ist englisch), z. B. „Creature". */
  type: string | null;
  /** Manawert 0..7, 7 = „7+". */
  cmc: number | null;
  /** nur Karten, die in diesem Format legal sind. */
  format: FormatId | null;
}

export const EMPTY_CARD_FILTER: CardFilter = { color: null, type: null, cmc: null, format: null };

export function cmcBucket(cmc: number): number {
  return Math.min(7, Math.max(0, Math.floor(cmc)));
}

export function matchesCardFilter(c: Card, f: CardFilter): boolean {
  if (f.color) {
    const ok = f.color === 'C' ? c.colorIdentity.length === 0 : c.colorIdentity.includes(f.color);
    if (!ok) return false;
  }
  // „enthält den Typ" — Artefaktkreaturen zählen auch als Kreatur.
  if (f.type && !new RegExp(`\\b${f.type}\\b`, 'i').test(c.typeLine)) return false;
  if (f.cmc != null && cmcBucket(c.cmc) !== f.cmc) return false;
  if (f.format && !isLegal(c.legalities, f.format)) return false;
  return true;
}

/** Ist irgendein Filter gesetzt? */
export function hasCardFilter(f: CardFilter): boolean {
  return f.color != null || f.type != null || f.cmc != null || f.format != null;
}
