/**
 * JSON-Backup/Restore der Sammlung + Decks (PLAN.md § 5, „Backup/Export").
 * Datenverlust in IndexedDB (Browser-Reset, Reinstall) ist real — deshalb ein
 * verlustfreies, byte-stabiles Backup (Einträge deterministisch sortiert).
 */
import type { Owned, Deck, Finish, OwnedSource } from './types';

export const COLLECTION_SCHEMA = 'scryglass-collection';
export const SCHEMA_VERSION = 1;

export interface CollectionExport {
  schema: typeof COLLECTION_SCHEMA;
  version: number;
  exportedAt: number;
  owned: Owned[];
  decks: Deck[];
  /** gezählte Spielsteine (Tokens) — fehlt in älteren Backups */
  tokens?: number;
}

export class CollectionImportError extends Error {}

function sortOwned(owned: readonly Owned[]): Owned[] {
  return [...owned]
    .map(({ id: _id, ...rest }) => rest as Owned)
    .sort((a, b) =>
      a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : a.finish < b.finish ? -1 : a.finish > b.finish ? 1 : 0,
    );
}

function sortDecks(decks: readonly Deck[]): Deck[] {
  return [...decks]
    .map(({ id: _id, ...rest }) => rest as Deck)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.updatedAt - b.updatedAt));
}

export function buildExport(
  owned: readonly Owned[],
  decks: readonly Deck[] = [],
  exportedAt: number = Date.now(),
  tokens?: number,
): CollectionExport {
  return {
    schema: COLLECTION_SCHEMA,
    version: SCHEMA_VERSION,
    exportedAt,
    owned: sortOwned(owned),
    decks: sortDecks(decks),
    ...(tokens != null ? { tokens } : {}),
  };
}

export function serializeCollection(
  owned: readonly Owned[],
  decks: readonly Deck[] = [],
  exportedAt?: number,
  tokens?: number,
): string {
  return JSON.stringify(buildExport(owned, decks, exportedAt, tokens), null, 2);
}

const FINISHES: Finish[] = ['nonfoil', 'foil', 'etched'];
const SOURCES: OwnedSource[] = ['scan', 'manual', 'peer'];

function isValidOwned(v: unknown): v is Owned {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.oracleId === 'string' &&
    FINISHES.includes(e.finish as Finish) &&
    typeof e.qty === 'number' &&
    Number.isFinite(e.qty) &&
    e.qty > 0 &&
    typeof e.addedAt === 'number' &&
    SOURCES.includes(e.source as OwnedSource)
  );
}

function isValidDeck(v: unknown): v is Deck {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.name === 'string' &&
    typeof d.format === 'string' &&
    Array.isArray(d.cards) &&
    Array.isArray(d.sideboard) &&
    typeof d.updatedAt === 'number'
  );
}

/** Parst & validiert ein Backup. Wirft bei fremdem/kaputtem JSON, statt still
 *  eine Sammlung zu zerschießen. Unbekannte/kaputte Deck-Einträge werden
 *  übersprungen, ohne den Owned-Restore zu blockieren. */
export function parseCollection(json: string): CollectionExport {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new CollectionImportError('Kein gültiges JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new CollectionImportError('Erwartet wird ein Objekt.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== COLLECTION_SCHEMA) {
    throw new CollectionImportError('Unbekanntes Schema — kein ScryGlass-Backup.');
  }
  if (!Array.isArray(obj.owned) || !obj.owned.every(isValidOwned)) {
    throw new CollectionImportError('Feld „owned" fehlt oder ist beschädigt.');
  }
  const decks = Array.isArray(obj.decks) ? obj.decks.filter(isValidDeck) : [];
  return {
    schema: COLLECTION_SCHEMA,
    version: typeof obj.version === 'number' ? obj.version : SCHEMA_VERSION,
    exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : 0,
    owned: sortOwned(obj.owned as Owned[]),
    decks: sortDecks(decks),
    ...(typeof obj.tokens === 'number' && obj.tokens >= 0 ? { tokens: Math.floor(obj.tokens) } : {}),
  };
}
