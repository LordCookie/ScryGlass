import type { Deck, DeckCard, FormatId } from './types';

/**
 * Deck-Änderungen als kleine Schritte (PLAN.md M18): Statt das ganze Deck zu speichern,
 * wird ein Schritt auf den AKTUELLEN Stand angewendet. So überschreiben sich Handy und
 * Browser (oder zwei Tabs) nicht gegenseitig, wenn sie dasselbe Deck bearbeiten.
 */
export type DeckOp =
  | { kind: 'adjust'; list: 'cards' | 'sideboard'; oracleId: string; delta: number }
  | { kind: 'rename'; name: string }
  | { kind: 'format'; format: FormatId }
  | { kind: 'commander'; oracleId: string | null }
  /** zweiter Commander (M20) */
  | { kind: 'partner'; oracleId: string | null }
  /** Schalter „Zwei Commander"; aus → der zweite wandert ins Hauptdeck */
  | { kind: 'twoCommanders'; on: boolean }
  /** Text-Import: ersetzt beide Listen */
  | { kind: 'replaceLists'; cards: DeckCard[]; sideboard: DeckCard[] };

function adjustList(list: readonly DeckCard[], oracleId: string, delta: number): DeckCard[] {
  const arr = [...list];
  const i = arr.findIndex((c) => c.oracleId === oracleId);
  if (i >= 0) {
    const qty = arr[i].qty + delta;
    if (qty <= 0) arr.splice(i, 1);
    else arr[i] = { ...arr[i], qty };
  } else if (delta > 0) arr.push({ oracleId, qty: delta });
  return arr;
}

/** Wendet einen Schritt an; gibt ein neues Deck zurück (das alte bleibt unverändert). */
export function applyDeckOp(deck: Deck, op: DeckOp, now = Date.now()): Deck {
  const next: Deck = { ...deck, updatedAt: now };
  switch (op.kind) {
    case 'adjust':
      next[op.list] = adjustList(deck[op.list], op.oracleId, Math.trunc(op.delta));
      break;
    case 'rename':
      next.name = op.name;
      break;
    case 'format':
      next.format = op.format;
      break;
    case 'commander':
      if (op.oracleId) next.commanderId = op.oracleId;
      else delete next.commanderId;
      break;
    case 'partner':
      if (op.oracleId) {
        next.partnerId = op.oracleId;
        next.twoCommanders = true;
      } else delete next.partnerId;
      break;
    case 'twoCommanders':
      if (op.on) next.twoCommanders = true;
      else {
        delete next.twoCommanders;
        if (deck.partnerId) {
          next.cards = adjustList(deck.cards, deck.partnerId, 1);
          delete next.partnerId;
        }
      }
      break;
    case 'replaceLists':
      next.cards = op.cards.filter((c) => c.qty > 0).map((c) => ({ oracleId: c.oracleId, qty: c.qty }));
      next.sideboard = op.sideboard.filter((c) => c.qty > 0).map((c) => ({ oracleId: c.oracleId, qty: c.qty }));
      break;
  }
  return next;
}

/** Prüft einen Schritt, der von außen kommt (Big Screen) — kaputte werden abgelehnt. */
export function isDeckOp(v: unknown): v is DeckOp {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const cardList = (l: unknown) =>
    Array.isArray(l) && l.every((c) => typeof c === 'object' && c !== null &&
      typeof (c as DeckCard).oracleId === 'string' && typeof (c as DeckCard).qty === 'number');
  switch (o.kind) {
    case 'adjust':
      return (o.list === 'cards' || o.list === 'sideboard') && typeof o.oracleId === 'string' &&
        typeof o.delta === 'number' && Number.isFinite(o.delta);
    case 'rename':
      return typeof o.name === 'string';
    case 'format':
      return typeof o.format === 'string';
    case 'commander':
    case 'partner':
      return o.oracleId === null || typeof o.oracleId === 'string';
    case 'twoCommanders':
      return typeof o.on === 'boolean';
    case 'replaceLists':
      return cardList(o.cards) && cardList(o.sideboard);
    default:
      return false;
  }
}
