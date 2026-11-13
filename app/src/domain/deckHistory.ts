/**
 * Deck-Verlauf (PLAN.md M22): Jede Deck-Änderung (die Schritte aus M18) wird mit Zeit und
 * dem Weg zurück gemerkt. Hier: den Weg zurück berechnen und den Verlauf lesbar
 * zusammenfassen („+2 Lightning Bolt, −1 Shock"). Rein und testbar.
 */
import { applyDeckOp, type DeckOp } from './deckOps';
import { FORMAT_LABELS, type Deck } from './types';

export interface DeckHistoryEntry {
  id?: number;
  deckId: number;
  at: number;
  op: DeckOp;
  /** Schritte, die den Stand davor wiederherstellen (in dieser Reihenfolge anwenden) */
  undo: DeckOp[];
}

/** Die Schritte, die `op` auf `before` wieder rückgängig machen. */
export function inverseOps(before: Deck, op: DeckOp): DeckOp[] {
  switch (op.kind) {
    case 'adjust': {
      const had = before[op.list].find((c) => c.oracleId === op.oracleId)?.qty ?? 0;
      const now = applyDeckOp(before, op)[op.list].find((c) => c.oracleId === op.oracleId)?.qty ?? 0;
      return had === now ? [] : [{ kind: 'adjust', list: op.list, oracleId: op.oracleId, delta: had - now }];
    }
    case 'rename':
      return [{ kind: 'rename', name: before.name }];
    case 'format':
      return [{ kind: 'format', format: before.format }];
    case 'commander':
      return [{ kind: 'commander', oracleId: before.commanderId ?? null }];
    case 'partner':
      return [
        { kind: 'partner', oracleId: before.partnerId ?? null },
        ...(before.twoCommanders ? [] : [{ kind: 'twoCommanders', on: false } as DeckOp]),
      ];
    case 'twoCommanders':
      if (op.on) return before.twoCommanders ? [] : [{ kind: 'twoCommanders', on: false }];
      // Aus: der zweite Commander war ins Hauptdeck gewandert — zurück auf seinen Platz.
      return [
        { kind: 'twoCommanders', on: true },
        ...(before.partnerId ? [
          { kind: 'adjust', list: 'cards', oracleId: before.partnerId, delta: -1 } as DeckOp,
          { kind: 'partner', oracleId: before.partnerId } as DeckOp,
        ] : []),
      ];
    case 'replaceLists':
      return [{ kind: 'replaceLists', cards: before.cards, sideboard: before.sideboard }];
  }
}

export interface HistoryGroup {
  from: number;
  to: number;
  lines: string[];
  /** Einträge der Gruppe, älteste zuerst */
  entries: DeckHistoryEntry[];
}

/** Änderungen, die so dicht aufeinander folgen, bilden eine Gruppe. */
export const GROUP_GAP_MS = 10 * 60_000;

/**
 * Verlauf → Gruppen, neueste zuerst. Kartenänderungen je Liste zusammengezählt
 * („+2 Bolt"), Umbenennen nur der letzte Name, sonst je Schritt eine Zeile.
 */
export function groupHistory(entries: readonly DeckHistoryEntry[], name: (oracleId: string) => string, gap = GROUP_GAP_MS): HistoryGroup[] {
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const groups: DeckHistoryEntry[][] = [];
  for (const e of sorted) {
    const last = groups[groups.length - 1];
    if (last && e.at - last[last.length - 1].at <= gap) last.push(e);
    else groups.push([e]);
  }
  return groups.reverse().map((g) => ({ from: g[0].at, to: g[g.length - 1].at, lines: describe(g, name), entries: g }));
}

const signed = (n: number) => (n > 0 ? `+${n}` : `−${-n}`);

function describe(group: readonly DeckHistoryEntry[], name: (oracleId: string) => string): string[] {
  const delta = new Map<string, number>(); // `${list}|${oracleId}`
  const order: string[] = [];
  const other: string[] = [];
  let renamed: string | null = null;
  for (const { op } of group) {
    switch (op.kind) {
      case 'adjust': {
        const k = `${op.list}|${op.oracleId}`;
        if (!delta.has(k)) order.push(k);
        delta.set(k, (delta.get(k) ?? 0) + op.delta);
        break;
      }
      case 'rename':
        renamed = op.name;
        break;
      case 'format':
        other.push(`Format: ${FORMAT_LABELS[op.format] ?? op.format}`);
        break;
      case 'commander':
        other.push(op.oracleId ? `Commander: ${name(op.oracleId)}` : 'Commander entfernt');
        break;
      case 'partner':
        other.push(op.oracleId ? `Zweiter Commander: ${name(op.oracleId)}` : 'Zweiter Commander entfernt');
        break;
      case 'twoCommanders':
        other.push(op.on ? 'Zwei Commander an' : 'Zwei Commander aus');
        break;
      case 'replaceLists':
        other.push(`Liste ersetzt (${op.cards.reduce((n, c) => n + c.qty, 0)} Karten)`);
        break;
    }
  }
  const lines: string[] = [];
  if (renamed != null) lines.push(`Umbenannt in „${renamed}"`);
  lines.push(...other);
  for (const k of order) {
    const d = delta.get(k)!;
    if (d === 0) continue;
    const [list, oracleId] = k.split('|');
    lines.push(`${signed(d)} ${name(oracleId)}${list === 'sideboard' ? ' (Sideboard)' : ''}`);
  }
  return lines.length ? lines : ['Keine Änderung unterm Strich'];
}

/** Rückgängig für eine Gruppe: die Wege zurück, neueste Änderung zuerst. */
export function undoOpsFor(group: Pick<HistoryGroup, 'entries'>): DeckOp[] {
  return [...group.entries].reverse().flatMap((e) => e.undo);
}
