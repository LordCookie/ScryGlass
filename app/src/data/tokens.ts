import { db, getMeta, setMeta } from '../db/db';

/**
 * Spielsteine (Tokens) — vorerst nur als Gesamtzahl gezählt (meta `tokenCount`). Tokens
 * stehen nicht im Katalog; einzeln mit Artwork erfassen ist ein späteres, größeres
 * Update (PLAN.md M14). Der Scanner zählt erkannte Tokens, in der Statistik lässt
 * sich die Zahl korrigieren, das JSON-Backup nimmt sie mit.
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
