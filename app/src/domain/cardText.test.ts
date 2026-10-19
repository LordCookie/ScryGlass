import { describe, it, expect } from 'vitest';
import { pickNameLine, cleanNameText, collectorText, parseCollectorText, looksLikeToken, textLooksLikeToken, type TextLine } from './cardText';

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

describe('looksLikeToken / textLooksLikeToken', () => {
  it('erkennt Spielsteine an der Typzeile (EN/DE) und Embleme', () => {
    expect(looksLikeToken([line('MOUSE', 0.05, 0.05), line('Token Creature — Mouse', 0.05, 0.72)])).toBe(true);
    expect(looksLikeToken([line('Token Artifact - Treasure', 0.05, 0.7)])).toBe(true);
    expect(looksLikeToken([line('Token Legendary Creature — Blaster', 0.05, 0.7)])).toBe(true);
    expect(looksLikeToken([line('Spielstein-Kreatur — Maus', 0.05, 0.7)])).toBe(true);
    expect(looksLikeToken([line('Kreaturenspielstein — Goblin', 0.05, 0.7)])).toBe(true);
    expect(looksLikeToken([line('Emblem — Chandra', 0.05, 0.6)])).toBe(true);
  });

  it('erkennt neue Tokens an der Seltenheit „T" in der Druckinfo', () => {
    expect(looksLikeToken([line('T 0004', 0.05, 0.9), line('WOE • EN Kisung Koh', 0.05, 0.93)])).toBe(true);
    expect(looksLikeToken([line('T0012', 0.05, 0.9)])).toBe(true);
  });

  it('echte Karten mit „token" im Regeltext zählen NICHT', () => {
    expect(looksLikeToken([
      line('Mouse Trapper', 0.05, 0.05),
      line('Creature — Mouse Soldier', 0.05, 0.56),
      line('create a 1/1 white Mouse creature token', 0.05, 0.66),
      line('Token creatures you control get +1/+1 and have', 0.05, 0.7),
      line('token creature you control dies, draw a card and gain life', 0.05, 0.74),
      line('U 0254', 0.05, 0.9),
      line('WOE • EN Artist', 0.05, 0.93),
    ])).toBe(false);
    expect(looksLikeToken([
      line('erzeuge einen 1/1 weißen Maus-Kreaturenspielstein.', 0.05, 0.66),
      line('Kreaturenspielstein. Immer wenn eine Kreatur stirbt', 0.05, 0.7),
      line('0123 R', 0.05, 0.9),
    ])).toBe(false);
  });

  it('Fließtext (Browser-Kamera)', () => {
    expect(textLooksLikeToken('Mouse Token Creature — Mouse 1/1 T 0004 WOE • EN')).toBe(true);
    expect(textLooksLikeToken('Spielstein-Kreatur - Maus')).toBe(true);
    expect(textLooksLikeToken('Mouse Trapper Creature — Mouse Soldier Flash create a creature token U 0254')).toBe(false);
  });
});
