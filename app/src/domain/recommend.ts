/**
 * Vorschläge aus der eigenen Sammlung (PLAN.md M22): Was passt in dieses Deck, das du
 * schon besitzt? Wie EDHREC — aber nur aus deinen Karten und ohne fremde Daten:
 *   - schließt eine Kombo (Commander Spellbook, eine Karte fehlt und du hast sie),
 *   - füllt eine Lücke aus dem Deck-Check (Rampe, Kartenvorteil, Removal, Wipes),
 *   - passt zum Thema (Regeltext des Commanders bzw. viele Deckkarten: Marken, Tokens …),
 *   - beliebt (EDHREC-Rang über Scryfall) als Zugabe.
 * Jede Karte mit Begründung. Rein und testbar.
 */
import { cardRoles, ROLE_LABELS, ROLE_TARGETS, type DeckCombo, type Role } from './deckCheck';
import { isLand } from './deckStats';
import { commanderIdentity, colorIdentityWithin } from './deckValidate';
import { popularityTier, TIER_LABEL } from './popularity';
import { commanderIds, isLegal, type Card, type Deck } from './types';

export type Reason = 'kombo' | 'rolle' | 'thema' | 'beliebt';

export interface Suggestion {
  card: Card;
  score: number;
  /** wichtigster Grund zuerst — danach gruppiert die Oberfläche */
  kinds: Reason[];
  reasons: string[];
}

interface Theme {
  key: string;
  label: string;
  re: RegExp;
}

/** Themen, an denen sich Commander und Karten erkennen lassen (Regeltext, englisch). */
export const THEMES: readonly Theme[] = [
  { key: 'counters', label: '+1/+1-Marken', re: /\+1\/\+1 counters?/i },
  { key: 'tokens', label: 'Spielsteine', re: /\bcreate[^.]*\btokens?\b/i },
  { key: 'artifacts', label: 'Artefakte', re: /\bartifacts?\b/i },
  { key: 'enchantments', label: 'Verzauberungen', re: /\benchantments?\b/i },
  { key: 'graveyard', label: 'Friedhof', re: /\bfrom (?:your|a|their) graveyard\b|\bmill\b/i },
  { key: 'lifegain', label: 'Lebenspunkte', re: /\byou gain (?:\w+ )?life\b|\blifelink\b/i },
  { key: 'spells', label: 'Spontanzauber und Hexereien', re: /\binstant or sorcery\b|\bnoncreature spells?\b/i },
  { key: 'sacrifice', label: 'Opfern', re: /\bsacrifice (?:a|another|an)\b/i },
  { key: 'lands', label: 'Länder', re: /\blandfall\b|\bland enters\b|\bplay an additional land\b/i },
  { key: 'equipment', label: 'Ausrüstung', re: /\bequip(?:ped|ment)?\b/i },
];

const isBasic = (c: Card) => /\bBasic\b/.test(c.typeLine) && /\bLand\b/.test(c.typeLine);

/** Kreaturentypen einer Karte („Legendary Creature — Goblin Warrior" → Goblin, Warrior). */
export function creatureTypes(card: Pick<Card, 'typeLine'>): string[] {
  const front = card.typeLine.split(' // ')[0];
  if (!/\bCreature\b/.test(front) || !front.includes('—')) return [];
  return front.split('—')[1].trim().split(/\s+/).filter(Boolean);
}

export interface RecommendInput {
  deck: Deck;
  /** Karten des Decks (inkl. Commander) */
  deckCards: ReadonlyMap<string, Card>;
  /** eigene Karten, die als Vorschlag in Frage kommen */
  owned: readonly Card[];
  /** „fast im Deck"-Kombos (eine Karte fehlt), vom Aufrufer aus Commander Spellbook */
  almostCombos?: readonly DeckCombo[];
  /** Katalog hat Rollen aus den Scryfall-Tags */
  roleTags?: boolean;
  limit?: number;
}

export function recommend(input: RecommendInput): Suggestion[] {
  const { deck, deckCards } = input;
  const leads = deck.format === 'commander' || deck.format === 'brawl';
  const cmdCards = commanderIds(deck).map((id) => deckCards.get(id)).filter((c): c is Card => !!c);
  const inDeck = new Set([...deck.cards, ...deck.sideboard].map((c) => c.oracleId).concat(commanderIds(deck)));
  const mainCards = deck.cards.map((e) => deckCards.get(e.oracleId)).filter((c): c is Card => !!c);

  // Erlaubte Farben: Commander-Identität, sonst die Farben, die das Deck schon spielt.
  const identity = leads && cmdCards.length
    ? commanderIdentity(cmdCards)
    : mainCards.length ? [...new Set(mainCards.flatMap((c) => c.colorIdentity))] : null;

  // Lücken aus dem Deck-Check (nur Commander: dort gibt es Richtwerte).
  const gaps = new Set<Role>();
  if (deck.format === 'commander') {
    const count: Record<Role, number> = { ramp: 0, draw: 0, removal: 0, wipe: 0 };
    for (const e of deck.cards) {
      const c = deckCards.get(e.oracleId);
      if (c) for (const r of cardRoles(c, input.roleTags)) count[r] += e.qty;
    }
    for (const r of Object.keys(count) as Role[]) if (count[r] < ROLE_TARGETS[r]) gaps.add(r);
  }

  // Themen: was der Commander verlangt, oder was viele Deckkarten tun.
  const nonland = mainCards.filter((c) => !isLand(c));
  const minHits = Math.max(4, Math.round(nonland.length * 0.08));
  const themes = THEMES.filter((t) =>
    cmdCards.some((c) => t.re.test(c.oracleText)) || nonland.filter((c) => t.re.test(c.oracleText)).length >= minHits);
  // Kreaturentyp: nennt der Commander seinen eigenen Typ im Regeltext („Goblins you control")?
  const tribes = new Set<string>();
  for (const c of cmdCards) {
    for (const t of creatureTypes(c)) if (new RegExp(`\\b${t}s?\\b`, 'i').test(c.oracleText)) tribes.add(t);
  }

  // Kombos, denen genau eine eigene Karte fehlt.
  const comboFor = new Map<string, DeckCombo>();
  for (const k of input.almostCombos ?? []) {
    if (k.missing && k.owned && !comboFor.has(k.missing)) comboFor.set(k.missing, k);
  }

  const out: Suggestion[] = [];
  for (const card of input.owned) {
    if (inDeck.has(card.oracleId) || isBasic(card) || card.layout === 'token') continue;
    if (!isLegal(card.legalities, deck.format)) continue;
    if (identity && !colorIdentityWithin(card, identity)) continue;
    const kinds: Reason[] = [];
    const reasons: string[] = [];
    let score = 0;
    const combo = comboFor.get(card.name);
    if (combo) {
      score += 100;
      kinds.push('kombo');
      const others = combo.names.filter((n) => n !== card.name);
      reasons.push(`Schließt eine Kombo mit ${others.join(' + ')}${combo.results.length ? ` → ${combo.results.slice(0, 2).join(', ')}` : ''}`);
    }
    const roles = [...cardRoles(card, input.roleTags)].filter((r) => gaps.has(r));
    if (roles.length) {
      score += 30;
      kinds.push('rolle');
      reasons.push(`Füllt eine Lücke: ${roles.map((r) => ROLE_LABELS[r]).join(', ')}`);
    }
    const hit = themes.filter((t) => t.re.test(card.oracleText)).slice(0, 2);
    const tribe = [...tribes].find((t) => creatureTypes(card).includes(t) || new RegExp(`\\b${t}s?\\b`, 'i').test(card.oracleText));
    if (hit.length || tribe) {
      score += 20 * hit.length + (tribe ? 25 : 0);
      kinds.push('thema');
      reasons.push(`Passt zum Thema: ${[...(tribe ? [tribe] : []), ...hit.map((t) => t.label)].join(', ')}`);
    }
    if (kinds.length === 0) continue; // nur beliebt reicht nicht
    const tier = popularityTier(card.edhrecRank);
    if (tier && tier !== 'selten') {
      score += tier === 'top' ? 15 : tier === 'beliebt' ? 10 : 5;
      kinds.push('beliebt');
      reasons.push(`${TIER_LABEL[tier][0].toUpperCase()}${TIER_LABEL[tier].slice(1)} (Platz ${card.edhrecRank})`);
    }
    out.push({ card, score, kinds, reasons });
  }
  out.sort((a, b) => b.score - a.score || (a.card.edhrecRank ?? 1e9) - (b.card.edhrecRank ?? 1e9) || a.card.name.localeCompare(b.card.name));
  return out.slice(0, input.limit ?? 60);
}
