import type { DBCore, DBCoreMutateRequest, DBCoreMutateResponse, Middleware } from 'dexie';

/**
 * Änderungs-Meldungen für den Big Screen (PLAN.md M18): Eine DBCore-Middleware fängt jede
 * Änderung an den Nutzertabellen ab — egal ob aus Scanner, Deck-Editor, Import oder Backup —
 * und meldet nach dem Commit, welche Schlüssel betroffen sind. Ohne Zuhörer kostet sie nichts.
 */

/** Tabellen, deren Änderungen gemeldet werden. `meta` nur für Token-Zähler und Farbschema. */
const WATCHED = new Set(['owned', 'decks', 'ownedPrecons', 'meta', 'scans']);
const META_KEYS = new Set(['tokenCount', 'theme']);

export interface TableChange {
  table: string;
  /** betroffene Primärschlüssel; `null` = ganze Tabelle (clear/Bereich) */
  keys: (string | number)[] | null;
}

type Listener = (changes: TableChange[]) => void;
const listeners = new Set<Listener>();

export function onDbChanges(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// Je Transaktion gesammelt, gemeldet nach „complete" (bei Abbruch: nichts).
const pending = new WeakMap<object, Map<string, Set<string | number> | null>>();

function keysOf(table: string, req: DBCoreMutateRequest, res: DBCoreMutateResponse): (string | number)[] | null {
  if (req.type === 'deleteRange') return null;
  if (req.type === 'delete') return req.keys as (string | number)[];
  const results = (res as { results?: unknown[] }).results;
  if (results && results.length === req.values.length && results.every((k) => k != null)) return results as (string | number)[];
  if (req.keys && req.keys.every((k) => k != null)) return req.keys as (string | number)[];
  // Werte mit eingebettetem Schlüssel (meta: key, owned/decks: id nach put)
  const pk = table === 'meta' ? 'key' : 'id';
  const fromValues = (req.values as Record<string, unknown>[]).map((v) => v?.[pk]);
  if (fromValues.every((k) => typeof k === 'string' || typeof k === 'number')) return fromValues as (string | number)[];
  return null;
}

function record(trans: object, table: string, keys: (string | number)[] | null) {
  let byTable = pending.get(trans);
  if (!byTable) {
    byTable = new Map();
    pending.set(trans, byTable);
    const flush = () => {
      const changes = pending.get(trans);
      pending.delete(trans);
      if (!changes) return;
      const out: TableChange[] = [...changes].map(([t, k]) => ({ table: t, keys: k ? [...k] : null }));
      for (const l of listeners) {
        try {
          l(out);
        } catch {
          /* ein Zuhörer darf die Datenbank nicht stören */
        }
      }
    };
    const t = trans as { addEventListener?: (ev: string, cb: () => void) => void };
    if (typeof t.addEventListener === 'function') {
      t.addEventListener('complete', flush);
      t.addEventListener('abort', () => pending.delete(trans));
      t.addEventListener('error', () => pending.delete(trans));
    } else {
      setTimeout(flush, 0);
    }
  }
  if (keys === null || byTable.get(table) === null) {
    byTable.set(table, null);
    return;
  }
  const set = byTable.get(table) ?? new Set<string | number>();
  for (const k of keys) set.add(k);
  byTable.set(table, set);
}

export const changeFeedMiddleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'bigscreenChangeFeed',
  create(down) {
    return {
      ...down,
      table(name) {
        const table = down.table(name);
        if (!WATCHED.has(name)) return table;
        return {
          ...table,
          async mutate(req) {
            const res = await table.mutate(req);
            if (listeners.size === 0) return res;
            let keys = keysOf(name, req, res);
            if (name === 'meta') {
              if (keys === null) return res;
              keys = keys.filter((k) => META_KEYS.has(String(k)));
              if (keys.length === 0) return res;
            }
            record(req.trans as object, name, keys);
            return res;
          },
        };
      },
    };
  },
};
