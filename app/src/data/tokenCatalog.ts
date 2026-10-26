import { db, getMeta } from '../db/db';
import type { Card, Printing } from '../domain/types';
import { TOKEN_LAYOUTS, buildTokenNameIndex } from '../domain/tokens';

/**
 * Token-Teil des Katalogs (Großes Token-Update, PLAN.md M14): alle Spielsteine und
 * Embleme mit ihrem Namensindex. Einmal je Katalog-Version aus Dexie (Layout-Index,
 * db v5) in den Speicher — Bild-Index, Suche und Scanner fragen hier nach.
 * Ein älterer Katalog ohne Tokens liefert einfach eine leere Menge.
 */

export interface TokenCatalog {
  oracleIds: ReadonlySet<string>;
  cards: ReadonlyMap<string, Card>;
  /** normName (auch je Seite) → Token-Oracles */
  byName: ReadonlyMap<string, readonly string[]>;
}

let cache: { version: string | undefined; cat: Promise<TokenCatalog> } | null = null;

export async function loadTokenCatalog(): Promise<TokenCatalog> {
  const version = await getMeta<string>('catalogVersion');
  if (!cache || cache.version !== version) {
    cache = {
      version,
      cat: (async () => {
        const rows = await db.cards.where('layout').anyOf([...TOKEN_LAYOUTS]).toArray();
        return {
          oracleIds: new Set(rows.map((c) => c.oracleId)),
          cards: new Map(rows.map((c) => [c.oracleId, c])),
          byName: buildTokenNameIndex(rows),
        };
      })(),
    };
  }
  return cache.cat;
}

export function invalidateTokenCatalog(): void {
  cache = null;
  onlySets = null;
}

/** Ausgaben zu vielen Schlüsseln: Einzelabfragen parallel in EINER Transaktion — im
 *  Browser gemessen 0,2 s statt 15 s für `anyOf` mit tausend Schlüsseln (Dexie springt
 *  dort per Cursor von Schlüssel zu Schlüssel). */
function printingsWhere(index: 'oracleId' | 'set', keys: readonly string[]): Promise<Printing[]> {
  return db.transaction('r', db.printings, async () =>
    (await Promise.all(keys.map((k) => db.printings.where(index).equals(k).toArray()))).flat(),
  );
}

/** Set-Codes, die nur Tokens enthalten (Token-Sets wie „tblb") — für die Set-Auswahl.
 *  Gemerkt je Katalog-Version. */
let onlySets: { version: string | undefined; sets: Promise<Set<string>> } | null = null;

export async function tokenOnlySets(): Promise<Set<string>> {
  const version = await getMeta<string>('catalogVersion');
  if (!onlySets || onlySets.version !== version) {
    onlySets = {
      version,
      sets: (async () => {
        const { oracleIds } = await loadTokenCatalog();
        if (oracleIds.size === 0) return new Set<string>();
        const tokenPrints = await printingsWhere('oracleId', [...oracleIds]);
        const sets = [...new Set(tokenPrints.map((p) => p.set))];
        // Gemischte Sets (Secret Lair: Karten UND Tokens) bleiben in der Auswahl.
        const mixed = new Set<string>();
        for (const p of await printingsWhere('set', sets)) {
          if (!oracleIds.has(p.oracleId)) mixed.add(p.set);
        }
        return new Set(sets.filter((s) => !mixed.has(s)));
      })(),
    };
  }
  return onlySets.sets;
}
