import type { Deck, DeckCard, Finish, FormatId, OwnedBooking, Precon, PreconCard, PreconGroup } from './types';
import { normalizeName } from './nameMatch';

/**
 * Fertigdecks (Precons, PLAN.md M19) — reine Logik: Katalogzeilen lesen, filtern, in
 * Buchungen für die Sammlung umrechnen, Decks daraus bauen und das Wieder-Entfernen planen.
 * Daten von MTGJSON (pipeline/fetch_precons.py).
 */

/** Kopfzeile von precons.ndjson. */
export interface PreconHead {
  meta: { source: string; url?: string; version?: string; date?: string; count: number };
  printings: string[];
}

type Board = [number, number, number][];
/** [key, name, set, datum, gruppe, typ, commander, main, side, extra, tokens, unbekannt] */
export type PreconRow = [string, string, string, string, string, string, Board, Board, Board, Board, Board, number];

const FINISHES: Finish[] = ['nonfoil', 'foil', 'etched'];

export const PRECON_GROUPS: { key: PreconGroup; label: string }[] = [
  { key: 'commander', label: 'Commander' },
  { key: 'starter', label: 'Einsteiger' },
  { key: 'duel', label: 'Duel Decks' },
  { key: 'jumpstart', label: 'Jumpstart' },
  { key: 'secretlair', label: 'Secret Lair' },
  { key: 'other', label: 'Andere' },
];
const GROUP_KEYS = new Set<string>(PRECON_GROUPS.map((g) => g.key));

const TYPE_LABELS: Record<string, string> = {
  'Commander Deck': 'Commander-Deck',
  'Brawl Deck': 'Brawl-Deck',
  'Theme Deck': 'Themendeck',
  'Intro Pack': 'Intro Pack',
  'Planeswalker Deck': 'Planeswalker-Deck',
  'Welcome Deck': 'Willkommensdeck',
  'Welcome Booster': 'Willkommensbooster',
  'Starter Deck': 'Starterdeck',
  'Starter Kit': 'Starter Kit',
  'Spellslinger Starter Kit': 'Starter Kit',
  'Enhanced Deck': 'Erweitertes Deck',
  'Advanced Deck': 'Fortgeschrittenen-Deck',
  'Advanced Pack': 'Fortgeschrittenen-Pack',
  'Duel Deck': 'Duel Deck',
  Halfdeck: 'Halbes Deck',
  'Clash Pack': 'Clash Pack',
  Jumpstart: 'Jumpstart-Booster',
  'Secret Lair Drop': 'Secret Lair Drop',
  'Challenger Deck': 'Challenger Deck',
  'Pioneer Challenger Deck': 'Challenger Deck (Pioneer)',
  'Event Deck': 'Event Deck',
  'Modern Event Deck': 'Event Deck (Modern)',
  'Game Night Deck': 'Game Night',
  'Guild Kit': 'Gilden-Kit',
  'Box Set': 'Box Set',
  "Deck Builder's Toolkit": 'Deckbau-Toolkit',
  'Planechase Deck': 'Planechase',
  'Archenemy Deck': 'Archenemy',
  'Premium Deck': 'Premium Deck',
};

/** Deutscher Produkttyp; Unbekanntes bleibt englisch. */
export function preconTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

function board(head: PreconHead, b: unknown): PreconCard[] {
  if (!Array.isArray(b)) return [];
  const out: PreconCard[] = [];
  for (const e of b) {
    if (!Array.isArray(e)) continue;
    const p = head.printings[e[0] as number];
    const n = Number(e[1]);
    if (!p || !(n > 0)) continue;
    out.push({ p, n, f: FINISHES[e[2] as number] ?? 'nonfoil' });
  }
  return out;
}

/** Eine Zeile aus precons.ndjson → Fertigdeck (ohne Suchtext, der braucht Kartennamen). */
export function parsePreconRow(head: PreconHead, row: PreconRow): Omit<Precon, 'search'> {
  const [key, name, set, date, group, type, cmd, main, side, extra, tokens, unknown] = row;
  return {
    key: String(key),
    name: String(name || key),
    set: String(set || ''),
    date: String(date || ''),
    group: (GROUP_KEYS.has(group) ? group : 'other') as PreconGroup,
    type: String(type || ''),
    commander: board(head, cmd),
    main: board(head, main),
    side: board(head, side),
    extra: board(head, extra),
    tokens: board(head, tokens),
    unknown: Number(unknown) || 0,
  };
}

/** Suchtext: Deckname, Set-Code und die Namen der Commander (EN und DE). */
export function preconSearchText(p: Pick<Precon, 'name' | 'set'>, commanderNames: readonly string[] = []): string {
  return normalizeName([p.name, p.set, ...commanderNames].join(' '));
}

/** Filter für den Reiter: Gruppe und Suchtext (alle Wörter müssen vorkommen). */
export function filterPrecons<T extends Pick<Precon, 'group' | 'search'>>(
  list: readonly T[],
  opts: { group?: PreconGroup | null; query?: string },
): T[] {
  const words = normalizeName(opts.query ?? '').split(' ').filter(Boolean);
  return list.filter((p) => (!opts.group || p.group === opts.group) && words.every((w) => p.search.includes(w)));
}

/** Karten im Deck selbst (Commander + Main + Side), ohne Beilagen und Tokens. */
export function preconDeckSize(p: Pick<Precon, 'commander' | 'main' | 'side'>): number {
  return [...p.commander, ...p.main, ...p.side].reduce((s, c) => s + c.n, 0);
}

/** Lassen sich die Karten als Deck anlegen? Bei Secret Lair und Jumpstart nicht voreingestellt. */
export function preconMakesDeck(p: Pick<Precon, 'group'>): boolean {
  return p.group !== 'secretlair' && p.group !== 'jumpstart';
}

/** Was der Katalog über eine Druckausgabe weiß. */
export interface PrintingInfo {
  oracleId: string;
  token: boolean;
}

function bookingKey(b: Pick<OwnedBooking, 'oracleId' | 'finish' | 'printingId'>): string {
  return `${b.oracleId}|${b.finish}|${b.printingId ?? ''}`;
}

/**
 * Was „Zur Sammlung hinzufügen" bucht: alle Karten (Commander, Deck, Sideboard, Beilagen)
 * mit genauer Druckausgabe und Ausführung, mal `copies`. Tokens aus der Token-Liste nur
 * mit `withTokens`. Druckausgaben, die der Katalog nicht kennt, werden gezählt.
 */
export function preconBookings(
  p: Pick<Precon, 'commander' | 'main' | 'side' | 'extra' | 'tokens'>,
  printings: ReadonlyMap<string, PrintingInfo>,
  opts: { copies?: number; withTokens?: boolean } = {},
): { items: OwnedBooking[]; unknown: number; cards: number; tokens: number } {
  const copies = Math.max(1, Math.floor(opts.copies ?? 1));
  const merged = new Map<string, OwnedBooking>();
  let unknown = 0;
  let cards = 0;
  let tokens = 0;
  const add = (list: readonly PreconCard[]) => {
    for (const c of list) {
      const info = printings.get(c.p);
      if (!info) {
        unknown += c.n * copies;
        continue;
      }
      const b = { oracleId: info.oracleId, finish: c.f, printingId: c.p, qty: c.n * copies };
      const k = bookingKey(b);
      const cur = merged.get(k);
      if (cur) cur.qty += b.qty;
      else merged.set(k, b);
      if (info.token) tokens += b.qty;
      else cards += b.qty;
    }
  };
  add(p.commander);
  add(p.main);
  add(p.side);
  add(p.extra);
  if (opts.withTokens) add(p.tokens);
  return { items: [...merged.values()], unknown, cards, tokens };
}

function deckCards(list: readonly PreconCard[], printings: ReadonlyMap<string, PrintingInfo>): DeckCard[] {
  const qty = new Map<string, number>();
  for (const c of list) {
    const info = printings.get(c.p);
    if (!info || info.token) continue;
    qty.set(info.oracleId, (qty.get(info.oracleId) ?? 0) + c.n);
  }
  return [...qty].map(([oracleId, n]) => ({ oracleId, qty: n }));
}

/**
 * Deck aus dem Fertigdeck. Commander-Decks bekommen ihren Commander, ein zweiter (Partner,
 * Hintergrund) den zweiten Platz (M20); nur ein dritter (gibt es kaum) käme ins Hauptdeck.
 * Andere Decks bekommen Vintage — dort ist fast alles erlaubt; das Format lässt sich ändern.
 */
export function deckFromPrecon(
  p: Pick<Precon, 'name' | 'group' | 'type' | 'commander' | 'main' | 'side'>,
  printings: ReadonlyMap<string, PrintingInfo>,
  now = Date.now(),
): { deck: Omit<Deck, 'id'>; extraCommanders: number } {
  const leads = deckCards(p.commander, printings);
  const format: FormatId = p.group === 'commander' ? (/brawl/i.test(p.type) ? 'brawl' : 'commander') : 'vintage';
  const [commander, partner, ...others] = format === 'vintage' ? [] : leads;
  const main = deckCards(p.main, printings);
  const extra = format === 'vintage' ? leads : others;
  for (const c of extra) {
    const cur = main.find((m) => m.oracleId === c.oracleId);
    if (cur) cur.qty += c.qty;
    else main.unshift({ ...c });
  }
  return {
    deck: {
      name: p.name,
      format,
      ...(commander ? { commanderId: commander.oracleId } : {}),
      ...(partner ? { partnerId: partner.oracleId, twoCommanders: true } : {}),
      cards: main,
      sideboard: deckCards(p.side, printings),
      updatedAt: now,
    },
    extraCommanders: format === 'vintage' ? 0 : others.length,
  };
}

/**
 * „Wieder entfernen": genau die Buchungen abziehen, aber nie mehr, als noch da ist. Mehrere
 * Buchungen können auf denselben Bestand fallen (Karten zählen je Karte + Ausführung, nur
 * Tokens je Artwork) — `rowKey` sagt, welcher Bestand gemeint ist, `have` wie viel dort liegt.
 */
export function planRemoval(
  items: readonly OwnedBooking[],
  rowKey: (b: OwnedBooking) => string,
  have: ReadonlyMap<string, number>,
): { take: OwnedBooking[]; total: number; missing: number } {
  const left = new Map(have);
  const take: OwnedBooking[] = [];
  let total = 0;
  let missing = 0;
  for (const b of items) {
    total += b.qty;
    const k = rowKey(b);
    const avail = left.get(k) ?? 0;
    const n = Math.min(avail, b.qty);
    missing += b.qty - n;
    if (n > 0) {
      left.set(k, avail - n);
      take.push({ ...b, qty: n });
    }
  }
  return { take, total, missing };
}

/** Wie viele Karten des Decks (Commander + Main + Side) besitzt man schon? Je Karte höchstens so viele wie im Deck. */
export function ownedCoverage(
  p: Pick<Precon, 'commander' | 'main' | 'side'>,
  printings: ReadonlyMap<string, PrintingInfo>,
  ownedQty: ReadonlyMap<string, number>,
): { have: number; total: number } {
  const need = new Map<string, number>();
  let total = 0;
  for (const c of [...p.commander, ...p.main, ...p.side]) {
    total += c.n;
    const info = printings.get(c.p);
    if (info && !info.token) need.set(info.oracleId, (need.get(info.oracleId) ?? 0) + c.n);
  }
  let have = 0;
  for (const [oracleId, n] of need) have += Math.min(n, ownedQty.get(oracleId) ?? 0);
  return { have, total };
}
