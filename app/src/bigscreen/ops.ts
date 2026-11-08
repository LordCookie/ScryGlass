import {
  db, addOwned, addOwnedBatch, removeOwnedBatch, setOwnedPrinting, createDeck, changeDeck, deleteDeck,
} from '../db/db';
import { addTokens, setTokenCount } from '../data/tokens';
import { addPreconToCollection, removePreconFromCollection } from '../data/precons';
import { applyCsvImport } from '../data/collectionImport';
import { isDeckOp } from '../domain/deckOps';
import { chooseTheme, isThemeKey } from '../ui/themes';
import { LEGALITY_FORMATS, type DeckCard, type Finish, type FormatId, type OwnedBooking, type OwnedSource } from '../domain/types';

/**
 * Schreibaufträge aus dem Browser (PLAN.md M18), am Handy ausgeführt mit denselben
 * Funktionen wie in der App. Alles von außen wird geprüft — ein kaputter Auftrag wird
 * abgelehnt statt die Sammlung zu beschädigen.
 */

export class OpError extends Error {}

const FINISHES: Finish[] = ['nonfoil', 'foil', 'etched'];
const SOURCES: OwnedSource[] = ['scan', 'manual', 'peer', 'precon'];

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new OpError(`${what} fehlt`);
  return v;
}
function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new OpError(`${what} ist keine Zahl`);
  return v;
}
function finish(v: unknown): Finish {
  if (v === undefined) return 'nonfoil';
  if (!FINISHES.includes(v as Finish)) throw new OpError('unbekannte Ausführung');
  return v as Finish;
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
function source(v: unknown): OwnedSource | undefined {
  return SOURCES.includes(v as OwnedSource) ? (v as OwnedSource) : undefined;
}
function bookings(v: unknown): OwnedBooking[] {
  if (!Array.isArray(v)) throw new OpError('Liste fehlt');
  return v.map((x) => {
    const o = obj(x);
    return { oracleId: str(o.oracleId, 'Karte'), finish: finish(o.finish), printingId: optStr(o.printingId), qty: Math.max(1, Math.floor(num(o.qty ?? 1, 'Anzahl'))) };
  });
}
function deckCards(v: unknown): DeckCard[] {
  if (!Array.isArray(v)) throw new OpError('Kartenliste fehlt');
  return v.map((x) => ({ oracleId: str(obj(x).oracleId, 'Karte'), qty: Math.max(1, Math.floor(num(obj(x).qty, 'Anzahl'))) }));
}

export const WRITE_OPS: Record<string, (args: unknown[]) => Promise<unknown>> = {
  addOwned: ([oracleId, f, delta, opts]) => {
    const o = obj(opts);
    return addOwned(str(oracleId, 'Karte'), finish(f), Math.trunc(num(delta, 'Anzahl')), {
      printingId: optStr(o.printingId),
      source: source(o.source),
    });
  },
  addOwnedBatch: ([items, opts]) => {
    const list = (Array.isArray(items) ? items : []).map((x) => {
      const o = obj(x);
      return { ...bookings([o])[0], source: source(o.source) };
    });
    return addOwnedBatch(list, { keepExisting: obj(opts).keepExisting === true });
  },
  removeOwnedBatch: ([items]) => removeOwnedBatch(bookings(items)),
  setOwnedPrinting: ([oracleId, printingId]) => setOwnedPrinting(str(oracleId, 'Karte'), str(printingId, 'Ausgabe')),
  createDeck: ([deck]) => {
    const d = obj(deck);
    const format = LEGALITY_FORMATS.includes(d.format as FormatId) ? (d.format as FormatId) : 'commander';
    return createDeck({
      name: typeof d.name === 'string' && d.name.trim() ? d.name : 'Neues Deck',
      format,
      ...(typeof d.commanderId === 'string' ? { commanderId: d.commanderId } : {}),
      cards: d.cards ? deckCards(d.cards) : [],
      sideboard: d.sideboard ? deckCards(d.sideboard) : [],
      updatedAt: Date.now(),
    });
  },
  changeDeck: ([id, op]) => {
    if (!isDeckOp(op)) throw new OpError('unbekannter Deck-Schritt');
    if (op.kind === 'format' && !LEGALITY_FORMATS.includes(op.format)) throw new OpError('unbekanntes Format');
    return changeDeck(num(id, 'Deck'), op);
  },
  deleteDeck: ([id]) => deleteDeck(num(id, 'Deck')),
  addTokens: ([delta]) => addTokens(Math.trunc(num(delta, 'Anzahl'))),
  setTokenCount: ([n]) => setTokenCount(num(n, 'Anzahl')),
  addPrecon: async ([key, opts]) => {
    const p = await db.precons.get(str(key, 'Fertigdeck'));
    if (!p) throw new OpError('Dieses Fertigdeck kennt das Handy nicht — Katalog aktualisieren.');
    const o = obj(opts);
    return addPreconToCollection(p, {
      copies: Math.min(4, Math.max(1, Math.floor(num(o.copies ?? 1, 'Anzahl')))),
      withTokens: o.withTokens === true,
      createDeck: o.createDeck === true,
    });
  },
  removePrecon: async ([id, opts]) => {
    const op = await db.ownedPrecons.get(num(id, 'Fertigdeck'));
    if (!op) throw new OpError('Dieses Fertigdeck ist schon aus der Sammlung.');
    return removePreconFromCollection(op, { deleteDeck: obj(opts).deleteDeck === true });
  },
  /** Farbschema im Browser gewählt → gilt fürs Handy und damit für alle Browser. */
  setTheme: async ([key]) => {
    if (!isThemeKey(key)) throw new OpError('unbekanntes Farbschema');
    chooseTheme(key);
    return null;
  },
  csvImport: ([items, mode]) => {
    if (mode !== 'add' && mode !== 'replace') throw new OpError('unbekannte Art');
    return applyCsvImport(bookings(items).map((b) => ({ ...b, kind: 'collection' as const })), mode);
  },
};
