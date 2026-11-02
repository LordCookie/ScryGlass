import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  foldOcr,
  trigramsOf,
  levenshtein,
  fuzzySubstringDistance,
  NameIndex,
  topTrigramCandidates,
  matchName,
} from './nameMatch';
import type { NameEntry } from './types';
import ocrSamples from './__tests__/fixtures/ocr-samples.json';

// --- Mini-Katalog (oracleId, EN-Name, DE-Name) ------------------------------
// Deckt die Fixtures ab. Realer Katalog: 30k+ Karten (PLAN.md E3).
const CATALOG: { oracleId: string; en: string; de: string }[] = [
  { oracleId: 'o-bolt', en: 'Lightning Bolt', de: 'Blitzschlag' },
  { oracleId: 'o-serra', en: 'Serra Angel', de: 'Serra Engel' },
  { oracleId: 'o-llanowar', en: 'Llanowar Elves', de: 'Llanowar-Elfen' },
  { oracleId: 'o-counter', en: 'Counterspell', de: 'Gegenzauber' },
  { oracleId: 'o-birds', en: 'Birds of Paradise', de: 'Paradiesvogel' },
  { oracleId: 'o-sol', en: 'Sol Ring', de: 'Sol Ring' },
  { oracleId: 'o-swords', en: 'Swords to Plowshares', de: 'Schwerter zu Pflugscharen' },
  { oracleId: 'o-forest', en: 'Forest', de: 'Wald' },
  { oracleId: 'o-serrafire', en: 'Serra Avenger', de: 'Serra-Rächerin' },
];

function buildFixtures(): {
  names: NameEntry[];
  index: NameIndex;
  postings: Map<string, string[]>;
  enNormToOracle: Map<string, string>;
} {
  const names: NameEntry[] = [];
  const enNormToOracle = new Map<string, string>();
  for (const c of CATALOG) {
    names.push({ normName: normalizeName(c.en), oracleId: c.oracleId, lang: 'en' });
    names.push({ normName: normalizeName(c.de), oracleId: c.oracleId, lang: 'de' });
    enNormToOracle.set(normalizeName(c.en), c.oracleId);
  }
  // Trigramm-Postings wie in der Pipeline: trigram -> oracleIds.
  const postings = new Map<string, string[]>();
  for (const n of names) {
    for (const tri of new Set(trigramsOf(n.normName))) {
      const list = postings.get(tri) ?? [];
      if (!list.includes(n.oracleId)) list.push(n.oracleId);
      postings.set(tri, list);
    }
  }
  return { names, index: new NameIndex(names), postings, enNormToOracle };
}

describe('normalizeName (muss zur Pipeline passen)', () => {
  it('normalisiert Standardnamen', () => {
    expect(normalizeName('Lightning Bolt')).toBe('lightning bolt');
    expect(normalizeName("Lim-Dûl's Vault")).toBe('limduls vault');
    expect(normalizeName('Æther Vial')).toBe('aether vial');
    expect(normalizeName('Fire // Ice')).toBe('fire ice');
    expect(normalizeName('  Serra   Angel ')).toBe('serra angel');
  });
});

describe('foldOcr', () => {
  it('faltet Ziffer-/Buchstaben-Verwechsler', () => {
    expect(foldOcr('s0l ring')).toBe('sol ring'); // 0->o
    expect(foldOcr('b1itz')).toBe('biitz'); // 1->i
    expect(foldOcr('8ob')).toBe('bob'); // 8->b
  });
});

describe('Distanzen', () => {
  it('levenshtein', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('bolt', 'bolt')).toBe(0);
  });
  it('fuzzySubstringDistance findet Muster im Rauschen', () => {
    expect(fuzzySubstringDistance('bolt', 'xx bolt yy')).toBe(0);
    expect(fuzzySubstringDistance('bolt', 'boit')).toBe(1);
  });
});

describe('NameIndex exakt + praefix', () => {
  const { index } = buildFixtures();
  it('exakter EN- und DE-Treffer zeigt auf dieselbe oracleId', () => {
    expect(index.lookupExact('lightning bolt')[0].oracleId).toBe('o-bolt');
    expect(index.lookupExact('blitzschlag')[0].oracleId).toBe('o-bolt');
  });
  it('praefix findet abgeschnittene Namen', () => {
    const p = index.lookupPrefix('serra ang');
    expect(p.some((c) => c.oracleId === 'o-serra')).toBe(true);
  });
  it('zu kurzer praefix matcht nicht (verhindert Massentreffer)', () => {
    expect(index.lookupPrefix('se')).toEqual([]);
  });
});

describe('topTrigramCandidates', () => {
  const { postings } = buildFixtures();
  it('liefert die richtige Karte als Top-Kandidat', () => {
    const cands = topTrigramCandidates(normalizeName('Blitzschiag'), postings, 20);
    expect(cands).toContain('o-bolt');
  });
});

describe('NameIndex.trigramPostings (statt Katalog-Tabelle, 0.2.7)', () => {
  const { index, postings } = buildFixtures();
  const asSets = (m: ReadonlyMap<string, readonly string[]>) =>
    new Map([...m].map(([t, ids]) => [t, [...ids].sort()]));

  it('entspricht den Postings der Pipeline-Logik', () => {
    expect(asSets(index.trigramPostings())).toEqual(asSets(postings));
  });

  it('jede oracleId höchstens einmal je Trigramm (DE + EN zusammen)', () => {
    // „Sol Ring" heißt auf Deutsch gleich → trotzdem nur ein Eintrag.
    expect(index.trigramPostings().get('sol')).toEqual(['o-sol']);
    for (const ids of index.trigramPostings().values()) expect(new Set(ids).size).toBe(ids.length);
  });

  it('wird nur einmal gebaut', () => {
    expect(index.trigramPostings()).toBe(index.trigramPostings());
  });
});

describe('matchName gestaffelt (§ 5)', () => {
  const { index, postings } = buildFixtures();

  it('Exakt schlaegt alles', () => {
    const r = matchName('Lightning Bolt', index, postings);
    expect(r.best?.method).toBe('exact');
    expect(r.best?.oracleId).toBe('o-bolt');
  });

  it('Praefix bei abgeschnittenem OCR', () => {
    const r = matchName('Llanowar Elv', index, postings);
    expect(r.best?.oracleId).toBe('o-llanowar');
    expect(r.best?.method).toBe('prefix');
  });

  it('Fuzzy bei Verlesern', () => {
    const r = matchName('Blitzschiag', index, postings);
    expect(r.best?.oracleId).toBe('o-bolt');
    expect(r.best?.method).toBe('fuzzy');
  });

  it('kein Treffer -> best undefined (manuelle Eingabe)', () => {
    const r = matchName('qwertzuiop', index, postings);
    expect(r.best).toBeUndefined();
  });
});

// --- Der zentrale Test: echte-artige OCR-Fixtures (PLAN.md § 5) --------------
describe('OCR-Fixtures', () => {
  const { index, enNormToOracle } = buildFixtures();
  for (const sample of ocrSamples as { raw: string; expect: string | null; note: string }[]) {
    it(`"${sample.raw}" -> ${sample.expect ?? 'kein Treffer'} (${sample.note})`, () => {
      // Wie in der App (data/matcher.ts): Postings aus dem Index selbst.
      const r = matchName(sample.raw, index, index.trigramPostings());
      if (sample.expect === null) {
        expect(r.best).toBeUndefined();
      } else {
        const wantOracle = enNormToOracle.get(sample.expect);
        expect(r.best?.oracleId).toBe(wantOracle);
      }
    });
  }
});
