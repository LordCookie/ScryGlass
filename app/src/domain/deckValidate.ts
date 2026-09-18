/**
 * Deck-Validierung (PLAN.md § 7). Reines Zählen — Scryfall liefert Legalität und
 * Farbidentität fertig. Framework-frei; die Karten-Daten kommen als Lookup rein.
 */
import type { Card, Deck, FormatId } from './types';
import { isLegal, FORMAT_LABELS } from './types';

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
  const mainCount =
    deck.cards.reduce((s, c) => s + c.qty, 0) + (deck.commanderId ? 1 : 0);
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
  }

  const commanderCI = commander?.colorIdentity ?? [];

  // --- pro Karte: Existenz, Legalität, Kopienlimit, Farbidentität ---
  const allEntries = [...deck.cards, ...deck.sideboard];
  if (deck.commanderId) allEntries.push({ oracleId: deck.commanderId, qty: 1 });

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
        message: `„${card.name}" liegt außerhalb der Farbidentität des Commanders.`,
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
