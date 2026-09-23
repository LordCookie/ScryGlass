import { describe, it, expect } from 'vitest';
import { pickNextSet, daysUntil, nextSetLabel, toSetInfos, setPickerOptions, type ScryfallSet } from './nextSet';

const SETS: ScryfallSet[] = [
  { code: 'old', name: 'Altes Set', set_type: 'expansion', released_at: '2025-01-01' },
  { code: 'fra', name: 'Reality Fracture', set_type: 'expansion', released_at: '2026-10-02' },
  { code: 'trk', name: 'Star Trek', set_type: 'expansion', released_at: '2026-11-13' },
  { code: 'tok', name: 'Tokens', set_type: 'token', released_at: '2026-09-25' },
  { code: 'cmd', name: 'Commander-Deck', set_type: 'commander', released_at: '2026-09-25' },
  { code: 'dig', name: 'Alchemy', set_type: 'expansion', released_at: '2026-09-25', digital: true },
];

describe('pickNextSet', () => {
  it('nimmt das nächste reguläre Premier-Set nach heute', () => {
    const next = pickNextSet(SETS, new Date('2026-09-19T12:00:00Z'));
    expect(next?.code).toBe('fra');
    expect(next?.name).toBe('Reality Fracture');
  });

  it('ignoriert Tokens, Commander-Decks und Digital-Sets', () => {
    // Diese liegen vor 'fra', dürfen aber nicht gewählt werden.
    const next = pickNextSet(SETS, new Date('2026-09-19T12:00:00Z'));
    expect(['tok', 'cmd', 'dig']).not.toContain(next?.code);
  });

  it('überspringt bereits erschienene Sets', () => {
    const next = pickNextSet(SETS, new Date('2026-10-15T12:00:00Z'));
    expect(next?.code).toBe('trk');
  });

  it('gibt null zurück, wenn nichts mehr aussteht', () => {
    expect(pickNextSet(SETS, new Date('2027-01-01T12:00:00Z'))).toBeNull();
  });
});

describe('daysUntil', () => {
  it('rundet auf volle Tage auf', () => {
    expect(daysUntil('2026-10-02', new Date('2026-09-19T12:00:00Z'))).toBe(13);
  });

  it('ist nie negativ', () => {
    expect(daysUntil('2026-01-01', new Date('2026-09-19T12:00:00Z'))).toBe(0);
  });
});

describe('nextSetLabel', () => {
  it('formatiert den Countdown (englisch)', () => {
    const set = { code: 'fra', name: 'Reality Fracture', releasedAt: '2026-10-02' };
    expect(nextSetLabel(set, new Date('2026-09-19T12:00:00Z'))).toBe('Next Set in 13 days');
  });

  it('nutzt Singular bei einem Tag', () => {
    const set = { code: 'fra', name: 'Reality Fracture', releasedAt: '2026-10-02' };
    expect(nextSetLabel(set, new Date('2026-10-01T00:00:00Z'))).toBe('Next Set in 1 day');
  });

  it('gibt null zurück ohne Set', () => {
    expect(nextSetLabel(null, new Date())).toBeNull();
  });
});

describe('Set-Liste (Scanner-Set-Modus)', () => {
  it('toSetInfos lässt Digital-Sets weg und normalisiert den Code', () => {
    const infos = toSetInfos(SETS);
    expect(infos.map((i) => i.code)).not.toContain('dig');
    expect(infos.find((i) => i.code === 'fra')).toEqual({ code: 'fra', name: 'Reality Fracture', releasedAt: '2026-10-02' });
  });

  it('setPickerOptions: nur Katalog-Sets, bekannte neueste zuerst, unbekannte als Kürzel', () => {
    const infos = toSetInfos(SETS);
    const opts = setPickerOptions(['old', 'trk', 'zzz', 'fra'], infos);
    expect(opts.map((o) => o.code)).toEqual(['trk', 'fra', 'old', 'zzz']);
    expect(opts[0].label).toBe('Star Trek (TRK)');
    expect(opts[3].label).toBe('ZZZ');
  });
});
