/**
 * Deck-Text Import/Export im Moxfield-Format (PLAN.md § 7).
 *
 *   4 Lightning Bolt
 *   1 Sol Ring
 *
 *   SIDEBOARD:
 *   2 Duress
 *
 * Import ist tolerant: Set-Code/Sammlernummer in Klammern werden ignoriert
 * (`1 Sol Ring (C21) 263`), Kommentare (`#`, `//`) und leere Zeilen ebenso. Der
 * Import liefert nur Name + Menge — die Auflösung auf oracleIds macht der Aufrufer
 * über den Namensindex (framework-frei bleibt es dadurch).
 */

export interface ParsedLine {
  qty: number;
  name: string;
}

export interface ParsedDeck {
  main: ParsedLine[];
  sideboard: ParsedLine[];
}

const SIDEBOARD_HEADER = /^(sideboard|sb)\b[:]?\s*$/i;
const COMMANDER_HEADER = /^(commander|kommandeur)\b[:]?\s*$/i;
// "4 Lightning Bolt", "4x Lightning Bolt", "Lightning Bolt" (dann qty=1)
const LINE = /^\s*(?:(\d+)\s*[xX]?\s+)?(.+?)\s*$/;
// trailing "(SET) 123" oder "(SET)" abschneiden
const TRAILING_SET = /\s*\((?:[a-z0-9]{2,6})\)(?:\s+\S+)?\s*$/i;

function cleanName(raw: string): string {
  let n = raw.replace(TRAILING_SET, '').trim();
  // Moxfield-Marker wie "*F*" (Foil) am Ende entfernen.
  n = n.replace(/\*[a-z]\*\s*$/i, '').trim();
  return n;
}

export function parseDeckText(text: string): ParsedDeck {
  const main: ParsedLine[] = [];
  const sideboard: ParsedLine[] = [];
  let target = main;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('//')) continue;
    if (SIDEBOARD_HEADER.test(line)) {
      target = sideboard;
      continue;
    }
    if (COMMANDER_HEADER.test(line)) {
      target = main; // Commander landet im Mainboard (v1)
      continue;
    }
    const m = LINE.exec(line);
    if (!m) continue;
    const qty = m[1] ? parseInt(m[1], 10) : 1;
    const name = cleanName(m[2]);
    if (!name || qty <= 0) continue;
    // gleiche Karte zusammenfassen
    const existing = target.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.qty += qty;
    else target.push({ qty, name });
  }
  return { main, sideboard };
}

export function serializeDeckText(
  main: readonly ParsedLine[],
  sideboard: readonly ParsedLine[] = [],
): string {
  const lines: string[] = [];
  for (const e of main) lines.push(`${e.qty} ${e.name}`);
  if (sideboard.length > 0) {
    lines.push('', 'SIDEBOARD:');
    for (const e of sideboard) lines.push(`${e.qty} ${e.name}`);
  }
  return lines.join('\n') + '\n';
}
