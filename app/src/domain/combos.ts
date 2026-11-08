/**
 * Kombos aus Commander Spellbook (PLAN.md M17), kompakt und offline. Die Pipeline
 * (pipeline/fetch_combos.py) schreibt `combos.ndjson`: eine Kopfzeile mit allen Karten
 * und Ergebnissen, danach je Kombo eine Zeile, die per Index darauf zeigt. Hier wird
 * daraus ein spaltenweiser Speicher (Typed Arrays, eine Zeile je Index) — klein genug,
 * um ihn als Ganzes in IndexedDB zu legen und bei Bedarf in den Speicher zu holen.
 *
 * Die Sterne (1–4) sind ScryGlass-eigen und kommen fertig aus der Pipeline:
 *   4 = gewinnt allein, 2 Karten, ≤ 4 Mana · 3 = gewinnt allein, 2 Karten oder 3 mit ≤ 6 Mana
 *   2 = gewinnt allein mit mehr Aufwand · 1 = braucht noch etwas dazu
 */

/** Kopfzeile von combos.ndjson. */
export interface ComboHead {
  meta: { source: string; url?: string; version: string; timestamp: string; count: number };
  cards: string[];
  results: string[];
}

/** Zeile: [id, Karten, Sterne, Manawert(-1 = ?), Ergebnisse, Farben, Commander-Maske, Beliebtheit, Mana, nötige Karten] */
export type ComboRow = [string, number[], number, number, number[], string, number, number, string, number];

export interface ComboStore {
  meta: ComboHead['meta'];
  /** oracleIds */
  cards: string[];
  /** Ergebnis-Namen von Spellbook (englisch, `resultLabel` übersetzt die häufigen) */
  results: string[];
  ids: string[];
  /** Karten der Kombo i: cardIdx[cardStart[i] .. cardStart[i+1]) */
  cardStart: Uint32Array;
  cardIdx: Uint16Array;
  stars: Uint8Array;
  /** nötiges Mana (Manawert), -1 = unbekannt */
  mv: Int16Array;
  /** nötige Karten (ohne die, die in der Bibliothek liegen bleiben) */
  need: Uint8Array;
  resStart: Uint32Array;
  resIdx: Uint16Array;
  /** Farbidentität als Bitmaske W=1 U=2 B=4 R=8 G=16 */
  colors: Uint8Array;
  /** Bit i: Karte i muss der Commander sein */
  cmdMask: Uint8Array;
  pop: Uint32Array;
  mana: string[];
}

const COLOR_BITS: Record<string, number> = { W: 1, U: 2, B: 4, R: 8, G: 16 };

export function colorMask(identity: string): number {
  let m = 0;
  for (const c of identity.toUpperCase()) m |= COLOR_BITS[c] ?? 0;
  return m;
}

/** Kopf + Zeilen → spaltenweiser Speicher. */
export function packCombos(head: ComboHead, rows: readonly ComboRow[]): ComboStore {
  const n = rows.length;
  const cardStart = new Uint32Array(n + 1);
  const resStart = new Uint32Array(n + 1);
  let cardTotal = 0;
  let resTotal = 0;
  rows.forEach((r, i) => {
    cardStart[i] = cardTotal;
    resStart[i] = resTotal;
    cardTotal += r[1].length;
    resTotal += r[4].length;
  });
  cardStart[n] = cardTotal;
  resStart[n] = resTotal;
  const cardIdx = new Uint16Array(cardTotal);
  const resIdx = new Uint16Array(resTotal);
  const stars = new Uint8Array(n);
  const mv = new Int16Array(n);
  const need = new Uint8Array(n);
  const colors = new Uint8Array(n);
  const cmdMask = new Uint8Array(n);
  const pop = new Uint32Array(n);
  rows.forEach((r, i) => {
    cardIdx.set(r[1], cardStart[i]);
    resIdx.set(r[4], resStart[i]);
    stars[i] = r[2];
    mv[i] = r[3];
    colors[i] = colorMask(r[5]);
    cmdMask[i] = r[6];
    pop[i] = r[7];
    need[i] = r[9] ?? r[1].length;
  });
  return {
    meta: head.meta,
    cards: head.cards,
    results: head.results,
    ids: rows.map((r) => r[0]),
    cardStart, cardIdx, stars, mv, need, resStart, resIdx, colors, cmdMask, pop,
    mana: rows.map((r) => r[8]),
  };
}

/** Speicher + Nachschlagetabellen, einmal je Sitzung gebaut. */
export interface ComboIndex {
  store: ComboStore;
  /** oracleId → Kartenindex */
  cardOf: Map<string, number>;
  /** Kombos je Karte: byCard[byCardStart[k] .. byCardStart[k+1]) */
  byCardStart: Uint32Array;
  byCard: Uint32Array;
}

export function indexCombos(store: ComboStore): ComboIndex {
  const nCards = store.cards.length;
  const counts = new Uint32Array(nCards + 1);
  for (let j = 0; j < store.cardIdx.length; j++) counts[store.cardIdx[j] + 1]++;
  for (let k = 0; k < nCards; k++) counts[k + 1] += counts[k];
  const byCardStart = counts.slice();
  const fill = counts.slice(0, nCards);
  const byCard = new Uint32Array(store.cardIdx.length);
  for (let i = 0; i < store.ids.length; i++) {
    for (let j = store.cardStart[i]; j < store.cardStart[i + 1]; j++) byCard[fill[store.cardIdx[j]]++] = i;
  }
  return { store, cardOf: new Map(store.cards.map((id, k) => [id, k])), byCardStart, byCard };
}

/** oracleIds der Kombo i (in der Reihenfolge von Spellbook). */
export function comboCards(ix: ComboIndex, i: number): string[] {
  const s = ix.store;
  const out: string[] = [];
  for (let j = s.cardStart[i]; j < s.cardStart[i + 1]; j++) out.push(s.cards[s.cardIdx[j]]);
  return out;
}

export function comboResults(ix: ComboIndex, i: number): string[] {
  const s = ix.store;
  const out: string[] = [];
  for (let j = s.resStart[i]; j < s.resStart[i + 1]; j++) out.push(s.results[s.resIdx[j]]);
  return out;
}

/** Alle Kombos, in denen mindestens eine der Karten vorkommt. */
export function combosWithAny(ix: ComboIndex, oracleIds: Iterable<string>): Set<number> {
  const out = new Set<number>();
  for (const id of oracleIds) {
    const k = ix.cardOf.get(id);
    if (k == null) continue;
    for (let j = ix.byCardStart[k]; j < ix.byCardStart[k + 1]; j++) out.add(ix.byCard[j]);
  }
  return out;
}

export interface ComboHit {
  i: number;
  /** fehlende oracleIds (leer = vollständig) */
  missing: string[];
}

/**
 * Welche Kombos lassen sich aus diesen Karten bauen (höchstens `maxMissing` fehlen)?
 * `commander`: Karten, die laut Spellbook der Commander sein müssen, zählen nur, wenn sie
 * es sind — ohne Angabe (Sammlung) zählen sie normal. Sortiert: vollständige zuerst,
 * dann mehr Sterne, dann beliebter.
 */
export function findCombos(
  ix: ComboIndex,
  have: ReadonlySet<string>,
  opts: { maxMissing: 0 | 1; commander?: ReadonlySet<string> } = { maxMissing: 0 },
): ComboHit[] {
  const s = ix.store;
  const hits: ComboHit[] = [];
  // Nur Kombos prüfen, die überhaupt eine der Karten enthalten.
  for (const i of combosWithAny(ix, have)) {
    const missing: string[] = [];
    let bit = 0;
    for (let j = s.cardStart[i]; j < s.cardStart[i + 1]; j++, bit++) {
      const id = s.cards[s.cardIdx[j]];
      const mustLead = opts.commander != null && (s.cmdMask[i] & (1 << bit)) !== 0;
      const ok = mustLead ? opts.commander!.has(id) : have.has(id);
      if (!ok) {
        missing.push(id);
        if (missing.length > opts.maxMissing) break;
      }
    }
    if (missing.length <= opts.maxMissing) hits.push({ i, missing });
  }
  return hits.sort(
    (a, b) => a.missing.length - b.missing.length || s.stars[b.i] - s.stars[a.i] || s.pop[b.i] - s.pop[a.i] || a.i - b.i,
  );
}

/** Kombos, die eine dieser Karten benutzen (Suche nach Karte), stärkste und beliebteste zuerst. */
export function combosUsing(ix: ComboIndex, oracleIds: Iterable<string>): number[] {
  const s = ix.store;
  return [...combosWithAny(ix, oracleIds)].sort((a, b) => s.stars[b] - s.stars[a] || s.pop[b] - s.pop[a] || a - b);
}

/** Link zur Kombo bei Commander Spellbook (Ablauf, Voraussetzungen — dort ausführlich). */
export function spellbookUrl(id: string): string {
  return `https://commanderspellbook.com/combo/${encodeURIComponent(id)}/`;
}

// --- Ergebnisse auf Deutsch (die häufigsten; Rest bleibt englisch) ------------

const RESULT_DE: Record<string, string> = {
  'Win the game': 'Gewinnt das Spiel',
  'Each opponent loses the game': 'Alle Gegner verlieren',
  'Target opponent loses the game': 'Ein Gegner verliert',
  'Infinite colored mana': 'Endlos farbiges Mana',
  'Infinite colorless mana': 'Endlos farbloses Mana',
  'Infinite white mana': 'Endlos weißes Mana',
  'Infinite blue mana': 'Endlos blaues Mana',
  'Infinite black mana': 'Endlos schwarzes Mana',
  'Infinite red mana': 'Endlos rotes Mana',
  'Infinite green mana': 'Endlos grünes Mana',
  'Infinite mana creatures you control can produce': 'Endlos Mana (Kreaturen)',
  'Infinite mana lands you control can produce': 'Endlos Mana (Länder)',
  'Infinite mana permanents you control can produce': 'Endlos Mana (bleibende Karten)',
  'Infinite mana artifacts you control can produce': 'Endlos Mana (Artefakte)',
  'Infinite creature tokens': 'Endlos Kreaturen-Spielsteine',
  'Infinite creature tokens with haste': 'Endlos Spielsteine mit Eile',
  'Infinite tapped creature tokens': 'Endlos getappte Spielsteine',
  'Infinite artifact tokens': 'Endlos Artefakt-Spielsteine',
  'Infinite Treasure tokens': 'Endlos Schätze',
  'Infinite card draw': 'Endlos Karten ziehen',
  'Infinite lifegain': 'Endlos Lebenspunkte',
  'Infinite lifegain triggers': 'Endlos Lebensgewinn-Auslöser',
  'Infinite lifeloss': 'Endlos Lebensverlust',
  'Infinite damage': 'Endlos Schaden',
  'Infinite combat damage': 'Endlos Kampfschaden',
  'Infinite turns': 'Endlos Züge',
  'Infinite combat phases': 'Endlos Kampfphasen',
  'Infinite self-mill': 'Eigene Bibliothek ganz millen',
  'Infinite mill': 'Endlos millen',
  'Infinite surveil': 'Endlos Überwachen',
  'Infinite +1/+1 counters on creatures you control': 'Endlos +1/+1-Marken (eigene Kreaturen)',
  'Infinite +1/+1 counters on a creature': 'Endlos +1/+1-Marken (eine Kreatur)',
  'Infinitely large creature until end of turn': 'Endlos große Kreatur bis Zugende',
  'Infinite untap of lands you control': 'Endlos Länder enttappen',
  'Infinite untap of creatures': 'Endlos Kreaturen enttappen',
  'Infinite untap of permanents you control': 'Endlos bleibende Karten enttappen',
  'Infinite looting': 'Endlos Looten',
  'Infinite rummaging': 'Endlos Wühlen',
  'Infinite proliferate': 'Endlos Vermehren',
  'Infinite recursion of creature cards in your graveyard': 'Endlos Kreaturen aus dem Friedhof',
  'Infinite commander casts': 'Commander endlos wirken',
};

export function resultLabel(name: string): string {
  if (RESULT_DE[name]) return RESULT_DE[name];
  const near = /^Near-infinite (.+)$/.exec(name);
  if (near) {
    const base = RESULT_DE[`Infinite ${near[1]}`];
    if (base) return base.replace(/^Endlos/, 'Fast endlos');
  }
  return name;
}
