import { db } from '../db/db';
import { previewImageIds } from '../data/cards';
import { cardImageUrl } from '../data/cardImages';
import { prefetchOrder, prefetchOracleIds } from '../domain/imagePrefetch';

/**
 * Bilder im Hintergrund vorladen (PLAN.md M20, Big Screen): nach dem Anmelden die
 * Standard-Bilder von Decks und Sammlung, eins nach dem anderen und mit niedriger
 * Priorität. Lädt der Nutzer gerade selbst Bilder, wartet das Vorladen. Bereits geladene
 * kommen aus dem Browser-Cache und kosten nichts.
 */

export interface PrefetchState {
  running: boolean;
  done: number;
  total: number;
}

let st: PrefetchState = { running: false, done: 0, total: 0 };
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
let lastUserImage = 0;
let observer: PerformanceObserver | null = null;

function set(patch: Partial<PrefetchState>) {
  st = { ...st, ...patch };
  for (const l of listeners) l();
}

export const imagePrefetch = {
  get state(): PrefetchState {
    return st;
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

const PARALLEL = 2;
/** So lange Ruhe nach einem Bild, das die Oberfläche selbst geladen hat. */
const QUIET_MS = 1200;
/** So viele Fehlschläge in Folge (Handy offline?) → aufhören. */
const MAX_FAILS = 6;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

function watchUserImages() {
  if (observer || typeof PerformanceObserver === 'undefined') return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        if (e.initiatorType === 'img') lastUserImage = Date.now();
      }
    });
    observer.observe({ type: 'resource', buffered: false });
  } catch {
    observer = null;
  }
}

export function startImagePrefetch(): void {
  stopImagePrefetch();
  const ctl = new AbortController();
  controller = ctl;
  watchUserImages();
  void run(ctl.signal).catch(() => {}).finally(() => {
    if (controller === ctl) set({ running: false });
  });
}

export function stopImagePrefetch(): void {
  controller?.abort();
  controller = null;
  set({ running: false });
}

async function run(signal: AbortSignal): Promise<void> {
  // Erst die Oberfläche fertig laden lassen.
  await sleep(3000, signal);
  if (signal.aborted) return;
  const [decks, owned] = await Promise.all([db.decks.toArray(), db.owned.toArray()]);
  const preview = await previewImageIds(prefetchOracleIds(decks, owned));
  const ids = prefetchOrder(decks, owned, preview);
  set({ running: true, done: 0, total: ids.length });
  let next = 0;
  let fails = 0;
  let done = 0;
  const worker = async () => {
    while (!signal.aborted && next < ids.length && fails < MAX_FAILS) {
      while (!signal.aborted && Date.now() - lastUserImage < QUIET_MS) await sleep(400, signal);
      const id = ids[next++];
      try {
        const res = await fetch(cardImageUrl(id, 'normal'), { signal, credentials: 'same-origin', priority: 'low' } as RequestInit);
        if (res.ok || res.status === 404) {
          await res.arrayBuffer(); // erst ganz gelesen landet es im Browser-Cache
          fails = 0;
        } else fails++;
      } catch {
        if (signal.aborted) return;
        fails++;
      }
      done++;
      if (done % 10 === 0 || done === ids.length) set({ done });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  set({ done });
}
