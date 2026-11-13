import { describe, it, expect } from 'vitest';
import { recommend, creatureTypes } from './recommend';
import type { Card, Deck } from './types';

const L_COMMANDER = 32;
let n = 0;
function card(name: string, p: Partial<Card> = {}): Card {
  n++;
  return {
    oracleId: p.oracleId ?? `o${n}`, name, normName: name.toLowerCase(), manaCost: '', cmc: 2, colors: [], colorIdentity: [],
    typeLine: 'Sorcery', oracleText: '', layout: 'normal', legalities: L_COMMANDER, maxCopies: 1, ...p,
  };
}

const krenko = card('Krenko, Mob Boss', {
  oracleId: 'krenko', typeLine: 'Legendary Creature — Goblin Warrior', colorIdentity: ['R'], colors: ['R'],
  oracleText: '{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.',
});

describe('Vorschläge aus der eigenen Sammlung', () => {
  it('Kreaturentypen', () => {
    expect(creatureTypes(krenko)).toEqual(['Goblin', 'Warrior']);
    expect(creatureTypes({ typeLine: 'Instant' })).toEqual([]);
  });

  it('Kombo, Lücke, Thema mit Begründung — nichts außerhalb der Farben, nichts doppelt', () => {
    const inDeck = card('Goblin Bombardment', { typeLine: 'Enchantment', colorIdentity: ['R'] });
    const deck: Deck = { name: 'G', format: 'commander', commanderId: 'krenko', cards: [{ oracleId: inDeck.oracleId, qty: 1 }], sideboard: [], updatedAt: 0 };
    const deckCards = new Map([[krenko.oracleId, krenko], [inDeck.oracleId, inDeck]]);
    const comboPiece = card('Skirk Prospector', { typeLine: 'Creature — Goblin', colorIdentity: ['R'], edhrecRank: 900 });
    const ramp = card('Sol Ring', { typeLine: 'Artifact', oracleText: '{T}: Add {C}{C}.', edhrecRank: 1 });
    const goblin = card('Goblin Chieftain', { typeLine: 'Creature — Goblin', colorIdentity: ['R'], oracleText: 'Haste. Other Goblin creatures you control get +1/+1.' });
    const blue = card('Counterspell', { colorIdentity: ['U'], oracleText: 'Counter target spell.' });
    const nothing = card('Gray Ogre', { typeLine: 'Creature — Ogre', colorIdentity: ['R'], edhrecRank: 30000 });
    const illegal = card('Black Lotus', { legalities: 0, typeLine: 'Artifact', oracleText: 'Add three mana of any one color.' });
    const s = recommend({
      deck, deckCards, owned: [comboPiece, ramp, goblin, blue, nothing, illegal, inDeck],
      almostCombos: [{ id: 'k1', names: ['Krenko, Mob Boss', 'Skirk Prospector'], stars: 3, mv: 4, results: ['Unendlich viele Goblins'], missing: 'Skirk Prospector', owned: true }],
    });
    expect(s.map((x) => x.card.name)).toEqual(['Skirk Prospector', 'Sol Ring', 'Goblin Chieftain']);
    expect(s[0].kinds[0]).toBe('kombo');
    expect(s[0].reasons[0]).toBe('Schließt eine Kombo mit Krenko, Mob Boss → Unendlich viele Goblins');
    expect(s[1].reasons).toEqual(['Füllt eine Lücke: Rampe', 'Sehr beliebt (Platz 1)']);
    expect(s[2].reasons[0]).toBe('Passt zum Thema: Goblin');
  });
});
