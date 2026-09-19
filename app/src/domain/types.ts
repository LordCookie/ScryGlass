/**
 * Kern-Datentypen (PLAN.md § 3). Framework-frei, spiegeln 1:1 den Pipeline-Output
 * (siehe pipeline/fetch_scryfall.py). Was hier steht, muss zum NDJSON passen.
 */

export type Finish = 'nonfoil' | 'foil' | 'etched';
export type Lang = 'en' | 'de';
export type OwnedSource = 'scan' | 'manual' | 'peer';

/** Oracle-Karte (eine je oracleId). Oracle-Level-Felder, sprachneutral (EN kanonisch). */
export interface Card {
  oracleId: string;
  name: string; // englischer Oracle-Name (kanonisch)
  normName: string;
  manaCost: string; // "{1}{U}{U}"
  cmc: number;
  colors: string[]; // ["U"]
  colorIdentity: string[]; // ["U"] — für Commander
  typeLine: string;
  oracleText: string;
  layout: string; // normal | transform | modal_dfc | split | adventure | ...
  legalities: number; // Bitmaske, siehe LEGALITY_FORMATS
  maxCopies: number; // 4 | 99
}

/** Konkrete Druckausgabe (eine je Scryfall-Karte). */
export interface Printing {
  scryfallId: string;
  oracleId: string;
  set: string; // "dmu"
  collectorNumber: string; // "123a" — String! nicht Number
  lang: Lang;
  finishes: string[]; // ["nonfoil","foil","etched"]
}

export interface NameEntry {
  normName: string;
  oracleId: string;
  lang: Lang;
}

/** Trigramm-Postings (Fuzzy-Fallback-Index). */
export interface TrigramEntry {
  trigram: string;
  oracleIds: string[];
}

/** Perceptual-Hash einer Druckausgabe fürs Bild-Matching (Scanner v2). */
export interface HashEntry {
  scryfallId: string;
  oracleId: string;
  /** 256-Bit-pHash als 64 Hex-Zeichen (siehe pipeline/hash_images.py). */
  h: string;
}

/**
 * Protokoll eines Scans zum Sammeln echter Fixtures (PLAN.md § 5): OCR-Rohtext +
 * Bild-Hash-Ergebnis, plus die vom Nutzer bestätigte Karte als „Wahrheit". Export
 * dient dem Tuning von OCR- und Hash-Schwellen. Enthält keine Bilder/Nutzerdaten.
 */
export interface ScanLog {
  id?: number;
  at: number;
  ocrRaw: string;
  ocrBestOracle?: string;
  ocrScore?: number;
  ocrMethod?: string;
  hashOracle?: string;
  hashDist?: number;
  hashMargin?: number;
  /** Ground Truth: was der Nutzer tatsächlich übernommen hat. */
  chosenOracle: string;
  chosenName: string;
  /** kam der Treffer per Bild, OCR oder manuell zustande? */
  via: 'bild' | 'ocr' | 'manuell';
}

/** Ein Bestand in der eigenen Sammlung. */
export interface Owned {
  id?: number;
  oracleId: string;
  printingId?: string; // optional — v1 zählt auf oracleId (PLAN.md § 3)
  finish: Finish;
  qty: number;
  addedAt: number;
  source: OwnedSource;
  peerDevice?: string;
}

// --- Legalitäts-Bitmaske (muss zu pipeline FORMATS passen, PLAN.md § 3) --------

/** Reihenfolge = Bit-Position. Identisch zur Pipeline. */
export const LEGALITY_FORMATS = [
  'standard',
  'pioneer',
  'modern',
  'legacy',
  'vintage',
  'commander',
  'pauper',
  'brawl',
] as const;

export type FormatId = (typeof LEGALITY_FORMATS)[number];

export const FORMAT_LABELS: Record<FormatId, string> = {
  standard: 'Standard',
  pioneer: 'Pioneer',
  modern: 'Modern',
  legacy: 'Legacy',
  vintage: 'Vintage',
  commander: 'Commander',
  pauper: 'Pauper',
  brawl: 'Brawl',
};

/** Ist die Karte im Format legal? (Bitmaske-AND) */
export function isLegal(legalities: number, format: FormatId): boolean {
  const bit = LEGALITY_FORMATS.indexOf(format);
  return bit >= 0 && (legalities & (1 << bit)) !== 0;
}

// --- Deck (PLAN.md § 7) -----------------------------------------------------

export interface DeckCard {
  oracleId: string;
  qty: number;
}

export interface Deck {
  id?: number;
  name: string;
  format: FormatId;
  /** oracleId des Commanders (nur Commander-Format). */
  commanderId?: string;
  cards: DeckCard[]; // Mainboard
  sideboard: DeckCard[];
  updatedAt: number;
}

// --- Peer-Scanning (PLAN.md § 8) --------------------------------------------

/** Ein Korb-Eintrag — trägt OCR-Rohtext + Confidence bis in die Prüfansicht. */
export interface BasketEntry {
  entryId: string; // UUID, für Dedup
  oracleId: string;
  printingId?: string;
  lang: Lang;
  finish: Finish;
  qty: number;
  ocrRaw: string; // was die OCR wirklich gelesen hat
  confidence: number; // 0..1
  scannedAt: number;
}

/** Ein empfangener Korb im Eingang (Dexie-Table `inbox`). */
export interface InboxBasket {
  basketId: string;
  deviceId: string;
  deviceName: string;
  createdAt: number;
  receivedAt: number;
  status: 'received' | 'reviewed' | 'accepted';
  entries: BasketEntry[];
}
