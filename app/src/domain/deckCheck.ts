/**
 * Deck-Check (PLAN.md M17): regelbasiert und erklärbar — jede Aussage nennt die Karten,
 * die sie auslösen. Bewusst kein trainiertes Modell (keine freien Trainingsdaten, und eine
 * Zahl ohne Begründung hilft niemandem). Grenzen, die die Oberfläche auch so sagt:
 * Brackets hängen zusätzlich von der Absicht ab, Rollen (Rampe, Kartenziehen …) werden
 * nur grob am Regeltext erkannt, Kombos stammen aus einer Auswahl bekannter Paare.
 */
import type { Card, Deck } from './types';
import { validateDeck, type CardLookup } from './deckValidate';
import { isLand } from './deckStats';

export type CheckLevel = 'ok' | 'info' | 'warn';

export interface CheckItem {
  key: string;
  level: CheckLevel;
  title: string;
  detail?: string;
  /** Karten, die den Punkt auslösen (Namen, sortiert). */
  cards?: string[];
}

export interface CheckSection {
  title: string;
  items: CheckItem[];
}

export interface BracketEstimate {
  /** Untergrenze nach den Bracket-Regeln: 2 = „1–2", 3 = Upgraded, 4 = Optimized/cEDH. */
  floor: 2 | 3 | 4;
  reasons: { text: string; cards: string[] }[];
  /** Katalog ohne Game-Changer-Markierung (vor M17) — Schätzung ohne diese Regel. */
  missingGameChangers: boolean;
}

export interface DeckCheckResult {
  bracket?: BracketEstimate;
  sections: CheckSection[];
}

type Color = 'W' | 'U' | 'B' | 'R' | 'G';
const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
export const COLOR_NAMES: Record<Color, string> = { W: 'Weiß', U: 'Blau', B: 'Schwarz', R: 'Rot', G: 'Grün' };

/** Regeltext klein, typografische Apostrophe vereinheitlicht, in Sätze zerlegt. */
function sentences(card: Card): string[] {
  return card.oracleText.toLowerCase().replace(/’/g, "'").split(/[.\n]+/).map((s) => s.trim()).filter(Boolean);
}

// --- Erkennung einzelner Karten ---------------------------------------------

export function isExtraTurn(card: Card): boolean {
  return sentences(card).some(
    (s) => /\btakes? (?:an|one|two|three|x|that many) extra turns?\b/.test(s) && !/\b(?:would|can't) take\b/.test(s),
  );
}

/** Massen-Landzerstörung im Sinne der Brackets: viele Länder zerstören, zurückschicken,
 *  getappt halten oder ihr Mana ändern. */
const MASS_LAND_DENIAL = [
  /\b(?:destroy|exile) all [^.]*\blands\b/, // Armageddon, Jokulhaups, Decree of Annihilation
  /\beach (?:player|opponent) sacrifices [^.]*\blands\b/, // Wildfire, Destructive Force
  /\breturn all (?:lands|permanents) to their owners' hands\b/, // Sunder, Upheaval
  /\bsacrifices (?:the rest|all other permanents)\b/, // Global Ruin, Cataclysm
  /\bcan't untap more than (?:one|two) (?:lands?|permanents)\b/, // Winter Orb, Static Orb
  /\b(?:nonbasic )?lands don't untap\b/, // Hokori, Back to Basics
  /\bskip their untap steps?\b/, // Stasis
  /\bnonbasic lands are (?:plains|islands|swamps|mountains|forests)\b/, // Blood Moon
  /\bif a land is tapped for mana, it produces\b/, // Contamination
];

export function isMassLandDenial(card: Card): boolean {
  return sentences(card).some((s) => MASS_LAND_DENIAL.some((re) => re.test(s)));
}

export type Role = 'ramp' | 'draw' | 'removal' | 'wipe';

const ROLE_PATTERNS: Record<Role, RegExp[]> = {
  ramp: [
    /\{t\}(?:, [^:]*)?: add\b/, // Manasteine und Mana-Kreaturen (Rituale ohne {T} zählen nicht)
    /\bsearch your library for [^.]*\blands? cards?[^.]*onto the battlefield\b/, // Cultivate
    /\bput (?:a|an|up to \w+) lands? cards? from your hand onto the battlefield\b/,
    /\byou may play (?:an|two) additional lands?\b/,
  ],
  draw: [
    /\bdraws? (?:a|an|one|two|three|four|five|six|seven|x|that many|\w+) (?:additional )?cards?\b/,
    /\bdraws? cards equal to\b/,
  ],
  removal: [
    /\b(?:destroy|exile) target (?!card\b|cards\b|land\b|player\b)/,
    /\bdeals? (?:\d+|x|that much) damage to (?:any target|target creature|target planeswalker)/,
    /\bcounter target\b/,
    /\breturn target (?:nonland )?(?:permanent|creature)[^.]*to its owner's hand\b/,
    /\b(?:target|each) (?:player|opponent) sacrifices (?:a|an) (?:creature|attacking creature|nonland permanent)\b/,
  ],
  wipe: [
    /\b(?:destroy|exile) all (?:other )?(?:creatures|nonland permanents|permanents|artifacts|enchantments)\b/,
    /\ball (?:other )?creatures get -(?:\d+|x)\/-(?:\d+|x)\b/,
    /\bdeals? (?:\d+|x) damage to each creature\b/,
    /\breturn all (?:nonland )?(?:permanents|creatures) to their owners' hands\b/,
  ],
};

/** Gegner ziehen lassen ist kein Kartenvorteil. */
const OPPONENT_DRAWS = /\b(?:opponent|its controller) draws?\b/;

export function cardRoles(card: Card): Set<Role> {
  const out = new Set<Role>();
  if (isLand(card)) return out;
  for (const s of sentences(card)) {
    for (const role of Object.keys(ROLE_PATTERNS) as Role[]) {
      if (!ROLE_PATTERNS[role].some((re) => re.test(s))) continue;
      if (role === 'draw' && OPPONENT_DRAWS.test(s)) continue;
      out.add(role);
    }
  }
  return out;
}

const BASIC_TYPES: [RegExp, Color][] = [
  [/\bplains\b/, 'W'], [/\bislands?\b/, 'U'], [/\bswamps?\b/, 'B'], [/\bmountains?\b/, 'R'], [/\bforests?\b/, 'G'],
];

/** Farben, die ein Land bringt: Standardland-Typen, „Add {X}", „beliebige Farbe", Fetchländer. */
export function landColors(card: Card): Set<Color> {
  const out = new Set<Color>();
  const type = card.typeLine.toLowerCase();
  for (const [re, c] of BASIC_TYPES) if (re.test(type)) out.add(c);
  for (const s of sentences(card)) {
    const add = s.search(/\badd\b/);
    if (add >= 0) {
      const tail = s.slice(add);
      if (/\bany (?:one )?(?:color|type)\b|any combination of colors/.test(tail)) COLORS.forEach((c) => out.add(c));
      for (const m of tail.matchAll(/\{([wubrg])\}/g)) out.add(m[1].toUpperCase() as Color);
    }
    if (/\bsearch your library for\b/.test(s)) {
      const named = BASIC_TYPES.filter(([re]) => re.test(s));
      if (named.length > 0) named.forEach(([, c]) => out.add(c));
      else if (/\bbasic land card\b/.test(s)) COLORS.forEach((c) => out.add(c)); // Evolving Wilds
    }
  }
  return out;
}

/** Farbsymbole der Manakosten; Hybrid zählt anteilig, Phyrexanisch voll. */
export function pips(manaCost: string): Record<Color, number> {
  const out: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const m of manaCost.matchAll(/\{([^}]+)\}/g)) {
    const parts = m[1].toUpperCase().split('/').filter((p): p is Color => (COLORS as string[]).includes(p));
    for (const p of parts) out[p] += 1 / parts.length;
  }
  return out;
}

// --- Bekannte Zwei-Karten-Kombos (Auswahl) -----------------------------------

/** Bekannte Paare, die allein (ggf. mit etwas Mana) gewinnen oder endlos laufen. Bewusst
 *  eine kleine Auswahl — vollständig wäre erst eine Kombo-Datenbank (M17, Lizenz offen). */
export const KNOWN_COMBOS: readonly [string, string, string][] = [
  ["Thassa's Oracle", 'Demonic Consultation', 'gewinnt sofort'],
  ["Thassa's Oracle", 'Tainted Pact', 'gewinnt sofort'],
  ['Laboratory Maniac', 'Demonic Consultation', 'gewinnt sofort'],
  ['Jace, Wielder of Mysteries', 'Demonic Consultation', 'gewinnt sofort'],
  ['Jace, Wielder of Mysteries', 'Tainted Pact', 'gewinnt sofort'],
  ['Isochron Scepter', 'Dramatic Reversal', 'endlos Mana mit Manasteinen'],
  ['Exquisite Blood', 'Sanguine Bond', 'endlos Lebensverlust'],
  ['Exquisite Blood', 'Vito, Thorn of the Dusk Rose', 'endlos Lebensverlust'],
  ['Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts', 'endlos Kreaturen mit Eile'],
  ['Kiki-Jiki, Mirror Breaker', 'Pestermite', 'endlos Kreaturen mit Eile'],
  ['Kiki-Jiki, Mirror Breaker', 'Deceiver Exarch', 'endlos Kreaturen mit Eile'],
  ['Kiki-Jiki, Mirror Breaker', 'Felidar Guardian', 'endlos Kreaturen mit Eile'],
  ['Splinter Twin', 'Pestermite', 'endlos Kreaturen mit Eile'],
  ['Splinter Twin', 'Deceiver Exarch', 'endlos Kreaturen mit Eile'],
  ['Saheeli Rai', 'Felidar Guardian', 'endlos Kreaturen mit Eile'],
  ['Heliod, Sun-Crowned', 'Walking Ballista', 'endlos Schaden'],
  ['Mikaeus, the Unhallowed', 'Walking Ballista', 'endlos Schaden'],
  ['Mikaeus, the Unhallowed', 'Triskelion', 'endlos Schaden'],
  ['Dualcaster Mage', 'Twinflame', 'endlos Kreaturen mit Eile'],
  ['Dualcaster Mage', 'Heat Shimmer', 'endlos Kreaturen mit Eile'],
  ['Niv-Mizzet, Parun', 'Curiosity', 'endlos Schaden und Karten'],
  ['Niv-Mizzet, Parun', 'Ophidian Eye', 'endlos Schaden und Karten'],
  ['Niv-Mizzet, the Firemind', 'Curiosity', 'endlos Schaden und Karten'],
  ['Niv-Mizzet, the Firemind', 'Ophidian Eye', 'endlos Schaden und Karten'],
  ['Worldgorger Dragon', 'Animate Dead', 'Endlosschleife (Mana, mit Ausweg)'],
  ["Painter's Servant", 'Grindstone', 'mahlt die ganze Bibliothek'],
  ['Basalt Monolith', 'Rings of Brighthearth', 'endlos farbloses Mana'],
  ['Basalt Monolith', 'Power Artifact', 'endlos farbloses Mana'],
  ['Grim Monolith', 'Power Artifact', 'endlos farbloses Mana'],
  ['Kinnan, Bonder Prodigy', 'Basalt Monolith', 'endlos farbloses Mana'],
  ['Devoted Druid', 'Vizier of Remedies', 'endlos grünes Mana'],
  ['Pili-Pala', 'Grand Architect', 'endlos Mana'],
  ['Earthcraft', 'Squirrel Nest', 'endlos Eichhörnchen'],
  ['Bloom Tender', 'Freed from the Real', 'endlos Mana'],
  ['Deadeye Navigator', 'Peregrine Drake', 'endlos Mana'],
  ['Food Chain', 'Squee, the Immortal', 'endlos Mana für Kreaturen'],
  ['Food Chain', 'Eternal Scourge', 'endlos Mana für Kreaturen'],
  ['Food Chain', 'Misthollow Griffin', 'endlos Mana für Kreaturen'],
  ['Sword of the Meek', 'Thopter Foundry', 'endlos Leben und Thopter'],
  ['Bloodchief Ascension', 'Mindcrank', 'mahlt und tötet'],
  ['Godo, Bandit Warlord', 'Helm of the Host', 'endlos Kampfphasen'],
];

export function findCombos(names: ReadonlySet<string>): { pair: [string, string]; note: string }[] {
  return KNOWN_COMBOS.filter(([a, b]) => names.has(a) && names.has(b)).map(([a, b, note]) => ({ pair: [a, b], note }));
}

// --- Gesamtprüfung ----------------------------------------------------------

/** Richtwerte für Commander (verbreitete Faustregel, z. B. „The Command Zone"). */
export const ROLE_TARGETS: Record<Role, number> = { ramp: 10, draw: 10, removal: 8, wipe: 2 };
const ROLE_LABELS: Record<Role, string> = {
  ramp: 'Rampe', draw: 'Kartenziehen', removal: 'Gezieltes Removal', wipe: 'Board-Wipes',
};

/** Empfohlene Länderzahl nach Frank Karsten (2022): Durchschnitts-Manawert der Nichtländer,
 *  günstige Rampe/Kartenziehen (MW ≤ 2) senken den Bedarf etwas. */
export function recommendedLands(format: 'commander' | 'sixty', avgMv: number, cheapRampDraw: number): number {
  return format === 'commander'
    ? 31.42 + 3.13 * avgMv - 0.28 * cheapRampDraw
    : 19.59 + 1.9 * avgMv - 0.28 * cheapRampDraw;
}

const sortNames = (cards: Iterable<Card>) => [...new Set([...cards].map((c) => c.name))].sort((a, b) => a.localeCompare(b));
const fmt1 = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });

export function checkDeck(deck: Deck, cards: CardLookup, opts: { gameChangerData: boolean }): DeckCheckResult {
  const commander = deck.format === 'commander';
  // Mainboard + Commander, je Exemplar.
  const entries: { card: Card; qty: number }[] = [];
  for (const e of deck.cards) {
    const card = cards.get(e.oracleId);
    if (card) entries.push({ card, qty: e.qty });
  }
  const cmdCard = deck.commanderId ? cards.get(deck.commanderId) : undefined;
  if (cmdCard && !deck.cards.some((e) => e.oracleId === cmdCard.oracleId)) entries.push({ card: cmdCard, qty: 1 });
  const all = entries.map((e) => e.card);
  const total = entries.reduce((n, e) => n + e.qty, 0);
  const sections: CheckSection[] = [];

  // Regeln (Deckgröße, Kopien, Legalität, Farbidentität) — wie in der Liste.
  const v = validateDeck(deck, cards);
  sections.push({
    title: 'Regeln',
    items: v.issues.length === 0
      ? [{ key: 'rules-ok', level: 'ok', title: 'Deckgröße, Kopien und Legalität passen.' }]
      : v.issues.map((i, n) => ({
        key: `rule-${n}`,
        level: i.level === 'error' ? 'warn' : 'info',
        title: i.message,
      })),
  });

  // Manabasis
  const mana: CheckItem[] = [];
  const nonland = entries.filter((e) => !isLand(e.card));
  const lands = entries.filter((e) => isLand(e.card));
  const landCount = lands.reduce((n, e) => n + e.qty, 0);
  const nonlandCount = nonland.reduce((n, e) => n + e.qty, 0);
  const roles = new Map(all.map((c) => [c.oracleId, cardRoles(c)]));
  const sized = commander ? 'commander' : total >= 58 ? 'sixty' : null;
  if (sized && nonlandCount > 0) {
    const avgMv = nonland.reduce((n, e) => n + e.card.cmc * e.qty, 0) / nonlandCount;
    const cheap = nonland
      .filter((e) => e.card.cmc <= 2 && (roles.get(e.card.oracleId)!.has('ramp') || roles.get(e.card.oracleId)!.has('draw')))
      .reduce((n, e) => n + e.qty, 0);
    const rec = Math.round(recommendedLands(sized, avgMv, cheap));
    const base = `${landCount} Länder bei Ø Manawert ${fmt1(avgMv)} — Faustregel nach Frank Karsten: etwa ${rec}.`;
    mana.push(
      landCount < rec - 1
        ? { key: 'lands', level: 'warn', title: `Eher zu wenig Länder (${landCount})`, detail: base }
        : landCount > rec + 2
          ? { key: 'lands', level: 'info', title: `Eher viele Länder (${landCount})`, detail: base }
          : { key: 'lands', level: 'ok', title: `Länderzahl passt (${landCount})`, detail: base },
    );
  }
  // Farbquellen gegen Farbsymbole.
  const pipSum: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const e of nonland) {
    const p = pips(e.card.manaCost);
    for (const c of COLORS) pipSum[c] += p[c] * e.qty;
  }
  const totalPips = COLORS.reduce((n, c) => n + pipSum[c], 0);
  const sources: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const e of lands) for (const c of landColors(e.card)) sources[c] += e.qty;
  const used = COLORS.filter((c) => pipSum[c] > 0);
  if (landCount > 0 && used.length > 0) {
    const short = used.filter((c) => sources[c] < 0.6 * (pipSum[c] / totalPips) * landCount);
    const summary = used.map((c) => `${COLOR_NAMES[c]} ${Math.round((pipSum[c] / totalPips) * 100)} % der Symbole, ${sources[c]} Quellen`).join(' · ');
    if (short.length === 0) mana.push({ key: 'colors', level: 'ok', title: 'Farbquellen passen zu den Kosten.', detail: summary });
    for (const c of short) {
      mana.push({
        key: `color-${c}`,
        level: 'warn',
        title: `Zu wenig ${COLOR_NAMES[c]}e Quellen`,
        detail: `${Math.round((pipSum[c] / totalPips) * 100)} % der Farbsymbole sind ${COLOR_NAMES[c]}, aber nur ${sources[c]} von ${landCount} Ländern bringen ${COLOR_NAMES[c]}.`,
      });
    }
  }
  if (mana.length > 0) sections.push({ title: 'Manabasis', items: mana });

  // Rollen (Commander): Rampe, Kartenziehen, Removal, Wipes.
  if (commander) {
    sections.push({
      title: 'Rollen (grob am Regeltext erkannt)',
      items: (Object.keys(ROLE_TARGETS) as Role[]).map((role) => {
        const hits = all.filter((c) => roles.get(c.oracleId)!.has(role));
        const n = hits.length;
        const enough = n >= ROLE_TARGETS[role];
        return {
          key: `role-${role}`,
          level: enough ? 'ok' : 'info',
          title: `${ROLE_LABELS[role]}: ${n}${enough ? '' : ` — Richtwert ${ROLE_TARGETS[role]}`}`,
          cards: sortNames(hits),
        };
      }),
    });
  }

  // Kombos (alle Formate)
  const names = new Set(all.map((c) => c.name));
  const combos = findCombos(names);
  sections.push({
    title: 'Kombos',
    items: combos.length === 0
      ? [{ key: 'combo-none', level: 'ok', title: `Keine der ${KNOWN_COMBOS.length} bekannten Zwei-Karten-Kombos im Deck (Auswahl).` }]
      : combos.map((k) => ({ key: `combo-${k.pair.join('+')}`, level: 'info', title: `${k.pair[0]} + ${k.pair[1]}`, detail: k.note })),
  });

  if (!commander) return { sections };

  // Bracket-Untergrenze nach den offiziellen Regeln (Stand Okt. 2025: Tutoren zählen nicht mehr).
  const reasons: BracketEstimate['reasons'] = [];
  let floor: BracketEstimate['floor'] = 2;
  const raise = (to: BracketEstimate['floor']) => { if (to > floor) floor = to; };
  const gc = all.filter((c) => c.gameChanger);
  if (gc.length > 3) {
    raise(4);
    reasons.push({ text: `${gc.length} Game Changer — Bracket 3 erlaubt höchstens drei.`, cards: sortNames(gc) });
  } else if (gc.length > 0) {
    raise(3);
    reasons.push({ text: `${gc.length} Game Changer — erst ab Bracket 3.`, cards: sortNames(gc) });
  }
  const mld = all.filter(isMassLandDenial);
  if (mld.length > 0) {
    raise(4);
    reasons.push({ text: 'Massen-Landzerstörung — erst ab Bracket 4.', cards: sortNames(mld) });
  }
  const turns = all.filter(isExtraTurn);
  if (turns.length >= 2) {
    raise(4);
    reasons.push({ text: 'Mehrere Zusatzzüge — Ketten erst ab Bracket 4.', cards: sortNames(turns) });
  } else if (turns.length === 1) {
    reasons.push({ text: 'Ein Zusatzzug — in Ordnung, solange er nicht wiederholt wird.', cards: sortNames(turns) });
  }
  if (combos.length > 0) {
    raise(3);
    reasons.push({
      text: 'Zwei-Karten-Kombo — in Bracket 3 nur, wenn sie nicht früh im Spiel kommt; sonst Bracket 4.',
      cards: [...new Set(combos.flatMap((k) => k.pair))].sort((a, b) => a.localeCompare(b)),
    });
  }
  return { bracket: { floor, reasons, missingGameChangers: !opts.gameChangerData }, sections };
}
