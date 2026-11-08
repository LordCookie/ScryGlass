import { describe, it, expect } from 'vitest';
import { ROLE, type Card, type Deck } from './types';
import {
  isExtraTurn, isMassLandDenial, cardRoles, landColors, pips, findCombos, recommendedLands, checkDeck, KNOWN_COMBOS, type DeckCombo,
} from './deckCheck';

let n = 0;
function card(name: string, oracleText: string, extra: Partial<Card> = {}): Card {
  n++;
  return {
    oracleId: `o${n}`, name, normName: name.toLowerCase(), manaCost: '', cmc: 0, colors: [], colorIdentity: [],
    typeLine: 'Sorcery', oracleText, layout: 'normal', legalities: 0xff, maxCopies: 4, ...extra,
  };
}
const land = (name: string, typeLine: string, oracleText = '') => card(name, oracleText, { typeLine, maxCopies: /Basic/.test(typeLine) ? 99 : 4 });

describe('Erkennung am Regeltext', () => {
  it('Zusatzzüge — aber nicht „würde einen Zusatzzug nehmen"', () => {
    expect(isExtraTurn(card('Time Warp', 'Target player takes an extra turn after this one.'))).toBe(true);
    expect(isExtraTurn(card('Nexus of Fate', 'Take an extra turn after this one.\nIf Nexus of Fate would be put into a graveyard from anywhere, reveal Nexus of Fate and shuffle it into its owner’s library instead.'))).toBe(true);
    expect(isExtraTurn(card('Time Stretch', 'Target player takes two extra turns after this one.'))).toBe(true);
    expect(isExtraTurn(card('Stranglehold', 'Your opponents can’t search libraries.\nIf an opponent would begin an extra turn, that player skips that turn instead.'))).toBe(false);
    expect(isExtraTurn(card('Lightning Bolt', 'Lightning Bolt deals 3 damage to any target.'))).toBe(false);
  });

  it('Massen-Landzerstörung', () => {
    const mld = [
      card('Armageddon', 'Destroy all lands.'),
      card('Jokulhaups', 'Destroy all artifacts, creatures, and lands. They can’t be regenerated.'),
      card('Wildfire', 'Each player sacrifices four lands. Wildfire deals 4 damage to each creature.'),
      card('Sunder', 'Return all lands to their owners’ hands.'),
      card('Winter Orb', 'As long as Winter Orb is untapped, players can’t untap more than one land during their untap steps.'),
      card('Blood Moon', 'Nonbasic lands are Mountains.'),
      card('Back to Basics', 'Nonbasic lands don’t untap during their controllers’ untap steps.'),
      card('Global Ruin', 'Each player chooses from the lands they control a land of each basic land type, then sacrifices the rest.'),
    ];
    for (const c of mld) expect(isMassLandDenial(c), c.name).toBe(true);
    expect(isMassLandDenial(card('Wrath of God', 'Destroy all creatures. They can’t be regenerated.'))).toBe(false);
    expect(isMassLandDenial(card('Stone Rain', 'Destroy target land.'))).toBe(false);
  });

  it('Rollen: Rampe, Kartenziehen, Removal, Wipes', () => {
    const roles = (c: Card) => [...cardRoles(c)].sort();
    expect(roles(card('Sol Ring', '{T}: Add {C}{C}.', { typeLine: 'Artifact' }))).toEqual(['ramp']);
    expect(roles(card('Llanowar Elves', '{T}: Add {G}.', { typeLine: 'Creature — Elf Druid' }))).toEqual(['ramp']);
    expect(roles(card('Cultivate', 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.'))).toEqual(['ramp']);
    expect(roles(card('Dark Ritual', 'Add {B}{B}{B}.'))).toEqual([]);
    expect(roles(card('Harmonize', 'Draw three cards.'))).toEqual(['draw']);
    expect(roles(card('Ancestral Recall', 'Target player draws three cards.'))).toEqual(['draw']);
    expect(roles(card('Howling Mine', 'At the beginning of each player’s draw step, if Howling Mine is untapped, that player draws an additional card.'))).toEqual(['draw']);
    expect(roles(card('Swords to Plowshares', 'Exile target creature. Its controller gains life equal to its power.'))).toEqual(['removal']);
    expect(roles(card('Counterspell', 'Counter target spell.'))).toEqual(['removal']);
    expect(roles(card('Relic of Progenitus', '{T}: Target player exiles a card from their graveyard.\n{1}, Exile Relic of Progenitus: Exile all graveyards. Draw a card.'))).toEqual(['draw']);
    expect(roles(card('Bojuka Bog', 'When Bojuka Bog enters, exile target player’s graveyard.'))).toEqual([]);
    expect(roles(card('Wrath of God', 'Destroy all creatures. They can’t be regenerated.'))).toEqual(['wipe']);
    expect(roles(card('Toxic Deluge', 'As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.'))).toEqual(['wipe']);
    expect(roles(card('Phyrexian Arena', 'At the beginning of your upkeep, you draw a card and you lose 1 life.'))).toEqual(['draw']);
    expect(roles(land('Forest', 'Basic Land — Forest', '({T}: Add {G}.)'))).toEqual([]); // Länder sind keine Rampe
  });

  it('Farben von Ländern', () => {
    const colors = (c: Card) => [...landColors(c)].sort().join('');
    expect(colors(land('Forest', 'Basic Land — Forest', '({T}: Add {G}.)'))).toBe('G');
    expect(colors(land('Steam Vents', 'Land — Island Mountain', '({T}: Add {U} or {R}.)'))).toBe('RU');
    expect(colors(land('Polluted Delta', 'Land', '{T}, Pay 1 life, Sacrifice Polluted Delta: Search your library for an Island or Swamp card, put it onto the battlefield, then shuffle.'))).toBe('BU');
    expect(colors(land('Evolving Wilds', 'Land', '{T}, Sacrifice Evolving Wilds: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.'))).toBe('BGRUW');
    expect(colors(land('Command Tower', 'Land', '{T}: Add one mana of any color in your commander’s color identity.'))).toBe('BGRUW');
    expect(colors(land('Rogue’s Passage', 'Land', '{T}: Add {C}.\n{4}, {T}: Target creature can’t be blocked this turn.'))).toBe('');
  });

  it('Farbsymbole: Hybrid anteilig, Phyrexanisch voll', () => {
    expect(pips('{2}{G}{G}')).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 2 });
    expect(pips('{W/U}{G/P}{X}')).toEqual({ W: 0.5, U: 0.5, B: 0, R: 0, G: 1 });
  });

  it('Kombos aus der Auswahl', () => {
    expect(findCombos(new Set(["Thassa's Oracle", 'Demonic Consultation', 'Sol Ring']))).toEqual([
      { pair: ["Thassa's Oracle", 'Demonic Consultation'], note: 'gewinnt sofort' },
    ]);
    expect(findCombos(new Set(["Thassa's Oracle"]))).toEqual([]);
    // keine doppelten Paare in der Liste
    const keys = KNOWN_COMBOS.map(([a, b]) => [a, b].sort().join('+'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('Länder-Faustregel nach Karsten', () => {
    expect(Math.round(recommendedLands('commander', 3, 10))).toBe(38);
    expect(Math.round(recommendedLands('sixty', 2, 8))).toBe(21);
  });
});

describe('Deck-Check gesamt', () => {
  const cmd = card('Krenko, Mob Boss', '{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.',
    { typeLine: 'Legendary Creature — Goblin Warrior', manaCost: '{2}{R}{R}', cmc: 4, colors: ['R'], colorIdentity: ['R'] });
  const mountain = land('Mountain', 'Basic Land — Mountain', '({T}: Add {R}.)');
  const island = land('Island', 'Basic Land — Island', '({T}: Add {U}.)');
  const bolt = card('Lightning Bolt', 'Lightning Bolt deals 3 damage to any target.', { manaCost: '{R}', cmc: 1, colorIdentity: ['R'] });
  const gc1 = card('Jeska’s Will', 'Choose one or both — …', { manaCost: '{2}{R}', cmc: 3, colorIdentity: ['R'], gameChanger: true });
  const arma = card('Ravages of War', 'Destroy all lands.', { manaCost: '{3}{W}', cmc: 4, colorIdentity: ['W'] });
  const lookup = (cs: Card[]) => new Map(cs.map((c) => [c.oracleId, c]));

  function deck(cards: [Card, number][], extra: Partial<Deck> = {}): Deck {
    return { name: 'T', format: 'commander', commanderId: cmd.oracleId, cards: cards.map(([c, qty]) => ({ oracleId: c.oracleId, qty })), sideboard: [], updatedAt: 0, ...extra };
  }

  it('ohne Auffälliges: Bracket 1–2, Länder und Farben passen', () => {
    const d = deck([[bolt, 1], [mountain, 37]]);
    // 61 Füller mit Manawert 2: Faustregel ~38 Länder
    const fillers = Array.from({ length: 61 }, (_, i) => card(`Goblin ${i}`, 'Haste', { manaCost: '{1}{R}', cmc: 2, colorIdentity: ['R'], typeLine: 'Creature — Goblin' }));
    d.cards.push(...fillers.map((c) => ({ oracleId: c.oracleId, qty: 1 })));
    const r = checkDeck(d, lookup([cmd, bolt, mountain, ...fillers]), { gameChangerData: true });
    expect(r.bracket).toEqual({ floor: 2, reasons: [], missingGameChangers: false });
    const mana = r.sections.find((s) => s.title === 'Manabasis')!;
    expect(mana.items.map((i) => i.level)).toEqual(['ok', 'ok']);
    expect(r.sections[0].items[0].level).toBe('ok'); // 100 Karten, Regeln passen
  });

  it('Game Changer und Massen-Landzerstörung heben die Untergrenze', () => {
    const r = checkDeck(deck([[gc1, 1], [mountain, 30]]), lookup([cmd, gc1, mountain]), { gameChangerData: true });
    expect(r.bracket?.floor).toBe(3);
    expect(r.bracket?.reasons[0].cards).toEqual(['Jeska’s Will']);
    const r2 = checkDeck(deck([[gc1, 1], [arma, 1], [mountain, 30]]), lookup([cmd, gc1, arma, mountain]), { gameChangerData: true });
    expect(r2.bracket?.floor).toBe(4);
  });

  it('meldet fehlende Game-Changer-Daten statt still „1–2" zu sagen', () => {
    const r = checkDeck(deck([[mountain, 30]]), lookup([cmd, mountain]), { gameChangerData: false });
    expect(r.bracket?.missingGameChangers).toBe(true);
  });

  it('zu wenige Quellen einer Farbe', () => {
    const blue = card('Counterspell', 'Counter target spell.', { manaCost: '{U}{U}', cmc: 2, colorIdentity: ['U'] });
    const r = checkDeck(deck([[blue, 20], [bolt, 20], [mountain, 18], [island, 2]], { format: 'modern', commanderId: undefined }),
      lookup([blue, bolt, mountain, island]), { gameChangerData: true });
    expect(r.bracket).toBeUndefined(); // Brackets nur für Commander
    const warn = r.sections.find((s) => s.title === 'Manabasis')!.items.find((i) => i.key === 'color-U');
    expect(warn?.level).toBe('warn');
    expect(warn?.detail).toContain('nur 2 von 20 Ländern');
  });
});

describe('Deck-Check mit Scryfall-Tags und Spellbook-Kombos', () => {
  const cmd = card('Krenko, Mob Boss', '', { typeLine: 'Legendary Creature — Goblin', manaCost: '{2}{R}{R}', cmc: 4, colorIdentity: ['R'] });
  const mountain = land('Mountain', 'Basic Land — Mountain', '({T}: Add {R}.)');
  // Regeltext ohne Treffer, aber getaggt — die Tags gewinnen.
  const rock = card('Mind Stone', 'Something', { typeLine: 'Artifact', manaCost: '{2}', cmc: 2, roles: ROLE.ramp | ROLE.draw });
  const orb = card('Winter Orb', 'Nothing matching', { typeLine: 'Artifact', manaCost: '{2}', cmc: 2, roles: ROLE.mld });
  const lookup = (cs: Card[]) => new Map(cs.map((c) => [c.oracleId, c]));
  const deck = (cs: Card[]): Deck => ({
    name: 'T', format: 'commander', commanderId: cmd.oracleId,
    cards: [...cs.map((c) => ({ oracleId: c.oracleId, qty: 1 })), { oracleId: mountain.oracleId, qty: 30 }], sideboard: [], updatedAt: 0,
  });
  const combo = (stars: number, extra: Partial<DeckCombo> = {}): DeckCombo => ({
    id: `k${stars}`, names: ['A', 'B'], stars, mv: 3, results: ['Gewinnt das Spiel'], ...extra,
  });

  it('Rollen und Landzerstörung aus den Tags', () => {
    const r = checkDeck(deck([rock, orb]), lookup([cmd, mountain, rock, orb]), { gameChangerData: true, roleData: true });
    const roles = r.sections.find((s) => s.title.startsWith('Rollen'))!;
    expect(roles.title).toBe('Rollen (Scryfall-Tags)');
    expect(roles.items.find((i) => i.key === 'role-ramp')?.cards).toEqual(['Mind Stone']);
    expect(roles.items.find((i) => i.key === 'role-draw')?.cards).toEqual(['Mind Stone']);
    expect(r.bracket?.floor).toBe(4);
    expect(r.bracket?.reasons[0].cards).toEqual(['Winter Orb']);
  });

  it('Spellbook-Kombos: ★★★★ → Bracket 4, ★★★ → 3, mit Sternen und Link', () => {
    const base = { gameChangerData: true, roleData: true };
    const four = checkDeck(deck([]), lookup([cmd, mountain]), { ...base, combos: { included: [combo(4)], almost: [] } });
    expect(four.bracket?.floor).toBe(4);
    const three = checkDeck(deck([]), lookup([cmd, mountain]), { ...base, combos: { included: [combo(3)], almost: [] } });
    expect(three.bracket?.floor).toBe(3);
    const two = checkDeck(deck([]), lookup([cmd, mountain]), { ...base, combos: { included: [combo(2)], almost: [] } });
    expect(two.bracket?.floor).toBe(2); // braucht mehr Aufwand — hebt das Bracket nicht
    const items = four.sections.find((s) => s.title === 'Kombos')!.items;
    expect(items[0]).toMatchObject({ title: 'A + B', stars: 4, link: 'k4', detail: 'Gewinnt das Spiel — Auslösen: 3 Mana' });
  });

  it('eine Karte fehlt: die aus der Sammlung zuerst, Rest als Zahl', () => {
    const r = checkDeck(deck([]), lookup([cmd, mountain]), {
      gameChangerData: true,
      combos: {
        included: [],
        almost: [combo(3, { id: 'x', missing: 'B', owned: true }), combo(2, { id: 'y', missing: 'C', owned: false })],
      },
    });
    const items = r.sections.find((s) => s.title === 'Kombos')!.items;
    expect(items.map((i) => i.title)).toEqual([
      'Keine Kombo im Deck.',
      'Fehlt nur B — du besitzt sie',
      'Bei 1 weiteren Kombos fehlt dem Deck je eine Karte.',
    ]);
  });
});
