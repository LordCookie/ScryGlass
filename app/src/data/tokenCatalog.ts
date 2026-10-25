import { db, getMeta } from '../db/db';
import type { Card } from '../domain/types';
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
}

/** Set-Codes, die nur Tokens enthalten (Token-Sets wie „tblb") — für die Set-Auswahl. */
export async function tokenOnlySets(): Promise<Set<string>> {
  const { oracleIds } = await loadTokenCatalog();
  const out = new Set<string>();
  if (oracleIds.size === 0) return out;
  const withTokens = new Set<string>();
  await db.printings.where('oracleId').anyOf([...oracleIds]).each((p) => {
    withTokens.add(p.set);
  });
  for (const s of withTokens) {
    let onlyTokens = true;
    await db.printings.where('set').equals(s).until(() => !onlyTokens).each((p) => {
      if (!oracleIds.has(p.oracleId)) onlyTokens = false;
    });
    if (onlyTokens) out.add(s);
  }
  return out;
}
