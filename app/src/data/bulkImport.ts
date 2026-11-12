import type { IndexableType, Table } from 'dexie';
import { NdjsonBuffer } from './ndjson';

/**
 * NDJSON von `url` streamen und in Chunks in eine Dexie-Tabelle schreiben (PLAN.md § 4) —
 * für den Katalog (data/catalog.ts) und den Bild-Index (data/imageHash.ts).
 *
 * Steht schon etwas in der Tabelle (Update statt Erstimport), wird nur Neues und
 * Geändertes geschrieben: Schreiben ist das Teure (Indizes), und von Woche zu Woche
 * ändert sich nur ein Bruchteil. Gemessen im Browser, gleicher Katalog nochmal:
 * Druckausgaben 23,3 s → 5,2 s, Karten 4,4 s → 1,9 s, Bild-Hashes 15,5 s → 1,3 s.
 *   - `keys`: Zeilen ändern sich nie, es kommen nur neue dazu (Namen sind ihr eigener
 *     Schlüssel; Bild-Hashes hasht hashes.yml nur für neue Ausgaben) — ein Blick auf die
 *     vorhandenen Schlüssel genügt.
 *   - `rows`: Zeilen können sich ändern (Karten, Druckausgaben) — je Chunk die alten
 *     lesen und vergleichen. Lesen ist ein Vielfaches schneller als Schreiben.
 * Was aus dem Katalog verschwindet, bleibt liegen (wie bisher): Sammlung und Decks
 * können noch darauf zeigen.
 *
 * Lesen und Schreiben laufen nebeneinander (M20, Big Screen): Das Netz liest bis zu
 * READ_AHEAD Chunks voraus, während geschrieben wird — vorher stand der Download still,
 * solange IndexedDB schrieb. Geschrieben wird in Transaktionen zu TX_CHUNKS Chunks
 * (gemessen: 4 statt 1 → ~15 % schneller, mehr bringt nichts; größere Chunks allein
 * auch nicht).
 *
 * Zwischen den Transaktionen bekommt die UI Luft — per MessageChannel, nicht per
 * `setTimeout`: Timer drosselt der Browser bei ausgeblendeter Seite (Bildschirm aus, App im
 * Hintergrund) auf ≥ 1 s je Chunk, und ein Import hat Hunderte davon.
 */

const CHUNK = 1500;
const TX_CHUNKS = 4;
const READ_AHEAD = 12;

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/** Weckruf zwischen Lesen und Schreiben: `wait()` bis zum nächsten `fire()`. */
function wakeup() {
  let resolve: () => void = () => {};
  let p = new Promise<void>((r) => (resolve = r));
  return {
    wait: () => p,
    fire: () => {
      resolve();
      p = new Promise<void>((r) => (resolve = r));
    },
  };
}

export interface StreamImportOptions<R, T, K extends IndexableType> {
  /** `*.ndjson.gz` (GitHub) beim Lesen entpacken */
  gzip?: boolean;
  signal?: AbortSignal;
  /** Rohzeile → Tabellenzeile (Standard: unverändert) */
  map?: (raw: R) => T;
  key: (row: T) => K;
  diff: 'keys' | 'rows';
  /** nach jeder Schreib-Transaktion: gelesene Zeilen bisher */
  onChunk?: (done: number) => void | Promise<void>;
}

export interface StreamImportResult {
  /** gelesene Zeilen */
  rows: number;
  /** davon neu oder geändert geschrieben */
  written: number;
}

const keyString = (k: IndexableType): string => (Array.isArray(k) ? k.join('\u0001') : String(k));

export async function streamImport<R, T, K extends IndexableType>(
  url: string,
  table: Table<T, K>,
  opts: StreamImportOptions<R, T, K>,
): Promise<StreamImportResult> {
  const res = await fetch(url, opts.signal ? { signal: opts.signal } : undefined);
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen: ${url} (${res.status})`);

  // Erstimport: einfach schreiben. Sonst je nach Art vergleichen.
  const update = (await table.count()) > 0;
  const have = update && opts.diff === 'keys'
    ? new Set((await table.toCollection().primaryKeys()).map((k) => keyString(k as IndexableType)))
    : null;

  const reader = (opts.gzip ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body).getReader();
  const decoder = new TextDecoder();
  const buf = new NdjsonBuffer<R>();
  const map = opts.map ?? ((r: R) => r as unknown as T);

  // --- Lesen (läuft voraus) ---
  const queue: T[][] = [];
  const dataReady = wakeup();
  const roomReady = wakeup();
  let ended = false;
  let readError: unknown = null;
  const pump = (async () => {
    try {
      let pending: T[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const raw of buf.push(decoder.decode(value, { stream: true }))) {
          pending.push(map(raw));
          if (pending.length >= CHUNK) {
            queue.push(pending);
            pending = [];
            dataReady.fire();
          }
        }
        while (queue.length >= READ_AHEAD) await roomReady.wait();
      }
      for (const raw of buf.flush()) pending.push(map(raw));
      if (pending.length > 0) queue.push(pending);
    } catch (e) {
      readError = e;
    } finally {
      ended = true;
      dataReady.fire();
    }
  })();

  // --- Schreiben ---
  let rows = 0;
  let written = 0;
  const filter = async (chunk: T[]): Promise<T[]> => {
    if (have) return chunk.filter((r) => !have.has(keyString(opts.key(r))));
    if (!update) return chunk;
    const old = await table.bulkGet(chunk.map(opts.key));
    return chunk.filter((r, i) => !old[i] || JSON.stringify(old[i]) !== JSON.stringify(r));
  };
  try {
    for (;;) {
      while (!ended && queue.length < TX_CHUNKS) await dataReady.wait();
      if (readError) throw readError;
      if (queue.length === 0) break;
      const group = queue.splice(0, TX_CHUNKS);
      roomReady.fire();
      await table.db.transaction('rw', table, async () => {
        for (const chunk of group) {
          const put = await filter(chunk);
          if (put.length > 0) await table.bulkPut(put);
          written += put.length;
        }
      });
      for (const chunk of group) rows += chunk.length;
      await opts.onChunk?.(rows);
      await yieldToUi();
    }
  } catch (e) {
    void reader.cancel().catch(() => {});
    throw e;
  } finally {
    roomReady.fire();
  }
  await pump;
  return { rows, written };
}
