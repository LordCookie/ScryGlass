/**
 * Karten-Filter (Farben, Typ, Manawert, Format, Regeltext, Typzeile) — gemeinsam für
 * die Katalogsuche und die Sammlung. Framework-frei & rein testbar.
 */
import { isLegal, type Card, type FormatId } from './types';

/**
 * Wie mehrere gewählte Farben wirken (bezogen auf die Farbidentität):
 * - include: enthält alle gewählten Farben (weitere erlaubt)
 * - exact:   genau diese Farben
 * - within:  höchstens diese Farben — passt in ein Deck dieser Farben (inkl. farblos)
 */
export type ColorMode = 'include' | 'exact' | 'within';

export interface CardFilter {
  /** W U B R G; „C" = farblos (schließt Farben aus). Leer = egal. */
  colors: readonly string[];
  colorMode: ColorMode;
  /** englisches Typwort (typeLine ist englisch), z. B. „Creature". */
  type: string | null;
  /** Manawert 0..7, 7 = „7+". */
  cmc: number | null;
  /** nur Karten, die in diesem Format legal sind. */
  format: FormatId | null;
  /** Regeltext enthält alle diese Wörter (Oracle-Text, englisch). */
  text: string;
  /** Typzeile enthält alle diese Wörter, z. B. „Goblin", „legendary elf", „Kreatur". */
  typeLine: string;
}

export const EMPTY_CARD_FILTER: CardFilter = {
  colors: [], colorMode: 'include', type: null, cmc: null, format: null, text: '', typeLine: '',
};

export const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'] as const;

export function cmcBucket(cmc: number): number {
  return Math.min(7, Math.max(0, Math.floor(cmc)));
}

/**
 * Deutsche Typwörter → englisch (die Typzeile im Katalog ist englisch). Nur Ober-/
 * Kartentypen und häufige Untertypen, die sich im Deutschen deutlich unterscheiden.
 */
const DE_TYPE: Record<string, string> = {
  kreatur: 'creature',
  spontanzauber: 'instant',
  hexerei: 'sorcery',
  artefakt: 'artifact',
  verzauberung: 'enchantment',
  schlacht: 'battle',
  legendär: 'legendary',
  legendaer: 'legendary',
  standardland: 'basic',
  stammes: 'kindred',
  ausrüstung: 'equipment',
  ausruestung: 'equipment',
  fahrzeug: 'vehicle',
  kobold: 'goblin',
  mensch: 'human',
  vampir: 'vampire',
  drache: 'dragon',
  engel: 'angel',
  dämon: 'demon',
  daemon: 'demon',
  zwerg: 'dwarf',
  zauberer: 'wizard',
  krieger: 'warrior',
  soldat: 'soldier',
  schurke: 'rogue',
  kleriker: 'cleric',
  ritter: 'knight',
  geist: 'spirit',
  katze: 'cat',
  vogel: 'bird',
  schlange: 'snake',
  meervolk: 'merfolk',
  riese: 'giant',
  bestie: 'beast',
  elementar: 'elemental',
};

function words(s: string): string[] {
  return s.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Enthält die Typzeile alle Suchwörter (deutsche Typwörter werden übersetzt)? */
export function typeLineMatches(typeLine: string, query: string): boolean {
  const hay = typeLine.toLowerCase();
  return words(query).every((w) => hay.includes(w) || (DE_TYPE[w] != null && hay.includes(DE_TYPE[w])));
}

/** Deutsche Entsprechungen der Typwörter einer Typzeile (für die Volltextsuche). */
export function germanTypeWords(typeLine: string): string {
  const hay = typeLine.toLowerCase();
  const out = new Set<string>();
  for (const [de, en] of Object.entries(DE_TYPE)) {
    if (new RegExp(`\\b${en}\\b`).test(hay)) out.add(de);
  }
  return [...out].join(' ');
}

/** Farbidentität gegen die gewählten Farben prüfen. */
export function matchesColors(identity: readonly string[], colors: readonly string[], mode: ColorMode): boolean {
  if (colors.length === 0) return true;
  if (colors.includes('C')) return identity.length === 0;
  switch (mode) {
    case 'include':
      return colors.every((c) => identity.includes(c));
    case 'exact':
      return identity.length === colors.length && colors.every((c) => identity.includes(c));
    case 'within':
      return identity.every((c) => colors.includes(c));
  }
}

/**
 * Farbe antippen: farblos schließt Farben aus und umgekehrt; sonst an/aus.
 * Ergebnis in WUBRG-Reihenfolge.
 */
export function toggleColor(colors: readonly string[], key: string): string[] {
  if (key === 'C') return colors.includes('C') ? [] : ['C'];
  const set = new Set(colors.filter((c) => c !== 'C'));
  if (set.has(key)) set.delete(key);
  else set.add(key);
  return COLOR_ORDER.filter((c) => set.has(c));
}

export function matchesCardFilter(c: Card, f: CardFilter): boolean {
  if (!matchesColors(c.colorIdentity, f.colors, f.colorMode)) return false;
  // „enthält den Typ" — Artefaktkreaturen zählen auch als Kreatur.
  if (f.type && !new RegExp(`\\b${f.type}\\b`, 'i').test(c.typeLine)) return false;
  if (f.cmc != null && cmcBucket(c.cmc) !== f.cmc) return false;
  if (f.format && !isLegal(c.legalities, f.format)) return false;
  if (f.text.trim()) {
    const hay = c.oracleText.toLowerCase();
    if (!words(f.text).every((w) => hay.includes(w))) return false;
  }
  if (f.typeLine.trim() && !typeLineMatches(c.typeLine, f.typeLine)) return false;
  return true;
}

/** Ist irgendein Filter gesetzt? */
export function hasCardFilter(f: CardFilter): boolean {
  return f.colors.length > 0 || f.type != null || f.cmc != null || f.format != null || !!f.text.trim() || !!f.typeLine.trim();
}

/**
 * Untertypen aus Typzeilen sammeln (Teil nach dem Gedankenstrich; bei Doppelkarten je
 * Seite), alphabetisch — Vorschläge fürs Typ-Feld (Goblin, Elf, Equipment …).
 */
export function collectSubtypes(typeLines: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const tl of typeLines) {
    for (const side of tl.split('//')) {
      const i = side.indexOf('—');
      if (i < 0) continue;
      for (const w of side.slice(i + 1).trim().split(/\s+/)) if (w) set.add(w);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
