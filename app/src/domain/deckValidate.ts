/**
 * Deck-Validierung (PLAN.md § 7). Reines Zählen — Scryfall liefert Legalität und
 * Farbidentität fertig. Framework-frei; die Karten-Daten kommen als Lookup rein.
 */
import type { Card, Deck, FormatId } from './types';
import { isLegal, FORMAT_LABELS, commanderIds } from './types';

export type CardLookup = ReadonlyMap<string, Card>;

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  oracleId?: string;
}

interface FormatRules {
  /** exakte Deckgröße (Singleton-Formate) */
  deckSize?: number;
  /** Mindest-Deckgröße (Constructed) */
  minDeckSize?: number;
  singleton: boolean;
  needsCommander: boolean;
  maxSideboard: number;
}

const RULES: Record<FormatId, FormatRules> = {
  standard: { minDeckSize: 60, singleton: false, needsCommander: false, maxSideboard: 15 },
  pioneer: { minDeckSize: 60, singleton: false, needsCommander: false, maxSideboard: 15 },
  modern: { minDeckSize: 60, singleton: false, needsCommander: false, maxSideboard: 15 },
  legacy: { minDeckSize: 60, singleton: false, needsCommander: false, maxSideboard: 15 },
  vintage: { minDeckSize: 60, singleton: false, needsCommander: false, maxSideboard: 15 },
  pauper: { minDeckSize: 60, singleton: false, needsCommander: false, maxSideboard: 15 },
  commander: { deckSize: 100, singleton: true, needsCommander: true, maxSideboard: 0 },
  brawl: { deckSize: 60, singleton: true, needsCommander: true, maxSideboard: 0 },
};

/** Basic Land oder „beliebig oft"-Karte → vom Singleton/4er-Limit ausgenommen. */
function isCopyExempt(card: Card): boolean {
  return card.maxCopies >= 99;
}

export function canBeCommander(card: Card): boolean {
  const t = card.typeLine.toLowerCase();
  if (t.includes('legendary') && t.includes('creature')) return true;
  // Planeswalker/Background mit „can be your commander"
  return card.oracleText.toLowerCase().includes('can be your commander');
}

/** Hintergrund (Background) — darf nur als zweiter Commander neben „Choose a Background". */
export function isBackground(card: Card): boolean {
  return /\bBackground\b/.test(card.typeLine);
}

/** Darf die Karte auf den zweiten Commander-Platz? */
export function canBeSecondCommander(card: Card): boolean {
  return canBeCommander(card) || isBackground(card);
}

interface PartnerTraits {
  partner: boolean;
  partnerWith?: string;
  group?: string;
  chooseBackground: boolean;
  doctorsCompanion: boolean;
  background: boolean;
  timeLordDoctor: boolean;
}

/** Schlüsselwörter für zwei Commander aus dem Regeltext (je Zeile, Erinnerungstext egal). */
function partnerTraits(card: Card): PartnerTraits {
  const text = card.oracleText;
  const line = (re: RegExp) => re.exec(text);
  const withName = line(/^Partner with ([^(\n]+?)\s*(?:\(|$)/m);
  const group = line(/^Partner\s*[—–-]\s*([^(\n]+?)\s*(?:\(|$)/m);
  const friends = /^Friends forever\s*(?:\(|$)/im.test(text);
  return {
    partner: /^Partner\s*(?:\(|$)/m.test(text),
    ...(withName ? { partnerWith: withName[1].toLowerCase() } : {}),
    ...(group ? { group: group[1].toLowerCase() } : friends ? { group: 'friends forever' } : {}),
    chooseBackground: /^Choose a Background\s*(?:\(|$)/im.test(text),
    doctorsCompanion: /^Doctor['’]s companion\s*(?:\(|$)/im.test(text),
    background: isBackground(card),
    timeLordDoctor: /Time Lord Doctor/.test(card.typeLine),
  };
}

const frontName = (c: Card) => c.name.split(' // ')[0].toLowerCase();

/**
 * Dürfen die beiden laut Kartentext zusammen Commander sein? Partner, „Partner with",
 * Partner—…/Friends forever, Choose a Background, Doctor's companion. Die Regeln wachsen
 * mit jedem Set — deshalb nur ein Hinweis, nie ein Fehler (M20).
 */
export function canPair(a: Card, b: Card): boolean {
  const x = partnerTraits(a);
  const y = partnerTraits(b);
  if (x.partner && y.partner) return true;
  if (x.partnerWith === frontName(b) || y.partnerWith === frontName(a)) return true;
  if (x.group && x.group === y.group) return true;
  if ((x.chooseBackground && y.background) || (y.chooseBackground && x.background)) return true;
  if ((x.doctorsCompanion && y.timeLordDoctor) || (y.doctorsCompanion && x.timeLordDoctor)) return true;
  return false;
}

/** Farbidentität aller Commander zusammen (WUBRG-Reihenfolge). */
export function commanderIdentity(commanders: readonly Card[]): string[] {
  const all = new Set(commanders.flatMap((c) => c.colorIdentity));
  return ['W', 'U', 'B', 'R', 'G'].filter((c) => all.has(c));
}

/**
 * Farben, die ein Commander-Deck spielen darf: die Farbidentität des Commanders plus
 * immer Farblos („C") — farblose Karten (Artefakte, Eldrazi, Länder ohne Farbsymbol)
 * passen in jedes Deck. Reihenfolge WUBRG, farblos zuletzt.
 */
export function availableColors(commanderCI: readonly string[]): string[] {
  const out = ['W', 'U', 'B', 'R', 'G'].filter((c) => commanderCI.includes(c));
  out.push('C');
  return out;
}

/** Ist die Farbidentität von `card` eine Teilmenge von `commanderCI`? */
export function colorIdentityWithin(card: Card, commanderCI: readonly string[]): boolean {
  const allowed = new Set(commanderCI);
  return card.colorIdentity.every((c) => allowed.has(c));
}

export interface DeckValidation {
  ok: boolean;
  issues: ValidationIssue[];
  /** Summe der Karten im Mainboard (inkl. Commander). */
  mainCount: number;
  sideboardCount: number;
}

export function validateDeck(deck: Deck, cards: CardLookup): DeckValidation {
  const rules = RULES[deck.format];
  const issues: ValidationIssue[] = [];
  const fmtLabel = FORMAT_LABELS[deck.format];

  const commander = deck.commanderId ? cards.get(deck.commanderId) : undefined;
  const partner = deck.partnerId ? cards.get(deck.partnerId) : undefined;
  const ids = commanderIds(deck);
  const mainCount = deck.cards.reduce((s, c) => s + c.qty, 0) + ids.length;
  const sideboardCount = deck.sideboard.reduce((s, c) => s + c.qty, 0);

  // --- Deckgröße ---
  if (rules.deckSize != null && mainCount !== rules.deckSize) {
    issues.push({
      level: 'error',
      message: `${fmtLabel}: Deck hat ${mainCount} Karten, genau ${rules.deckSize} nötig.`,
    });
  }
  if (rules.minDeckSize != null && mainCount < rules.minDeckSize) {
    issues.push({
      level: 'error',
      message: `${fmtLabel}: Deck hat ${mainCount} Karten, mindestens ${rules.minDeckSize} nötig.`,
    });
  }
  if (sideboardCount > rules.maxSideboard) {
    issues.push({
      level: 'error',
      message: `Sideboard hat ${sideboardCount} Karten, höchstens ${rules.maxSideboard} erlaubt.`,
    });
  }

  // --- Commander-Voraussetzungen ---
  if (rules.needsCommander) {
    if (!commander) {
      issues.push({ level: 'error', message: `${fmtLabel} braucht einen Commander.` });
    } else if (!canBeCommander(commander)) {
      issues.push({
        level: 'error',
        message: `„${commander.name}" kann kein Commander sein (keine legendäre Kreatur).`,
        oracleId: commander.oracleId,
      });
    }
    if (deck.twoCommanders && !deck.partnerId) {
      issues.push({ level: 'warning', message: 'Zweiter Commander noch nicht gewählt.' });
    }
    if (partner) {
      if (!canBeSecondCommander(partner)) {
        issues.push({
          level: 'error',
          message: `„${partner.name}" kann kein Commander sein (keine legendäre Kreatur).`,
          oracleId: partner.oracleId,
        });
      } else if (commander && !canPair(commander, partner)) {
        issues.push({
          level: 'warning',
          message: `„${commander.name}" und „${partner.name}" dürfen laut Kartentext nicht zusammen Commander sein (kein Partner oder Hintergrund).`,
          oracleId: partner.oracleId,
        });
      }
    }
  }

  const commanderCI = commanderIdentity([commander, partner].filter((c): c is Card => !!c));

  // --- pro Karte: Existenz, Legalität, Kopienlimit, Farbidentität ---
  const allEntries = [...deck.cards, ...deck.sideboard];
  for (const id of ids) allEntries.push({ oracleId: id, qty: 1 });

  for (const entry of allEntries) {
    const card = cards.get(entry.oracleId);
    if (!card) {
      issues.push({ level: 'error', message: `Unbekannte Karte (${entry.oracleId}).`, oracleId: entry.oracleId });
      continue;
    }

    // Legalität
    if (!isLegal(card.legalities, deck.format)) {
      issues.push({
        level: 'error',
        message: `„${card.name}" ist in ${fmtLabel} nicht legal.`,
        oracleId: card.oracleId,
      });
    }

    // Kopienlimit
    const maxAllowed = rules.singleton ? (isCopyExempt(card) ? Infinity : 1) : card.maxCopies;
    if (entry.qty > maxAllowed) {
      issues.push({
        level: 'error',
        message: rules.singleton
          ? `„${card.name}": Singleton — nur 1 Exemplar erlaubt.`
          : `„${card.name}": ${entry.qty}× — höchstens ${maxAllowed} erlaubt.`,
        oracleId: card.oracleId,
      });
    }

    // Farbidentität (Commander)
    if (rules.needsCommander && commander && !colorIdentityWithin(card, commanderCI)) {
      issues.push({
        level: 'error',
        message: `„${card.name}" liegt außerhalb der Farbidentität ${partner ? 'der Commander' : 'des Commanders'}.`,
        oracleId: card.oracleId,
      });
    }
  }

  return {
    ok: issues.every((i) => i.level !== 'error'),
    issues,
    mainCount,
    sideboardCount,
  };
}
