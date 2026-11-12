/**
 * Probehand / „Deck testen" (PLAN.md M20): mischen, 7 ziehen, Mulligan nach London-Regel,
 * Karten ziehen und auf den Tisch legen — dazu die Rechnung, wie wahrscheinlich Länder und
 * einzelne Karten bis zu einem Zug kommen. Framework-frei; der Zufall kommt von außen,
 * damit Tests mit festem Startwert laufen.
 */
import type { DeckCard } from './types';

export type Rng = () => number;

/** Kleiner, schneller Zufall mit Startwert (mulberry32). */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates; gibt ein neues Array zurück. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Eine einzelne Karte im Spiel (jede Kopie eigene `uid`). */
export interface PlayCard {
  uid: number;
  oracleId: string;
}

export interface PlayState {
  /** oben = Index 0 */
  library: PlayCard[];
  hand: PlayCard[];
  /** ausgespielt (Goldfish) */
  table: PlayCard[];
  mulligans: number;
  /** so viele Karten muss man noch unter die Bibliothek legen (London) */
  toBottom: number;
  /** 0 = Starthand, sonst der laufende Zug */
  turn: number;
  /** auf dem Draw: schon in Zug 1 eine Karte */
  onDraw: boolean;
  /** Commander/Brawl: der erste Mulligan ist frei (Regel 103.5c) */
  freeMulligan: boolean;
}

export const HAND_SIZE = 7;

/** Bibliothek aus der Deckliste (ohne Commander — die liegen in der Befehlszone). */
export function libraryOf(cards: readonly DeckCard[]): PlayCard[] {
  const out: PlayCard[] = [];
  let uid = 1;
  for (const c of cards) for (let i = 0; i < c.qty; i++) out.push({ uid: uid++, oracleId: c.oracleId });
  return out;
}

function deal(cards: readonly PlayCard[], rng: Rng): { library: PlayCard[]; hand: PlayCard[] } {
  const lib = shuffle(cards, rng);
  return { hand: lib.slice(0, HAND_SIZE), library: lib.slice(HAND_SIZE) };
}

export function newGame(cards: readonly DeckCard[], rng: Rng, opts: { onDraw?: boolean; freeMulligan?: boolean } = {}): PlayState {
  return {
    ...deal(libraryOf(cards), rng),
    table: [],
    mulligans: 0,
    toBottom: 0,
    turn: 0,
    onDraw: !!opts.onDraw,
    freeMulligan: !!opts.freeMulligan,
  };
}

/** London-Mulligan: alles zurück, mischen, wieder 7 — danach N Karten unter die Bibliothek. */
export function mulligan(s: PlayState, rng: Rng): PlayState {
  const mulligans = s.mulligans + 1;
  const all = [...s.library, ...s.hand, ...s.table];
  return {
    ...s,
    ...deal(all, rng),
    table: [],
    mulligans,
    toBottom: Math.min(HAND_SIZE, Math.max(0, mulligans - (s.freeMulligan ? 1 : 0))),
    turn: 0,
  };
}

/** Karte aus der Hand unter die Bibliothek (nach einem Mulligan). */
export function putOnBottom(s: PlayState, uid: number): PlayState {
  if (s.toBottom <= 0) return s;
  const card = s.hand.find((c) => c.uid === uid);
  if (!card) return s;
  return { ...s, hand: s.hand.filter((c) => c.uid !== uid), library: [...s.library, card], toBottom: s.toBottom - 1 };
}

/** Oberste Karte ziehen (z. B. durch einen Effekt). */
export function drawCard(s: PlayState): PlayState {
  if (s.library.length === 0) return s;
  return { ...s, hand: [...s.hand, s.library[0]], library: s.library.slice(1) };
}

/** Nächster Zug: in Zug 1 auf dem Play ohne Karte, sonst eine ziehen. */
export function nextTurn(s: PlayState): PlayState {
  if (s.toBottom > 0) return s;
  const turn = s.turn + 1;
  const next = { ...s, turn };
  return turn === 1 && !s.onDraw ? next : drawCard(next);
}

/** Karte zwischen Hand und Tisch hin und her. */
export function toggleTable(s: PlayState, uid: number): PlayState {
  const inHand = s.hand.find((c) => c.uid === uid);
  if (inHand) return { ...s, hand: s.hand.filter((c) => c.uid !== uid), table: [...s.table, inHand] };
  const onTable = s.table.find((c) => c.uid === uid);
  if (onTable) return { ...s, table: s.table.filter((c) => c.uid !== uid), hand: [...s.hand, onTable] };
  return s;
}

// --- Rechnung (hypergeometrisch) ------------------------------------------------------

const lnFactCache: number[] = [0];
function lnFact(n: number): number {
  for (let i = lnFactCache.length; i <= n; i++) lnFactCache[i] = lnFactCache[i - 1] + Math.log(i);
  return lnFactCache[n];
}
function lnChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return lnFact(n) - lnFact(k) - lnFact(n - k);
}

/** P(genau k Treffer), wenn man n aus N Karten zieht, von denen K Treffer sind. */
export function hypergeom(N: number, K: number, n: number, k: number): number {
  if (n > N || k < 0 || k > n || k > K || n - k > N - K) return 0;
  return Math.exp(lnChoose(K, k) + lnChoose(N - K, n - k) - lnChoose(N, n));
}

/** P(mindestens k Treffer). */
export function atLeast(N: number, K: number, n: number, k: number): number {
  let p = 0;
  for (let i = Math.max(0, k); i <= Math.min(n, K); i++) p += hypergeom(N, K, n, i);
  return Math.min(1, p);
}

/** Verteilung der Länder in der Starthand: Index i = P(genau i Länder). */
export function landDistribution(librarySize: number, lands: number, handSize = HAND_SIZE): number[] {
  const n = Math.min(handSize, librarySize);
  return Array.from({ length: handSize + 1 }, (_, i) => hypergeom(librarySize, lands, n, i));
}

/** Gesehene Karten bis einschließlich Zug `turn` (Starthand + Ziehen; ohne Mulligan). */
export function cardsSeen(turn: number, onDraw: boolean): number {
  if (turn <= 0) return HAND_SIZE;
  return HAND_SIZE + turn - (onDraw ? 0 : 1);
}

/** P(mindestens eine von `copies` Karten bis Zug `turn`). */
export function chanceByTurn(librarySize: number, copies: number, turn: number, onDraw: boolean): number {
  const n = Math.min(librarySize, cardsSeen(turn, onDraw));
  return atLeast(librarySize, copies, n, 1);
}
