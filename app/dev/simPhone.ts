/**
 * Simuliertes Handy für den Big Screen (nur Entwicklung, `npm run dev:bigscreen`).
 * Läuft im Vite-Prozess (Node) mit einer eigenen IndexedDB im Speicher und demselben
 * Host-Code wie am Handy (src/bigscreen/host.ts). Passwort: siehe SIM_PASSWORD.
 *
 * Alle 20 s „scannt" das Handy eine Karte (für die Anzeige unten rechts).
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { db, addOwnedBatch, createDeck, logScan } from '../src/db/db';
import { makeAuth, parseCookies, SESSION_COOKIE } from '../src/domain/bigscreen';
import { BigScreenHost } from '../src/bigscreen/host';
import type { HostRequest, HostResponse, ServerMsg } from '../src/bigscreen/protocol';
import type { Card } from '../src/domain/types';

/** Test-Passwort nur für den Simulator auf localhost — kein echtes Geheimnis. */
export const SIM_PASSWORD = 'bigscreen';

type Transport = { send: (msg: string, sessions?: string[]) => void; close: (sessions: string[], last?: string) => void };
let transport: Transport = { send: () => {}, close: () => {} };
/** Gültige Sitzungs-Cookies — wie am Handy für `/img` (M20). */
let tokens = new Set<string>();

export function setTransport(t: Transport): void {
  transport = t;
}

const host = new BigScreenHost({
  send: (msg: ServerMsg, sessions?: string[]) => transport.send(JSON.stringify(msg), sessions),
  close: (sessions: string[], last?: ServerMsg) => transport.close(sessions, last ? JSON.stringify(last) : undefined),
  now: () => Date.now(),
  deviceName: 'Simuliertes Handy',
  battery: async () => ({ level: 0.62, charging: false }),
  onSessions: (sessions) => { tokens = new Set(sessions.map((s) => s.token)); },
}, { auth: makeAuth(SIM_PASSWORD), idleMs: 15 * 60_000 });

export function hasSession(cookie: string | undefined): boolean {
  const t = parseCookies(cookie)[SESSION_COOKIE];
  return !!t && tokens.has(t);
}

let seeded: Promise<Card[]> | null = null;

/** Ein paar echte Karten aus dem eingebauten Katalog als Sammlung + ein Deck. */
function seed(catalogDir: string): Promise<Card[]> {
  seeded ??= (async () => {
    const lines = readFileSync(`${catalogDir}/cards.ndjson`, 'utf-8').split('\n', 4000).filter(Boolean);
    const cards = lines.map((l) => JSON.parse(l) as Card).filter((c) => c.layout !== 'token' && !/Basic/.test(c.typeLine));
    const pick = cards.filter((_, i) => i % 97 === 0).slice(0, 36);
    await db.cards.bulkPut(pick);
    await addOwnedBatch(pick.map((c, i) => ({ oracleId: c.oracleId, qty: 1 + (i % 3), finish: i % 7 === 0 ? 'foil' as const : 'nonfoil' as const, source: 'scan' as const })));
    await createDeck({ name: 'Sim-Deck', format: 'modern', cards: pick.slice(0, 8).map((c) => ({ oracleId: c.oracleId, qty: 2 })), sideboard: [], updatedAt: Date.now() });
    // Regelmäßig „scannen", damit unten rechts etwas zu sehen ist.
    let i = 0;
    setInterval(() => {
      const c = pick[(i++ * 5) % pick.length];
      void logScan({ at: Date.now(), ocrRaw: c.name, chosenOracle: c.oracleId, chosenName: c.name, via: 'bild' });
    }, 20_000);
    return pick;
  })();
  return seeded;
}

export async function handle(req: HostRequest, catalogDir: string): Promise<HostResponse> {
  await seed(catalogDir);
  return host.handle(req);
}

export async function hello(session: string): Promise<string> {
  return JSON.stringify(await host.hello(session));
}

setInterval(() => host.tick(), 15_000);
