/**
 * CSV-Export und -Import der Sammlung (PLAN.md § 5, M5). Export Moxfield-/ManaBox-kompatibel:
 * Spalten `Count,Name,Edition,Condition,Language,Foil,Collector Number`.
 * Moxfield importiert dieses Format direkt; ManaBox akzeptiert Count/Name/Foil.
 *
 * v1 zählt auf Oracle-Ebene — Edition/Collector Number bleiben leer, wenn (noch)
 * keine Druckausgabe sicher erkannt wurde. Der Aufrufer reicht bereits verbundene
 * Zeilen herein (Name + optional Set/Nummer), damit das Modul framework-frei bleibt.
 *
 * Import: siehe unten (`parseCollectionCsv`) — Umstieg von ManaBox, Moxfield & Co.
 */
import type { Finish, Lang } from './types';
import { CollectionImportError } from './collectionIo';

export interface CsvRow {
  name: string;
  qty: number;
  finish: Finish;
  lang: Lang;
  setCode?: string;
  collectorNumber?: string;
}

const HEADER = ['Count', 'Name', 'Edition', 'Condition', 'Language', 'Foil', 'Collector Number'];

function esc(field: string): string {
  if (/[",\n]/.test(field)) return '"' + field.replace(/"/g, '""') + '"';
  return field;
}

function foilField(finish: Finish): string {
  if (finish === 'foil') return 'foil';
  if (finish === 'etched') return 'etched';
  return ''; // nonfoil → leer (Moxfield-Konvention)
}

export function toMoxfieldCsv(rows: readonly CsvRow[]): string {
  const lines = [HEADER.join(',')];
  // Deterministisch sortieren (Name, dann Finish) → stabiler Export.
  const sorted = [...rows].sort(
    (a, b) => a.name.localeCompare(b.name) || a.finish.localeCompare(b.finish),
  );
  for (const r of sorted) {
    lines.push(
      [
        String(r.qty),
        esc(r.name),
        esc(r.setCode ?? ''),
        'NM',
        esc(r.lang),
        foilField(r.finish),
        esc(r.collectorNumber ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

// --- Import (Umstieg von ManaBox, Moxfield & Co.) ----------------------------

/** Eine Zeile einer fremden Sammlungs-CSV — noch nicht auf den Katalog aufgelöst. */
export interface CsvImportRow {
  name: string;
  qty: number;
  finish: Finish;
  scryfallId?: string;
  setCode?: string;
  collectorNumber?: string;
  /** Sprache als Code („en", „de", „ja" …), falls die Datei sie nennt. */
  lang?: string;
  /** ManaBox trennt Ordner, Decks und Listen (Wunschlisten) — nur Ordner sind sicher Besitz. */
  kind: 'collection' | 'deck' | 'list';
}

export interface CsvImport {
  rows: CsvImportRow[];
  /** Erkannte Herkunft, nur zur Anzeige. */
  source?: 'ManaBox' | 'Moxfield';
  /** Zeilen ohne Namen/Kennung oder mit unlesbarer Anzahl. */
  skipped: number;
}

/** Spaltennamen (klein, _/- als Leerzeichen) → Feld. Der erste Treffer je Feld gewinnt. */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['name', 'card name', 'card', 'cardname', 'kartenname'],
  qty: ['quantity', 'count', 'qty', 'amount', 'anzahl', 'menge'],
  scryfallId: ['scryfall id', 'scryfallid', 'scryfall uuid'],
  setCode: ['set code', 'setcode', 'edition code', 'edition', 'set'],
  collectorNumber: ['collector number', 'collectornumber', 'card number', 'number', 'cn'],
  foil: ['foil', 'finish', 'printing'],
  lang: ['language', 'lang', 'sprache'],
  binderType: ['binder type', 'list type'],
};

const LANG_NAMES: Record<string, string> = {
  english: 'en', englisch: 'en', german: 'de', deutsch: 'de', japanese: 'ja', french: 'fr',
  italian: 'it', spanish: 'es', portuguese: 'pt', russian: 'ru', korean: 'ko', chinese: 'zhs',
};

function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/** Trennzeichen aus der Kopfzeile raten (Excel speichert auf Deutsch gern mit Semikolon). */
function detectDelimiter(firstLine: string): string {
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const n = firstLine.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** RFC-4180-CSV: Anführungszeichen, verdoppelte "" und Zeilenumbrüche im Feld. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += ch;
  }
  endRow();
  return rows;
}

/** „foil", „etched", „normal", leer oder ja/nein — wie die Apps es eben schreiben. */
export function parseFinish(raw: string | undefined): Finish {
  const v = (raw ?? '').trim().toLowerCase();
  if (v.includes('etched')) return 'etched';
  if (/non.?foil/.test(v)) return 'nonfoil';
  if (v.includes('foil') || ['true', 'yes', 'ja', 'y', '1', 'x'].includes(v)) return 'foil';
  return 'nonfoil';
}

export function langCode(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return undefined;
  return LANG_NAMES[v] ?? (/^[a-z]{2,3}$/.test(v) ? v : undefined);
}

/**
 * Liest eine Sammlungs-CSV aus ManaBox, Moxfield, Deckbox oder dem eigenen Export.
 * Die Spalten werden über die Kopfzeile erkannt (Reihenfolge egal); auf Karten
 * aufgelöst wird erst danach — über Scryfall-ID, Set + Nummer oder Name
 * (data/collectionImport).
 */
export function parseCollectionCsv(text: string): CsvImport {
  let body = text.replace(/^﻿/, '');
  if (/^\s*[[{]/.test(body)) {
    throw new CollectionImportError('Das ist eine JSON-Datei — dafür „JSON importieren" nehmen.');
  }
  body = body.replace(/^sep=.\r?\n/i, ''); // Excel-Hinweiszeile
  const table = parseCsv(body, detectDelimiter(body.split(/\r?\n/, 1)[0] ?? ''));
  if (table.length === 0) throw new CollectionImportError('Die Datei ist leer.');

  const header = table[0].map(headerKey);
  const col: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const i = aliases.map((a) => header.indexOf(a)).find((x) => x >= 0);
    if (i != null) col[field] = i;
  }
  if (col.name == null && col.scryfallId == null && (col.setCode == null || col.collectorNumber == null)) {
    throw new CollectionImportError('Keine Spalte „Name" gefunden — ist das eine Sammlungs-CSV?');
  }
  const get = (cells: string[], field: string): string | undefined => {
    const v = col[field] == null ? undefined : cells[col[field]]?.trim();
    return v ? v : undefined;
  };

  const rows: CsvImportRow[] = [];
  let skipped = 0;
  for (const cells of table.slice(1)) {
    const name = get(cells, 'name') ?? '';
    const scryfallId = get(cells, 'scryfallId')?.toLowerCase();
    const setCode = get(cells, 'setCode')?.toLowerCase();
    const collectorNumber = get(cells, 'collectorNumber');
    const qtyRaw = get(cells, 'qty');
    const qty = qtyRaw == null ? 1 : Number.parseInt(qtyRaw, 10);
    if (!(qty > 0) || (!name && !scryfallId && !(setCode && collectorNumber))) {
      skipped++;
      continue;
    }
    const binder = get(cells, 'binderType')?.toLowerCase() ?? '';
    const lang = langCode(get(cells, 'lang'));
    rows.push({
      name,
      qty,
      finish: parseFinish(get(cells, 'foil')),
      ...(scryfallId ? { scryfallId } : {}),
      ...(setCode ? { setCode } : {}),
      ...(collectorNumber ? { collectorNumber } : {}),
      ...(lang ? { lang } : {}),
      kind: binder.includes('deck') ? 'deck' : /list|wish/.test(binder) ? 'list' : 'collection',
    });
  }
  const source = header.includes('manabox id') ? 'ManaBox' : header.includes('tradelist count') ? 'Moxfield' : undefined;
  return { rows, skipped, ...(source ? { source } : {}) };
}
