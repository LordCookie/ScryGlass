import { db, setMeta } from '../db/db';
import { TOKEN_KEY } from '../data/tokens';
import type { ServerMsg, Snapshot } from './protocol';
import type { Deck, Owned, OwnedPrecon } from '../domain/types';

/**
 * Die Kopie im Browser (PLAN.md M18): Schnappschuss einspielen, dann Änderungen nach ihrer
 * Nummer. Geschrieben wird direkt in die Tabellen (nicht über die Schreibfunktionen, die im
 * Fernbetrieb ans Handy gehen). Alle Ansichten lesen weiter mit `useLiveQuery`.
 */

export async function applySnapshot(s: Snapshot): Promise<void> {
  await db.transaction('rw', db.owned, db.decks, db.ownedPrecons, db.meta, async () => {
    await Promise.all([db.owned.clear(), db.decks.clear(), db.ownedPrecons.clear()]);
    await db.owned.bulkPut(s.owned);
    await db.decks.bulkPut(s.decks);
    await db.ownedPrecons.bulkPut(s.ownedPrecons);
    await setMeta(TOKEN_KEY, s.tokenCount);
  });
}

/** Eine Änderung einspielen. Doppelt einspielen schadet nicht (über die ID). */
export async function applyChange(msg: Extract<ServerMsg, { t: 'change' } | { t: 'tokens' }>): Promise<void> {
  if (msg.t === 'tokens') {
    await setMeta(TOKEN_KEY, msg.count);
    return;
  }
  const table = db.table<Owned | Deck | OwnedPrecon, number>(msg.table);
  await db.transaction('rw', table, async () => {
    if (msg.deletes.length) await table.bulkDelete(msg.deletes as number[]);
    if (msg.puts.length) await table.bulkPut(msg.puts as (Owned | Deck | OwnedPrecon)[]);
  });
}

/** Beim Trennen: Sammlung und Decks aus diesem Browser löschen (der Katalog darf bleiben). */
export async function clearReplica(): Promise<void> {
  await db.transaction('rw', db.owned, db.decks, db.ownedPrecons, db.meta, async () => {
    await Promise.all([db.owned.clear(), db.decks.clear(), db.ownedPrecons.clear(), db.meta.delete(TOKEN_KEY)]);
  });
}

/**
 * Reihenfolge der Änderungen: Jede trägt eine fortlaufende Nummer. Fehlt eine (Funkloch,
 * Tab schlief), muss der Browser den Schnappschuss neu holen. Vor dem ersten Schnappschuss
 * werden Änderungen gepuffert und danach nur die neueren eingespielt.
 */
export class SeqTracker {
  private last: number | null = null;
  private buffer: Extract<ServerMsg, { seq: number }>[] = [];

  get seq(): number | null {
    return this.last;
  }

  /** Was mit einer Nachricht zu tun ist. */
  accept(msg: Extract<ServerMsg, { seq: number }>): 'apply' | 'skip' | 'buffer' | 'resync' {
    if (this.last === null) {
      this.buffer.push(msg);
      return 'buffer';
    }
    if (msg.seq <= this.last) return 'skip';
    if (msg.seq === this.last + 1 && msg.t !== 'reset') {
      this.last = msg.seq;
      return 'apply';
    }
    return 'resync';
  }

  /** Schnappschuss eingespielt: gepufferte, neuere Nachrichten in Reihenfolge zurückgeben. */
  synced(seq: number): Extract<ServerMsg, { seq: number }>[] | 'resync' {
    this.last = seq;
    const later = this.buffer.filter((m) => m.seq > seq).sort((a, b) => a.seq - b.seq);
    this.buffer = [];
    for (const m of later) {
      if (m.seq !== this.last + 1 || m.t === 'reset') return 'resync';
      this.last = m.seq;
    }
    return later;
  }

  /** Neu holen nötig — bis zum nächsten Schnappschuss puffern. */
  invalidate(): void {
    this.last = null;
  }
}
