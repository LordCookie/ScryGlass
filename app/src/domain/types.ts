/**
 * Kern-Datentypen (PLAN.md § 3). Framework-frei, spiegeln 1:1 den Pipeline-Output
 * (siehe pipeline/fetch_scryfall.py). Was hier steht, muss zum NDJSON passen.
 */

export type Finish = 'nonfoil' | 'foil' | 'etched';
export type Lang = 'en' | 'de';
export type OwnedSource = 'scan' | 'manual' | 'peer' | 'precon';

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
  /** Auf der Game-Changer-Liste der Commander-Brackets (M17). Fehlt = nein bzw. alter Katalog. */
  gameChanger?: boolean;
  /** Rollen aus den Scryfall-Tags als Bitmaske (ROLE). Fehlt = keine bzw. alter Katalog. */
  roles?: number;
}

/** Rollen-Bits — müssen zu `ROLE_BITS` in pipeline/fetch_scryfall.py passen. */
export const ROLE = { ramp: 1, draw: 2, removal: 4, sweeper: 8, mld: 16, extraTurn: 32, tutor: 64 } as const;

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
  /** Schärfemaß des Frames (Laplace-Varianz) — zum Tunen des Schärfe-Gates. */
  sharpness?: number;
  /** Sicherheit der gewählten Titel-Lesung (0..100; Tesseract oder ML Kit). */
  ocrConf?: number;
  /** Gelesene Druckinfo „set nummer sprache" (native Kamera), z. B. „dmu 123 en". */
  printRead?: string;
  /** Bild-Abstand zur BESTÄTIGTEN Karte (knapp verfehlt vs. völlig daneben, § 6.2). */
  hashDistChosen?: number;
  /** Abbildung Rahmen → Analysebild der nativen Kamera: „viewport" | „fill" (§ 6.2). */
  cropMap?: string;
  /** Diagnose an: der ausgewertete Kartenausschnitt (JPEG, Base64, ~6 KB); bei der
   *  nativen Kamera der Ausschnitt mit Luft, Rahmen gelb und Einrast-Rechteck grün. */
  crop?: string;
  /** Karte wurde eingerastet (Kanten gefunden) statt des Rahmens genommen (§ 6.2, Schritt 3). */
  cropSnapped?: boolean;
  /** Karte wurde entzerrt (M20): Schräglage in Grad — nur wenn das entzerrte Bild gewann. */
  cropTilt?: number;
  /** Nutzer hat die Übernahme rückgängig gemacht → Fehltreffer, keine Ground Truth. */
  rejected?: boolean;
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
  /** Zweiter Commander (Partner, Hintergrund …), nur mit `twoCommanders` (M20). */
  partnerId?: string;
  /** Schalter „Zwei Commander" — zeigt den zweiten Commander-Platz. */
  twoCommanders?: boolean;
  cards: DeckCard[]; // Mainboard
  sideboard: DeckCard[];
  updatedAt: number;
}

/** Die Commander des Decks (0, 1 oder 2), erster zuerst. */
export function commanderIds(deck: Pick<Deck, 'commanderId' | 'partnerId'>): string[] {
  const out: string[] = [];
  if (deck.commanderId) out.push(deck.commanderId);
  if (deck.partnerId && deck.partnerId !== deck.commanderId) out.push(deck.partnerId);
  return out;
}

// --- Fertigdecks (Precons, M19) ---------------------------------------------

export type PreconGroup = 'commander' | 'starter' | 'duel' | 'jumpstart' | 'secretlair' | 'other';

/** Karte im Fertigdeck: genaue Druckausgabe (scryfallId), Anzahl, Ausführung. */
export interface PreconCard {
  p: string;
  n: number;
  f: Finish;
}

/** Fertigdeck aus dem Katalog (MTGJSON) — Katalogdaten, beim Update ersetzt. */
export interface Precon {
  key: string; // MTGJSON-Dateiname, z. B. „CavalryCharge_MOC"
  name: string;
  set: string; // „moc"
  date: string; // ISO-Datum, kann leer sein
  group: PreconGroup;
  type: string; // MTGJSON-Typ (englisch), z. B. „Commander Deck"
  commander: PreconCard[];
  main: PreconCard[];
  side: PreconCard[];
  /** liegt bei, gehört aber nicht ins Deck (Display-Commander, Planes, Schemes) */
  extra: PreconCard[];
  tokens: PreconCard[];
  /** Karten, die der Katalog beim Bau nicht kannte */
  unknown: number;
  /** normalisierter Suchtext (Name, Set, Commander EN+DE), beim Import gebaut */
  search: string;
}

/** Eine Buchung in die Sammlung — gemerkt, damit „Wieder entfernen" genau das abzieht. */
export interface OwnedBooking {
  oracleId: string;
  finish: Finish;
  printingId?: string;
  qty: number;
}

/** In die Sammlung übernommenes Fertigdeck (Nutzerdaten, kommt ins Backup). */
export interface OwnedPrecon {
  id?: number;
  key: string;
  name: string;
  set: string;
  addedAt: number;
  copies: number;
  /** beim Hinzufügen angelegtes Deck (fehlt, wenn keins angelegt oder nach Restore) */
  deckId?: number;
  items: OwnedBooking[];
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
