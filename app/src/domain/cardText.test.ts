import { describe, it, expect } from 'vitest';
import { pickNameLine, cleanNameText, collectorText, parseCollectorText, type TextLine } from './cardText';

const line = (text: string, l: number, t: number, r = l + 0.4, b = t + 0.04): TextLine => ({ text, l, t, r, b });

describe('pickNameLine', () => {
  it('nimmt die oberste Wortzeile im Titelbereich', () => {
    const lines = [
      line('Flying', 0.08, 0.66),
      line('Delver of Secrets', 0.07, 0.05),
      line('Creature — Human Wizard', 0.07, 0.56),
    ];
    expect(pickNameLine(lines)?.text).toBe('Delver of Secrets');
  });

  it('ignoriert Manasymbole oben rechts und Rauschen', () => {
    const lines = [line('{1}', 0.85, 0.04, 0.95), line('Sol Ring', 0.06, 0.05), line('..', 0.3, 0.02)];
    expect(pickNameLine(lines)?.text).toBe('Sol Ring');
  });

  it('liefert null ohne Titelzeile', () => {
    expect(pickNameLine([line('Flying', 0.08, 0.66)])).toBeNull();
  });
});

describe('cleanNameText', () => {
  it('schneidet Mana-Reste am Ende ab', () => {
    expect(cleanNameText('Sol Ring 1')).toBe('Sol Ring');
    expect(cleanNameText('Lightning Bolt ®')).toBe('Lightning Bolt');
    expect(cleanNameText('Llanowar Elves G')).toBe('Llanowar Elves');
  });

  it('lässt normale Namen in Ruhe', () => {
    expect(cleanNameText('Delver of Secrets')).toBe('Delver of Secrets');
    expect(cleanNameText('Ral, Leyline Prodigy')).toBe('Ral, Leyline Prodigy');
  });
});

describe('collectorText', () => {
  it('nimmt nur die Druckinfo unten links (nicht Stärke/Widerstand oder Copyright)', () => {
    const lines = [
      line('123/281 R', 0.05, 0.92),
      line('DMU • EN  Jane Doe', 0.05, 0.95),
      line('3/2', 0.82, 0.9),
      line('™ & © 2022 Wizards of the Coast', 0.55, 0.96),
      line('Flying', 0.08, 0.66),
    ];
    expect(collectorText(lines)).toBe('123/281 R DMU • EN  Jane Doe');
  });
});

describe('parseCollectorText', () => {
  it('Format 2020–2022: „123/281 R" + „DMU • EN"', () => {
    expect(parseCollectorText('123/281 R DMU • EN Jane Doe')).toEqual({ set: 'dmu', lang: 'en', number: '123' });
  });

  it('Format ab 2023: führende Nullen fallen weg', () => {
    expect(parseCollectorText('0045 C MOM • DE Max Muster')).toEqual({ set: 'mom', lang: 'de', number: '45' });
  });

  it('verträgt einen falsch gelesenen Trennpunkt', () => {
    expect(parseCollectorText('0201 U WOE - EN')).toMatchObject({ set: 'woe', number: '201' });
    expect(parseCollectorText('0201 U WOE EN')).toMatchObject({ set: 'woe', number: '201' });
  });

  it('Set-Codes mit Ziffern werden nicht als Nummer gelesen', () => {
    expect(parseCollectorText('M21 • EN 0150 R')).toEqual({ set: 'm21', lang: 'en', number: '150' });
  });

  it('nur Nummer (z. B. alte Karten oder Set bekannt)', () => {
    expect(parseCollectorText('0123 R')).toEqual({ number: '123' });
  });

  it('Buchstaben-Suffix bleibt erhalten', () => {
    expect(parseCollectorText('45a C DMU • EN')).toMatchObject({ number: '45a' });
  });

  it('null bei Unsinn', () => {
    expect(parseCollectorText('')).toBeNull();
    expect(parseCollectorText('Flying')).toBeNull();
  });
});
