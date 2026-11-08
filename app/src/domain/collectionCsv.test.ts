import { describe, it, expect } from 'vitest';
import { parseCollectionCsv, parseCsv, parseFinish, langCode, toMoxfieldCsv } from './collectionCsv';
import { CollectionImportError } from './collectionIo';

// Kopfzeile wie im ManaBox-Export („Export collection → CSV"); echte Datei als Fixture steht noch aus.
const MANABOX = [
  'Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency',
  'Lightning Bolt,2xm,Double Masters,117,normal,uncommon,4,101,E3285E6B-3E79-4D7C-BF96-D920F973B122,1.5,false,false,near_mint,en,EUR',
  '"Sheoldred, the Apocalypse",dmu,Dominaria United,107,foil,mythic,1,102,d67be074-cdd4-41d9-ac89-0a0456c4e4b2,80,false,false,near_mint,de,EUR',
  'Sol Ring,c21,Commander 2021,263,etched,uncommon,2,103,,3,false,false,near_mint,Japanese,EUR',
].join('\r\n');

describe('Sammlungs-CSV einlesen', () => {
  it('liest einen ManaBox-Export', () => {
    const r = parseCollectionCsv(MANABOX);
    expect(r.source).toBe('ManaBox');
    expect(r.skipped).toBe(0);
    expect(r.rows).toEqual([
      { name: 'Lightning Bolt', qty: 4, finish: 'nonfoil', scryfallId: 'e3285e6b-3e79-4d7c-bf96-d920f973b122', setCode: '2xm', collectorNumber: '117', lang: 'en', kind: 'collection' },
      { name: 'Sheoldred, the Apocalypse', qty: 1, finish: 'foil', scryfallId: 'd67be074-cdd4-41d9-ac89-0a0456c4e4b2', setCode: 'dmu', collectorNumber: '107', lang: 'de', kind: 'collection' },
      { name: 'Sol Ring', qty: 2, finish: 'etched', setCode: 'c21', collectorNumber: '263', lang: 'ja', kind: 'collection' },
    ]);
  });

  it('trennt ManaBox-Ordner von Decks und Listen', () => {
    const csv = [
      'Binder Name,Binder Type,Name,Set code,Collector number,Foil,Quantity,Scryfall ID',
      'Hauptordner,binder,Lightning Bolt,2xm,117,normal,1,a',
      'Krenko,deck,Goblin Guide,zen,126,normal,1,b',
      'Wunschliste,list,Ragavan,mh2,138,normal,1,c',
    ].join('\n');
    expect(parseCollectionCsv(csv).rows.map((r) => r.kind)).toEqual(['collection', 'deck', 'list']);
  });

  it('liest den eigenen Export und Moxfield wieder ein', () => {
    const own = toMoxfieldCsv([{ name: 'Fire // Ice', qty: 3, finish: 'foil', lang: 'de', setCode: 'mh2', collectorNumber: '290' }]);
    expect(parseCollectionCsv(own).rows).toEqual([
      { name: 'Fire // Ice', qty: 3, finish: 'foil', setCode: 'mh2', collectorNumber: '290', lang: 'de', kind: 'collection' },
    ]);
    const mox = '"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags"\n"2","0","Counterspell","mh2","Near Mint","English","",""\n';
    const r = parseCollectionCsv(mox);
    expect(r.source).toBe('Moxfield');
    expect(r.rows[0]).toMatchObject({ name: 'Counterspell', qty: 2, finish: 'nonfoil', setCode: 'mh2', lang: 'en' });
  });

  it('verträgt BOM, Semikolon (Excel) und Leerzeilen; überspringt Unlesbares', () => {
    const csv = '﻿sep=;\nAnzahl;Name;Foil\n2;Brainstorm;ja\n\n0;Island;\n;;\nx;Forest;\n';
    const r = parseCollectionCsv(csv);
    expect(r.rows).toEqual([{ name: 'Brainstorm', qty: 2, finish: 'foil', kind: 'collection' }]);
    expect(r.skipped).toBe(2); // Menge 0 und „x"; die leere Zeile zählt nicht
  });

  it('ohne Mengen-Spalte zählt jede Zeile einmal', () => {
    expect(parseCollectionCsv('Name\nSol Ring\nSol Ring\n').rows.map((r) => r.qty)).toEqual([1, 1]);
  });

  it('lehnt JSON und Dateien ohne Kartenspalte ab', () => {
    expect(() => parseCollectionCsv('{"schema":"scryglass-collection"}')).toThrow(CollectionImportError);
    expect(() => parseCollectionCsv('Datum,Betrag\n1.1.,5\n')).toThrow(/Keine Spalte/);
    expect(() => parseCollectionCsv('')).toThrow(/leer/);
  });
});

describe('CSV-Bausteine', () => {
  it('Anführungszeichen, "" und Umbrüche im Feld', () => {
    expect(parseCsv('a,"b, c","d ""e""","f\ng"\n1,2,3,4')).toEqual([
      ['a', 'b, c', 'd "e"', 'f\ng'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('Finish aus den Schreibweisen der Apps', () => {
    expect(['normal', '', 'false', 'nonfoil', 'Non-Foil'].map(parseFinish)).toEqual(Array(5).fill('nonfoil'));
    expect(['foil', 'Foil', 'true', 'yes', '1'].map(parseFinish)).toEqual(Array(5).fill('foil'));
    expect(['etched', 'Etched Foil'].map(parseFinish)).toEqual(['etched', 'etched']);
  });

  it('Sprachcodes', () => {
    expect([langCode('English'), langCode('Deutsch'), langCode('JA'), langCode('Klingonisch'), langCode('')])
      .toEqual(['en', 'de', 'ja', undefined, undefined]);
  });
});
