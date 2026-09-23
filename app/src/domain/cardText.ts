/**
 * Kartentext aus der nativen Texterkennung (ML Kit) auswerten. Framework-frei & rein
 * testbar. Jede Zeile hat eine Position relativ zur Karte (0..1), dadurch findet die
 * App Namens- und Sammlernummer-Zeile selbst — ohne feste Ausschnitte.
 *
 * Kartenaufbau (Hochkant): Name oben links; seit M15 unten links die Druckinfo,
 *   ab 2020:  „123/281 R" + „DMU • EN  ✎ Künstler"
 *   ab 2023:  „0123 R"    + „MOM • EN  ✎ Künstler"
 * Unten rechts stehen Stärke/Widerstand und das Copyright — die sind Tabu, sonst
 * liest man „3/2" oder „2022" als Nummer.
 */

export interface TextLine {
  text: string;
  /** Position relativ zur Karte, 0..1 (links, oben, rechts, unten). */
  l: number;
  t: number;
  r: number;
  b: number;
  /** ML-Kit-Sicherheit 0..1, falls vorhanden. */
  conf?: number;
}

export interface CollectorInfo {
  /** Set-Code, klein (z. B. „dmu"). */
  set?: string;
  /** Sammlernummer ohne führende Nullen (z. B. „123", „45a"). */
  number?: string;
  /** Sprache, klein (z. B. „en", „de"). */
  lang?: string;
}

const NAME_BAND = 0.16; // Titel liegt im oberen ~16 %
const COLLECTOR_TOP = 0.86; // Druckinfo im unteren ~14 %
const COLLECTOR_MAX_LEFT = 0.45; // …und links (rechts: Stärke/Widerstand, Copyright)

const LETTERS = /[A-Za-zÄÖÜäöüßÀ-ÿ]/g;
function letterCount(s: string): number {
  return (s.match(LETTERS) ?? []).length;
}

/** Namenszeile: oberste Zeile im Titelbereich, die links beginnt und nach Wort aussieht. */
export function pickNameLine(lines: readonly TextLine[]): TextLine | null {
  const cands = lines.filter((l) => l.t < NAME_BAND && l.l < 0.5 && letterCount(l.text) >= 3);
  cands.sort((a, b) => a.t - b.t || b.r - b.l - (a.r - a.l));
  return cands[0] ?? null;
}

/**
 * Namenszeile säubern: Manasymbole oben rechts landen manchmal in derselben Zeile
 * („Sol Ring 1", „Lightning Bolt ®"). Kurze Nicht-Wort-Reste am Ende abschneiden.
 */
export function cleanNameText(text: string): string {
  const tokens = text.trim().split(/\s+/);
  while (tokens.length > 1 && /^[^A-Za-zÄÖÜäöüß]{1,4}$|^[A-Za-z]$/.test(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** Text der Druckinfo-Zeilen (unten links), oben nach unten zusammengefügt. */
export function collectorText(lines: readonly TextLine[]): string {
  return lines
    .filter((l) => l.t >= COLLECTOR_TOP && l.l < COLLECTOR_MAX_LEFT)
    .sort((a, b) => a.t - b.t || a.l - b.l)
    .map((l) => l.text)
    .join(' ');
}

const LANGS = 'EN|DE|FR|ES|IT|PT|JA|JP|KO|RU|ZHS|ZHT|CS|CT|PH';
const SET_LANG = new RegExp(`\\b([A-Z0-9]{3,5})\\s*[•·∙*.\\-]?\\s*(${LANGS})\\b`);
// Nummer (1–4 Ziffern, optional Buchstabe), optional „/Gesamt", optional Seltenheit.
const NUMBER = /(?:^|\s)0*(\d{1,4}[a-z]?)(?:\s*\/\s*\d{1,4})?(?:\s+[CURMLSTP])?(?=\s|$)/i;

/** Set-Code, Sprache und Sammlernummer aus der Druckinfo lesen; null, wenn nichts passt. */
export function parseCollectorText(text: string): CollectorInfo | null {
  const t = text.replace(/[•·∙●]/g, ' • ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const out: CollectorInfo = {};
  const sl = SET_LANG.exec(t.toUpperCase());
  if (sl) {
    out.set = sl[1].toLowerCase();
    out.lang = sl[2] === 'JP' ? 'ja' : sl[2].toLowerCase();
  }
  // Den Set-Teil vor der Nummernsuche entfernen (Codes wie „M21" enthalten Ziffern).
  const rest = sl ? t.toUpperCase().replace(sl[0], ' ') : t.toUpperCase();
  const num = NUMBER.exec(rest);
  if (num) out.number = num[1].toLowerCase();
  return out.set || out.number ? out : null;
}
