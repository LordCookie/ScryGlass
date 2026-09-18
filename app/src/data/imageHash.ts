import { db, getMeta, setMeta } from '../db/db';
import type { HashEntry } from '../domain/types';
import { NdjsonBuffer } from './ndjson';

/**
 * Bild-Matching für den Scanner (Scanner v2). Ergänzt/übertrifft OCR bei Showcase-/
 * Borderless-/Full-Art-Rahmen: der Kamera-Ausschnitt wird per **dHash** gehasht und
 * gegen den vorberechneten Hash-Index aller Druckausgaben verglichen (Hamming-Distanz).
 *
 * Der Hash MUSS Bit für Bit zur Pipeline passen (pipeline/hash_images.py):
 * Graustufe → auf (S+1)×S skalieren (S=16) → bit(row,col)=links>rechts, row-major,
 * MSB zuerst je Byte → 256 Bit / 32 Byte / 64 Hex.
 */

export const HASH_SIZE = 16;
const HASH_BYTES = (HASH_SIZE * HASH_SIZE) / 8; // 32

// Popcount-Tabelle für Bytes (Hamming-Distanz).
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

/** dHash eines Canvas als 64-Hex-String (identische Bit-Ordnung wie die Pipeline). */
export function dhashFromCanvas(src: HTMLCanvasElement | HTMLVideoElement): string {
  const w = HASH_SIZE + 1;
  const h = HASH_SIZE;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  // Graustufe (ITU-R 601, wie PIL 'L').
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    g[p] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }

  const bits = new Uint8Array(HASH_SIZE * HASH_SIZE);
  let bit = 0;
  for (let row = 0; row < HASH_SIZE; row++) {
    for (let col = 0; col < HASH_SIZE; col++) {
      // bit = 1, wenn linker Pixel heller (identisch zur Pipeline).
      bits[bit++] = g[row * w + col] > g[row * w + col + 1] ? 1 : 0;
    }
  }
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

let buf: Uint8Array | null = null; // n * 32 Bytes, flach
let oracleIds: string[] = [];
let scryfallIds: string[] = [];
let count = 0;
let loading: Promise<void> | null = null;

export function invalidateHashIndex(): void {
  buf = null;
  oracleIds = [];
  scryfallIds = [];
  count = 0;
  loading = null;
}

export function hashCount(): number {
  return count;
}

/** Lädt den Hash-Index aus Dexie in den RAM (einmal). Leer, wenn keine Hashes da. */
export async function loadHashIndex(): Promise<void> {
  if (buf) return;
  if (!loading) {
    loading = (async () => {
      const rows = await db.hashes.toArray();
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

/** Streamt `hashes.ndjson` (kompakte Keys {id,o,h}) in die `hashes`-Tabelle. */
export async function importHashes(
  base: string,
  onProgress?: (done: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const res = await fetch(`${base}/hashes.ndjson`, signal ? { signal } : undefined);
  if (!res.ok || !res.body) throw new Error(`hashes.ndjson nicht ladbar (${res.status})`);
  const reader = res.body.getReader();
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
): Promise<'imported' | 'skipped' | 'absent'> {
  if (catalogVersion) {
    const done = await getMeta<string>(HASHES_META);
    if (done === catalogVersion && (await db.hashes.count()) > 0) return 'skipped';
  }
  try {
    await importHashes(base, onProgress);
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

/**
 * Nächster Referenz-Hash zum Query-Hash (linearer Hamming-Scan). `null`, wenn kein
 * Index geladen ist. Der lineare Scan über ~155k × 32 Byte ist wenige ms.
 */
export function nearestByHash(hashHex: string): HashMatch | null {
  if (!buf || count === 0) return null;
  const q = hexToBytes(hashHex);
  let best = 257;
  let second = 257;
  let bi = -1;
  for (let i = 0; i < count; i++) {
    const off = i * HASH_BYTES;
    let dist = 0;
    for (let k = 0; k < HASH_BYTES; k++) dist += POPCOUNT[q[k] ^ buf[off + k]];
    if (dist < best) {
      second = best;
      best = dist;
      bi = i;
    } else if (dist < second) {
      second = dist;
    }
  }
  if (bi < 0) return null;
  return {
    oracleId: oracleIds[bi],
    scryfallId: scryfallIds[bi],
    distance: best,
    margin: second - best,
    score: 1 - best / (HASH_SIZE * HASH_SIZE),
  };
}
