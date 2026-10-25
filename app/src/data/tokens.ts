import { db, getMeta, setMeta } from '../db/db';
import { loadTokenCatalog } from './tokenCatalog';

/**
 * Spielsteine (Tokens) OHNE Artwork — als Gesamtzahl gezählt (meta `tokenCount`). Seit
 * dem Großen Token-Update (PLAN.md M14) stehen Tokens im Katalog und werden je Artwork
 * als Bestand gesammelt; dieser Zähler bleibt für Tokens, die der Katalog nicht kennt
 * (und übernimmt die Zählung von vorher). In der Statistik lässt er sich korrigieren,
 * das JSON-Backup nimmt ihn mit.
 */
export const TOKEN_KEY = 'tokenCount';

export async function getTokenCount(): Promise<number> {
  const v = await getMeta<number>(TOKEN_KEY);
  return typeof v === 'number' && v > 0 ? Math.floor(v) : 0;
}

/** Zähler ändern (nie unter 0); gibt den neuen Stand zurück. */
export function addTokens(delta: number): Promise<number> {
  return db.transaction('rw', db.meta, async () => {
    const n = Math.max(0, (await getTokenCount()) + delta);
    await setMeta(TOKEN_KEY, n);
    return n;
  });
}

export async function setTokenCount(n: number): Promise<void> {
  await setMeta(TOKEN_KEY, Math.max(0, Math.floor(n)));
}

export interface TokenSummary {
  /** Tokens mit Artwork (Bestand) */
  withArt: number;
  /** verschiedene Artworks darunter */
  artworks: number;
  /** ohne Artwork gezählt (meta `tokenCount`) */
  withoutArt: number;
}

/** Überblick über alle Tokens der Sammlung (Kopfzeile, Statistik). */
export async function getTokenSummary(): Promise<TokenSummary> {
  const [owned, cat, withoutArt] = await Promise.all([db.owned.toArray(), loadTokenCatalog(), getTokenCount()]);
  const rows = owned.filter((o) => cat.oracleIds.has(o.oracleId));
  return {
    withArt: rows.reduce((s, o) => s + o.qty, 0),
    artworks: new Set(rows.map((o) => o.printingId ?? o.oracleId)).size,
    withoutArt,
  };
}
