/**
 * Spielsteine (Tokens) und Embleme — Großes Token-Update (PLAN.md M14). Framework-frei
 * & rein testbar.
 *
 * Tokens stehen seit der Pipeline-Änderung mit im Katalog (Layout `token`,
 * `double_faced_token`, `emblem`), aber NICHT im Namensindex. Sie werden je Artwork
 * (Druckausgabe) gesammelt, nicht je Oracle wie Karten — und bleiben aus Deckbau, Suche
 * und Set-Fortschritt heraus.
 */
import type { Card } from './types';
import { levenshtein, normalizeName } from './nameMatch';
import type { OcrSignal } from './scanFuse';

export const TOKEN_LAYOUTS: readonly string[] = ['token', 'double_faced_token', 'emblem'];
const TOKEN_LAYOUT_SET: ReadonlySet<string> = new Set(TOKEN_LAYOUTS);

export function isTokenLayout(layout: string | undefined): boolean {
  return !!layout && TOKEN_LAYOUT_SET.has(layout);
}

export function isTokenCard(card: Pick<Card, 'layout'> | undefined): boolean {
  return isTokenLayout(card?.layout);
}

/**
 * Set-Codes, unter denen die Token-Ausgabe zum aufgedruckten Set liegen kann: Tokens
 * tragen unten den Code des Haupt-Sets („BLB"), Scryfall führt sie meist im eigenen
 * Token-Set („tblb"), manche (Secret Lair) aber im Set selbst.
 */
export function tokenSetCandidates(printedSet: string): string[] {
  const s = printedSet.toLowerCase();
  return [`t${s}`, s];
}

/** Vergleichsnamen eines Tokens: ganzer Name und je Seite („Treasure // Clue"). */
export function tokenNameKeys(name: string): string[] {
  const keys = new Set<string>();
  const whole = normalizeName(name);
  if (whole) keys.add(whole);
  for (const part of name.split('//')) {
    const k = normalizeName(part);
    if (k) keys.add(k);
  }
  return [...keys];
}

/** normName → Token-Oracles (Token-Namen sind nicht eindeutig: viele „Soldier"). */
export function buildTokenNameIndex(cards: Iterable<Pick<Card, 'oracleId' | 'name'>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of cards) {
    for (const k of tokenNameKeys(c.name)) {
      const list = out.get(k);
      if (!list) out.set(k, [c.oracleId]);
      else if (!list.includes(c.oracleId)) list.push(c.oracleId);
    }
  }
  return out;
}

export interface TokenNameHit {
  oracleId: string;
  /** 0..1 — 1 = exakt */
  score: number;
}

/** Ab dieser Ähnlichkeit zählt ein unscharf gelesener Token-Name (kurze Namen!). */
export const TOKEN_NAME_MIN = 0.75;

/**
 * Gelesenen Titel gegen die Token-Namen abgleichen: exakt, sonst der ähnlichste Name
 * (Levenshtein; die paar tausend Token-Namen gehen in wenigen Millisekunden durch).
 * Alle Oracles des besten Namens kommen zurück — welches es ist, entscheidet das Bild.
 */
export function matchTokenName(title: string, index: ReadonlyMap<string, readonly string[]>): TokenNameHit[] {
  const q = normalizeName(title);
  if (q.length < 3) return [];
  const exact = index.get(q);
  if (exact) return exact.map((oracleId) => ({ oracleId, score: 1 }));
  let bestName = '';
  let bestScore = 0;
  for (const name of index.keys()) {
    // Grob vorfiltern: stark unterschiedliche Länge kann nicht ähnlich genug sein.
    if (Math.abs(name.length - q.length) > Math.ceil(Math.max(name.length, q.length) * (1 - TOKEN_NAME_MIN))) continue;
    const s = 1 - levenshtein(q, name) / Math.max(q.length, name.length);
    if (s > bestScore) {
      bestScore = s;
      bestName = name;
    }
  }
  if (bestScore < TOKEN_NAME_MIN) return [];
  return (index.get(bestName) ?? []).map((oracleId) => ({ oracleId, score: bestScore }));
}

/**
 * Namens-Signal für die Fusion (domain/scanFuse): passt der Bildtreffer zu einem der
 * gelesenen Namen, steht er vorn (dann greift die Kreuz-Bestätigung). Mehrere Tokens
 * gleichen Namens → mehrdeutig, OCR allein entscheidet dann nichts.
 */
export function tokenOcrSignal(hits: readonly TokenNameHit[], hashOracle?: string): OcrSignal {
  if (hits.length === 0) return { score: 0, ambiguous: false };
  const top = (hashOracle && hits.find((h) => h.oracleId === hashOracle)) || hits[0];
  return { oracleId: top.oracleId, score: top.score, ambiguous: hits.length > 1 };
}

/** Anzeige-Sicherheit eines Artwork-Kandidaten aus dem Bildabstand (wie scanFuse). */
export function artScore(distance: number): number {
  return Math.min(0.95, Math.max(0.3, 1 - distance / 128));
}
