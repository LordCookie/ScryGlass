import { db, getMeta, setMeta } from '../db/db';
import type { HashEntry } from '../domain/types';
import { NdjsonBuffer } from './ndjson';
import { loadTokenCatalog } from './tokenCatalog';

/**
 * Bild-Matching für den Scanner (Scanner v2). Ergänzt/übertrifft OCR bei Showcase-/
 * Borderless-/Full-Art-Rahmen: der Kamera-Ausschnitt wird per **dHash** gehasht und
 * gegen den vorberechneten Hash-Index aller Druckausgaben verglichen (Hamming-Distanz).
 *
 * Der Hash MUSS Bit für Bit zur Pipeline passen (pipeline/hash_images.py):
 * Graustufe → auf (S+1)×S skalieren (S=16) → bit(row,col)=links>rechts, row-major,
 * MSB zuerst je Byte → 256 Bit / 32 Byte / 64 Hex.
 */

// pHash-Parameter (MÜSSEN zur Pipeline passen: pipeline/hash_images.py).
export const P_IMG = 32; // Graustufe auf P_IMG×P_IMG
export const P_HASH = 16; // obere P_HASH×P_HASH DCT-Koeffizienten → 256 Bit
const TOTAL_BITS = P_HASH * P_HASH; // 256
const HASH_BYTES = TOTAL_BITS / 8; // 32

const WORDS = HASH_BYTES / 4; // 8 × 32 Bit je Hash

// Popcount-Tabelle für Bytes (Hamming-Distanz).
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

// Orthonormale DCT-II-Basismatrix (n×n, row-major), einmal berechnet.
// C[k][x] = alpha(k)·cos(pi·(2x+1)·k/(2n)); alpha(0)=sqrt(1/n), sonst sqrt(2/n).
let DCTM: Float64Array | null = null;
function dctMatrix(n: number): Float64Array {
  if (DCTM && DCTM.length === n * n) return DCTM;
  const c = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const a = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    for (let x = 0; x < n; x++) c[k * n + x] = a * Math.cos((Math.PI * (2 * x + 1) * k) / (2 * n));
  }
  DCTM = c;
  return c;
}

/**
 * pHash eines Canvas/Videos als 64-Hex-String (identisch zur Pipeline): Graustufe →
 * P_IMG² → 2D-DCT (C·X·Cᵀ) → obere P_HASH²-Koeffizienten → bit = Koeff > Median.
 */
export function phashFromCanvas(src: HTMLCanvasElement | HTMLVideoElement): string {
  const n = P_IMG;
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;

  const X = new Float64Array(n * n); // Graustufe (ITU-R 601, wie PIL 'L')
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    X[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }

  const C = dctMatrix(n);
  // M = X · Cᵀ  →  M[i][j] = Σ_x X[i][x]·C[j][x]
  const M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const xi = i * n;
    for (let j = 0; j < n; j++) {
      const cj = j * n;
      let s = 0;
      for (let x = 0; x < n; x++) s += X[xi + x] * C[cj + x];
      M[xi + j] = s;
    }
  }
  // D = C · M  (nur die oberen P_HASH×P_HASH Koeffizienten)
  const low = new Float64Array(TOTAL_BITS);
  for (let k = 0; k < P_HASH; k++) {
    const ck = k * n;
    for (let j = 0; j < P_HASH; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += C[ck + i] * M[i * n + j];
      low[k * P_HASH + j] = s;
    }
  }

  // Median (bei gerader Anzahl: Mittel der beiden mittleren — wie numpy.median).
  const sorted = Float64Array.from(low).sort();
  const m = sorted.length;
  const med = m % 2 ? sorted[(m - 1) / 2] : (sorted[m / 2 - 1] + sorted[m / 2]) / 2;

  const bits = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < TOTAL_BITS; i++) bits[i] = low[i] > med ? 1 : 0;
  return packBitsMsb(bits);
}

/** Bits (MSB zuerst je Byte) → Hex-String. Muss zur Pipeline (bits_to_hex) passen. */
export function packBitsMsb(bits: ArrayLike<number>): string {
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
  }
  return bytesToHex(bytes);
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** Hex → Bytes (in `out` bei `offset`, sonst neues Array). */
export function hexToBytes(hex: string, out?: Uint8Array, offset = 0): Uint8Array {
  const b = out ?? new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[offset + i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}

/** Hamming-Distanz zweier Hex-Hashes (für Tests/Tuning). */
export function hammingHex(a: string, b: string): number {
  const ba = hexToBytes(a);
  const bb = hexToBytes(b);
  let d = 0;
  for (let i = 0; i < ba.length; i++) d += POPCOUNT[ba[i] ^ bb[i]];
  return d;
}

// --- In-Memory-Index --------------------------------------------------------
// Karten vorn [0, cardCount), Tokens dahinter [cardCount, count) — so sucht der Scanner
// Karten und Tokens getrennt (M14), ohne Mehraufwand je Eintrag: ein Token-Artwork darf
// nie eine Karte verdrängen und umgekehrt.

let buf: Uint8Array | null = null; // n * 32 Bytes, flach
let words: Uint32Array | null = null; // derselbe Speicher als 32-Bit-Wörter (schneller Vergleich)
let oracleIds: string[] = [];
let scryfallIds: string[] = [];
let count = 0;
let cardCount = 0;
let loading: Promise<void> | null = null;

/** Welcher Teil des Index: Karten (Standard) oder Tokens. */
export type HashKind = 'card' | 'token';

export function invalidateHashIndex(): void {
  buf = null;
  words = null;
  oracleIds = [];
  scryfallIds = [];
  count = 0;
  cardCount = 0;
  loading = null;
}

/** Karten im Bild-Index (ohne Tokens). */
export function hashCount(): number {
  return cardCount;
}

/** Token-Artworks im Bild-Index. */
export function tokenHashCount(): number {
  return count - cardCount;
}

function range(kind: HashKind): [number, number] {
  return kind === 'token' ? [cardCount, count] : [0, cardCount];
}

/** Lädt den Hash-Index aus Dexie in den RAM (einmal). Leer, wenn keine Hashes da. */
export async function loadHashIndex(): Promise<void> {
  if (buf) return;
  if (!loading) {
    loading = (async () => {
      const [all, tokens] = await Promise.all([db.hashes.toArray(), loadTokenCatalog()]);
      const rows = all.filter((r) => !tokens.oracleIds.has(r.oracleId));
      cardCount = rows.length;
      for (const r of all) if (tokens.oracleIds.has(r.oracleId)) rows.push(r);
      count = rows.length;
      buf = new Uint8Array(count * HASH_BYTES);
      oracleIds = new Array(count);
      scryfallIds = new Array(count);
      for (let i = 0; i < count; i++) {
        const r = rows[i];
        oracleIds[i] = r.oracleId;
        scryfallIds[i] = r.scryfallId;
        hexToBytes(r.h, buf, i * HASH_BYTES);
      }
      words = new Uint32Array(buf.buffer, buf.byteOffset, count * WORDS);
    })();
  }
  return loading;
}

// --- Import (streamt hashes.ndjson in Dexie) --------------------------------

const HASHES_META = 'hashesFor';
const tick = () => new Promise((r) => setTimeout(r, 0));

interface RawHash {
  id: string;
  o: string;
  h: string;
}

/** Streamt `hashes.ndjson` (kompakte Keys {id,o,h}) in die `hashes`-Tabelle;
 *  `gzip`: als `hashes.ndjson.gz` (GitHub, M15). */
export async function importHashes(
  base: string,
  onProgress?: (done: number) => void,
  signal?: AbortSignal,
  gzip = false,
): Promise<number> {
  const res = await fetch(`${base}/hashes.ndjson${gzip ? '.gz' : ''}`, signal ? { signal } : undefined);
  if (!res.ok || !res.body) throw new Error(`hashes.ndjson nicht ladbar (${res.status})`);
  const reader = (gzip ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body).getReader();
  const decoder = new TextDecoder();
  const nb = new NdjsonBuffer<RawHash>();
  let pending: HashEntry[] = [];
  let done = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    await db.hashes.bulkPut(pending);
    done += pending.length;
    pending = [];
    onProgress?.(done);
    await tick();
  };
  const map = (r: RawHash): HashEntry => ({ scryfallId: r.id, oracleId: r.o, h: r.h });
  for (;;) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    for (const r of nb.push(decoder.decode(value, { stream: true }))) {
      pending.push(map(r));
      if (pending.length >= 1500) await flush();
    }
  }
  for (const r of nb.flush()) pending.push(map(r));
  await flush();
  return done;
}

/**
 * Best-effort-Sync des Hash-Index (Scanner v2). Läuft im Hintergrund nach dem
 * Katalog-Start; fehlt `hashes.ndjson` im Release/Bundle, passiert einfach nichts
 * (Scanner bleibt bei OCR). Idempotent über die Katalogversion.
 */
export async function syncHashes(
  base: string,
  catalogVersion: string | undefined,
  onProgress?: (done: number) => void,
  gzip = false,
): Promise<'imported' | 'skipped' | 'absent'> {
  if (catalogVersion) {
    const done = await getMeta<string>(HASHES_META);
    if (done === catalogVersion && (await db.hashes.count()) > 0) return 'skipped';
  }
  try {
    await importHashes(base, onProgress, undefined, gzip);
  } catch {
    return 'absent';
  }
  if (catalogVersion) await setMeta(HASHES_META, catalogVersion);
  invalidateHashIndex();
  return 'imported';
}

export interface HashMatch {
  oracleId: string;
  scryfallId: string;
  /** Hamming-Distanz (0..256; klein = besser). */
  distance: number;
  /** Abstand zum zweitbesten Treffer (groß = eindeutig). */
  margin: number;
  /** 0..1 Confidence aus der Distanz. */
  score: number;
}

/** Positionen im Hash-Index, deren Ausgabe in `ids` liegt (Set-Modus, nur Karten). */
export function hashIndicesFor(ids: ReadonlySet<string>): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < cardCount; i++) if (ids.has(scryfallIds[i])) out.push(i);
  return Int32Array.from(out);
}

/** Hash (Hex) → 8 × 32-Bit-Wörter in derselben Byte-Lage wie der Index. */
function toWords(hex: string): Uint32Array {
  const b = hexToBytes(hex);
  return new Uint32Array(b.buffer, b.byteOffset, WORDS);
}

/** Gesetzte Bits eines 32-Bit-Worts (SWAR — schneller als die Byte-Tabelle). */
export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/**
 * Nächster Referenz-Hash zum Query-Hash (linearer Hamming-Scan). `null`, wenn kein
 * Index geladen ist. `subset` (Set-Modus): nur diese Index-Positionen vergleichen —
 * auch der Margin zählt dann nur Karten aus dem Set als Konkurrenz.
 */
export function nearestByHash(hashHex: string, subset?: Int32Array, kind: HashKind = 'card'): HashMatch | null {
  return nearestByHashMulti([hashHex], subset, kind);
}

/** Vorauswahl über die ersten 64 Bit: höchstens so viele abweichende Bits. Zufällige
 *  Karten liegen bei ~32 ± 4 (≈ 1 % kommt durch), ein echter Treffer mit Gesamtabstand
 *  ≤ 56 bei ~14 ± 3 — er fällt praktisch nie heraus (bei 56 ≈ 1 %, darunter seltener). */
const PREFILTER_MAX = 22;

/** Vorsprung (Margin) wird höchstens bis hier ausgerechnet — alle Schwellen im Scanner
 *  liegen weit darunter (≤ 18); so bricht der Konkurrenz-Lauf früh ab. */
export const MARGIN_CAP = 48;

/**
 * Bester Treffer über mehrere Query-Hashes (Varianten desselben Bildes: Ausschnitte,
 * 180°-Drehung, Einrast-/Versatz-Varianten). Zweistufig, damit viele Varianten schnell
 * bleiben: (1) alle Einträge grob über die ersten 64 Bit gegen alle Varianten, (2) nur
 * die Kandidaten exakt. Die Variante mit der kleinsten Distanz gewinnt. Gibt es keinen
 * Kandidaten (nichts liegt auch nur grob nahe), zählt die exakte Suche mit der ersten
 * Variante. Danach ein Lauf nur für die Gewinner-Variante: Abstand zur nächsten FREMDEN
 * Karte (Reprints desselben Oracle zählen nicht — der Margin misst „wie klar besser").
 */
export function nearestByHashMulti(
  hashes: readonly string[],
  subset?: Int32Array,
  kind: HashKind = 'card',
): HashMatch | null {
  const W = words;
  if (!buf || !W || count === 0) return null;
  const qs = hashes.filter(Boolean).map(toWords);
  if (qs.length === 0) return null;
  // Ohne Teilmenge: der Bereich der Art (Karten bzw. Tokens), Position = lo + s.
  const [lo, hi] = range(kind);
  const n = subset ? subset.length : hi - lo;
  if (n === 0) return null;

  // Stufe 1: grobe Vorauswahl (Eintrag, Variante).
  const candIdx: number[] = [];
  const candVar: number[] = [];
  for (let s = 0; s < n; s++) {
    const i = subset ? subset[s] : lo + s;
    const off = i * WORDS;
    const w0 = W[off];
    const w1 = W[off + 1];
    for (let v = 0; v < qs.length; v++) {
      const q = qs[v];
      if (popcount32(q[0] ^ w0) + popcount32(q[1] ^ w1) <= PREFILTER_MAX) {
        candIdx.push(i);
        candVar.push(v);
      }
    }
  }

  // Stufe 2: Kandidaten exakt (sonst: erste Variante über alles).
  let best = 257;
  let bi = -1;
  let bv = 0;
  const exact = (i: number, v: number) => {
    const q = qs[v];
    const off = i * WORDS;
    let d = 0;
    for (let k = 0; k < WORDS && d < best; k++) d += popcount32(q[k] ^ W[off + k]);
    if (d < best) {
      best = d;
      bi = i;
      bv = v;
    }
  };
  if (candIdx.length) {
    for (let c = 0; c < candIdx.length; c++) exact(candIdx[c], candVar[c]);
  } else {
    for (let s = 0; s < n; s++) exact(subset ? subset[s] : lo + s, 0);
  }
  if (bi < 0) return null;

  const bestOracle = oracleIds[bi];
  const q = qs[bv];
  let secondDiff = Math.min(257, best + MARGIN_CAP);
  for (let s = 0; s < n; s++) {
    const i = subset ? subset[s] : lo + s;
    if (oracleIds[i] === bestOracle) continue;
    const off = i * WORDS;
    let d = 0;
    for (let k = 0; k < WORDS && d < secondDiff; k++) d += popcount32(q[k] ^ W[off + k]);
    if (d < secondDiff) secondDiff = d;
  }
  return {
    oracleId: bestOracle,
    scryfallId: scryfallIds[bi],
    distance: best,
    margin: secondDiff - best,
    score: 1 - best / TOTAL_BITS,
  };
}

/**
 * Abstand der Query-Hashes zur Karte `oracleId` (beste Ausgabe, beste Variante) —
 * fürs Scan-Protokoll: lag die richtige Karte knapp daneben oder völlig weg?
 * (PLAN.md § 6.2, Schritt 1). Linearer Scan; läuft nur beim Protokollieren.
 */
export function distanceToOracle(hashes: readonly string[], oracleId: string): { distance: number; scryfallId: string } | null {
  if (!buf || count === 0) return null;
  const qs = hashes.filter(Boolean).map((h) => hexToBytes(h));
  if (qs.length === 0) return null;
  let best = 257;
  let bi = -1;
  for (let i = 0; i < count; i++) {
    if (oracleIds[i] !== oracleId) continue;
    const off = i * HASH_BYTES;
    for (const q of qs) {
      let dist = 0;
      for (let k = 0; k < HASH_BYTES; k++) dist += POPCOUNT[q[k] ^ buf[off + k]];
      if (dist < best) {
        best = dist;
        bi = i;
      }
    }
  }
  return bi < 0 ? null : { distance: best, scryfallId: scryfallIds[bi] };
}

export interface PrintingDistance {
  oracleId: string;
  scryfallId: string;
  distance: number;
}

/**
 * Die bildnächsten Ausgaben unter bestimmten Karten (beste Variante je Ausgabe),
 * aufsteigend — für Tokens: welches Artwork der gelesenen Namen passt am besten?
 * Linear über den Bereich der Art (Tokens: wenige tausend Einträge).
 */
export function nearestPrintingsOf(
  hashes: readonly string[],
  oracles: ReadonlySet<string>,
  limit: number,
  kind: HashKind = 'token',
): PrintingDistance[] {
  const W = words;
  if (!W || count === 0 || oracles.size === 0) return [];
  const qs = hashes.filter(Boolean).map(toWords);
  if (qs.length === 0) return [];
  const [lo, hi] = range(kind);
  const out: PrintingDistance[] = [];
  for (let i = lo; i < hi; i++) {
    if (!oracles.has(oracleIds[i])) continue;
    const off = i * WORDS;
    let best = 257;
    for (const q of qs) {
      let d = 0;
      for (let k = 0; k < WORDS && d < best; k++) d += popcount32(q[k] ^ W[off + k]);
      if (d < best) best = d;
    }
    out.push({ oracleId: oracleIds[i], scryfallId: scryfallIds[i], distance: best });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, limit);
}

/**
 * Das verlässlichere von zwei Ergebnissen (z. B. eingerastete Karte vs. Rahmen): der
 * größere Vorsprung vor der nächsten fremden Karte gewinnt, bei Gleichstand die kleinere
 * Distanz. So ist ein misslungenes Einrasten nie schlechter als der Rahmen allein.
 */
export function betterMatch(a: HashMatch | null, b: HashMatch | null): HashMatch | null {
  if (!a) return b;
  if (!b) return a;
  if (a.margin !== b.margin) return a.margin > b.margin ? a : b;
  return a.distance <= b.distance ? a : b;
}
