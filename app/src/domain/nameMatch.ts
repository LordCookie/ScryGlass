/**
 * Namensabgleich für den Scanner (PLAN.md § 5, M4). Framework-frei, rein testbar.
 *
 * Der Levenshtein-Kern stammt aus engram; die Suchstrategie ist neu: Der Katalog
 * hat 30k+ Karten, also läuft der Abgleich gestaffelt gegen einen In-Memory-Index:
 *
 *   normalize(ocr)
 *     → 1. Exakt-Treffer      O(1) Map-Lookup, trifft meistens
 *     → 2. Präfix-Treffer     OCR schneidet das Ende gern ab
 *     → 3. Fuzzy-Fallback     Trigramme → Kandidaten → Levenshtein (nur bei Miss)
 *     → 4. kein Treffer über Schwelle → manuelle Eingabe
 *
 * Alle Schritte laufen synchron gegen den RAM-Index; die Trigramm-Postings für
 * Schritt 3 baut der Index beim ersten Miss selbst (`trigramPostings`). Das Laden
 * aus Dexie liegt in `data/matcher.ts`, hier bleibt die reine Logik.
 */

import type { Lang, NameEntry } from './types';

// --- Normalisierung (MUSS zur Pipeline passen, pipeline/fetch_scryfall.py) ------

const LIGATURES: Record<string, string> = {
  æ: 'ae', œ: 'oe', ø: 'o', ð: 'd', þ: 'th', ß: 'ss', đ: 'd', ł: 'l',
};

/**
 * Vergleichsform eines Namens (PLAN.md § 2): lowercase → Diakritika strippen
 * (ö→o, æ→ae) → Apostroph/Komma/Bindestrich/Punkt raus → übrige Nicht-Alphanumerik
 * zu Leerzeichen → Whitespace kollabieren. Muss Zeichen für Zeichen zur Python-Seite
 * (`normalize_name`) passen, sonst greift der Exakt-Treffer nicht.
 */
export function normalizeName(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) out += LIGATURES[ch] ?? ch;
  // Diakritika entfernen (NFKD + kombinierende Zeichen weg).
  out = out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Apostrophe (auch typografische), Komma, Bindestrich, Punkt ersatzlos raus.
  out = out.replace(/['’‘`,\-.]/g, '');
  // Alles übrige, das nicht a-z0-9 ist, wird Trenner; dann Whitespace kollabieren.
  out = out.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  return out;
}

/** Häufige OCR-Verwechsler Ziffer↔Buchstabe falten (nur für den Fuzzy-Vergleich). */
const OCR_FOLD: Record<string, string> = { '0': 'o', '1': 'i', '5': 's', '8': 'b' };
export function foldOcr(norm: string): string {
  let out = '';
  for (const ch of norm) out += OCR_FOLD[ch] ?? ch;
  return out;
}

/** 3er-Fenster über den normalisierten Namen (identisch zur Pipeline, § 5). */
export function trigramsOf(norm: string): string[] {
  const compact = norm; // Leerzeichen bleiben Teil der Trigramme (wie Pipeline)
  if (compact.length < 3) return compact ? [compact] : [];
  const out: string[] = [];
  for (let i = 0; i <= compact.length - 3; i++) out.push(compact.slice(i, i + 3));
  return out;
}

// --- Distanzen --------------------------------------------------------------

/** Klassische Levenshtein-Distanz (volle Strings). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Kleinste Editierdistanz, um `pattern` als Teilstring in `text` zu finden
 * (Auslassungen am Anfang/Ende von `text` sind gratis) — verzeiht OCR-Rauschen
 * rund um den Namen. Aus engram übernommen.
 */
export function fuzzySubstringDistance(pattern: string, text: string): number {
  const m = pattern.length;
  const n = text.length;
  if (m === 0) return 0;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = pattern[i - 1] === text[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
    }
    prev = cur;
  }
  let best = prev[0];
  for (let j = 1; j <= n; j++) if (prev[j] < best) best = prev[j];
  return best;
}

// --- Ergebnis-Typen ---------------------------------------------------------

export type MatchMethod = 'exact' | 'prefix' | 'fuzzy';

export interface NameCandidate {
  oracleId: string;
  lang: Lang;
  /** normalisierter Name, gegen den getroffen wurde. */
  normName: string;
  /** 0..1 — Confidence (fließt in Scan-Konsens und Peer-Korb, § 8). */
  score: number;
  method: MatchMethod;
}

// --- In-Memory-Namensindex (E3) ---------------------------------------------

interface IndexedName {
  normName: string;
  oracleId: string;
  lang: Lang;
}

/**
 * Namensindex im RAM (PLAN.md E3): beim Start einmal aus `names` gefüllt, danach
 * pro Scan null DB-Zugriffe für Exakt/Präfix. Reverse-Map oracleId→Namen dient dem
 * Fuzzy-Ranking, ohne erneut in Dexie zu gehen.
 */
export class NameIndex {
  /** normName → Einträge (mehrere bei DE/EN oder Kollisionen). */
  private exact = new Map<string, IndexedName[]>();
  /** aufsteigend sortierte, eindeutige normNames — für Präfix-Bereichssuche. */
  private sortedKeys: string[] = [];
  /** oracleId → normNames (für Fuzzy-Ranking ohne DB). */
  private namesByOracle = new Map<string, IndexedName[]>();

  constructor(entries: readonly NameEntry[]) {
    for (const e of entries) {
      const n: IndexedName = { normName: e.normName, oracleId: e.oracleId, lang: e.lang };
      const list = this.exact.get(e.normName);
      if (list) list.push(n);
      else this.exact.set(e.normName, [n]);
      const byo = this.namesByOracle.get(e.oracleId);
      if (byo) byo.push(n);
      else this.namesByOracle.set(e.oracleId, [n]);
    }
    this.sortedKeys = [...this.exact.keys()].sort();
  }

  get size(): number {
    return this.exact.size;
  }

  private postings: Map<string, string[]> | null = null;

  /**
   * Trigramm-Postings (trigram → oracleIds) für den Fuzzy-Fallback (Schritt 3), beim
   * ersten Bedarf aus den Namen gebaut und gemerkt. Früher kamen sie als eigene
   * Katalog-Tabelle (`trigrams.ndjson`, über die Hälfte von Download und Import) —
   * aus den ~65.000 Namen sind sie in Sekundenbruchteilen berechnet. Jede oracleId
   * steht höchstens einmal je Trigramm (DE + EN zusammen); anders als die Pipeline
   * ohne Obergrenze je Trigramm.
   */
  trigramPostings(): ReadonlyMap<string, readonly string[]> {
    if (!this.postings) {
      const postings = new Map<string, string[]>();
      for (const [oracleId, names] of this.namesByOracle) {
        const tris = new Set<string>();
        for (const n of names) for (const t of trigramsOf(n.normName)) tris.add(t);
        for (const t of tris) {
          const list = postings.get(t);
          if (list) list.push(oracleId);
          else postings.set(t, [oracleId]);
        }
      }
      this.postings = postings;
    }
    return this.postings;
  }

  namesOf(oracleId: string): IndexedName[] {
    return this.namesByOracle.get(oracleId) ?? [];
  }

  /** Exakt-Treffer (Schritt 1). */
  lookupExact(norm: string): NameCandidate[] {
    const hits = this.exact.get(norm);
    if (!hits) return [];
    return hits.map((h) => ({ ...h, score: 1, method: 'exact' as const }));
  }

  /**
   * Präfix-Treffer (Schritt 2): Namen, die mit `norm` beginnen (OCR hat das Ende
   * abgeschnitten). Bereichssuche über die sortierten Keys. `norm` muss lang genug
   * sein (≥ 4), sonst matcht es zu viel.
   */
  lookupPrefix(norm: string, limit = 8): NameCandidate[] {
    if (norm.length < 4) return [];
    const start = lowerBound(this.sortedKeys, norm);
    const out: NameCandidate[] = [];
    for (let i = start; i < this.sortedKeys.length && out.length < limit; i++) {
      const key = this.sortedKeys[i];
      if (!key.startsWith(norm)) break;
      if (key === norm) continue; // wäre schon Exakt-Treffer
      const coverage = norm.length / key.length;
      const score = Math.min(0.99, 0.7 + 0.29 * coverage);
      for (const h of this.exact.get(key) ?? []) out.push({ ...h, score, method: 'prefix' });
    }
    return out;
  }
}

/** Kleinster Index i mit sortedKeys[i] >= target (Standard-lower_bound). */
function lowerBound(arr: readonly string[], target: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Fuzzy-Ranking (Schritt 3): OCR-Text gegen eine Kandidatenmenge (via Trigramm-
 * Overlap vorgefiltert). Nutzt Verwechsler-Faltung + Fuzzy-Substring-Distanz und
 * gibt die Top-N nach Confidence zurück. `candidates` sind (oracleId, normName, lang).
 */
export function rankFuzzy(
  ocrNorm: string,
  candidates: readonly IndexedName[],
  topN = 5,
): NameCandidate[] {
  const ocrFold = foldOcr(ocrNorm);
  const out: NameCandidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = c.oracleId + '|' + c.lang;
    if (seen.has(key)) continue;
    seen.add(key);
    const pat = foldOcr(c.normName);
    if (!pat) continue;
    const dist = fuzzySubstringDistance(pat, ocrFold);
    const matched = Math.max(0, pat.length - dist);
    // Confidence: Anteil korrekt getroffener Namenszeichen, längengewichtet, damit
    // ein zufälliges kurzes Teilwort keine 100 % erreicht.
    const ratio = matched / pat.length;
    const lengthWeight = Math.min(1, pat.length / 6);
    const score = ratio * lengthWeight;
    if (score > 0) out.push({ ...c, score, method: 'fuzzy' });
  }
  out.sort((a, b) => b.score - a.score || (a.oracleId < b.oracleId ? -1 : 1));
  return out.slice(0, topN);
}

/**
 * Kandidaten-oracleIds nach Trigramm-Overlap (Schritt 3, Vorfilter): zählt, in wie
 * vielen Trigrammen des OCR-Textes eine oracleId vorkommt, und gibt die Top-N zurück.
 * `postings` ist trigram → oracleIds (`NameIndex.trigramPostings`).
 */
export function topTrigramCandidates(
  ocrNorm: string,
  postings: ReadonlyMap<string, readonly string[]>,
  limit = 20,
): string[] {
  const counts = new Map<string, number>();
  for (const tri of new Set(trigramsOf(ocrNorm))) {
    const ids = postings.get(tri);
    if (!ids) continue;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([id]) => id);
}

export interface MatchResult {
  norm: string;
  candidates: NameCandidate[];
  best?: NameCandidate;
  /** true, wenn mehrere Kandidaten mit gleichem Top-Score konkurrieren (Nachfrage). */
  ambiguous: boolean;
}

/**
 * Voller gestaffelter Abgleich (PLAN.md § 5). Synchron und rein: die Dexie-
 * Trigramm-Postings werden vom Aufrufer (`data/matcher.ts`) vorab geladen und als
 * `fuzzyPostings` übergeben. Ohne Postings entfällt nur der Fuzzy-Fallback.
 */
export function matchName(
  ocrText: string,
  index: NameIndex,
  fuzzyPostings: ReadonlyMap<string, readonly string[]> | null = null,
  opts: { threshold?: number; topN?: number } = {},
): MatchResult {
  const topN = opts.topN ?? 5;
  const threshold = opts.threshold ?? 0.55;
  const norm = normalizeName(ocrText);
  if (!norm) return { norm, candidates: [], ambiguous: false };

  // Schritt 1 — Exakt.
  const exact = index.lookupExact(norm);
  if (exact.length > 0) {
    return { norm, candidates: exact.slice(0, topN), best: exact[0], ambiguous: distinctOracles(exact) > 1 };
  }

  // Schritt 2 — Präfix (OCR schneidet das Ende ab).
  const prefix = index.lookupPrefix(norm, topN).sort((a, b) => b.score - a.score);
  if (prefix.length > 0) {
    return { norm, candidates: prefix, best: prefix[0], ambiguous: distinctOracles(prefix) > 1 };
  }

  // Schritt 3 — Fuzzy-Fallback (nur bei Miss, nur hier werden Trigramm-Postings gebraucht).
  if (fuzzyPostings) {
    const candIds = topTrigramCandidates(norm, fuzzyPostings, 20);
    const candNames = candIds.flatMap((id) => index.namesOf(id));
    const ranked = rankFuzzy(norm, candNames, topN).filter((c) => c.score >= threshold);
    if (ranked.length > 0) {
      return { norm, candidates: ranked, best: ranked[0], ambiguous: ambiguousTop(ranked) };
    }
  }

  // Schritt 4 — kein Treffer über Schwelle → manuelle Eingabe (best undefined).
  return { norm, candidates: [], ambiguous: false };
}

function distinctOracles(cands: readonly NameCandidate[]): number {
  return new Set(cands.map((c) => c.oracleId)).size;
}

/** Mehrdeutig, wenn zwei verschiedene Karten fast denselben Top-Score haben. */
function ambiguousTop(ranked: readonly NameCandidate[]): boolean {
  if (ranked.length < 2) return false;
  return ranked[0].oracleId !== ranked[1].oracleId && ranked[0].score - ranked[1].score < 0.08;
}
