import { describe, it, expect } from 'vitest';
import { dayKey, valueTrend, type ValueSnapshot } from './valueHistory';

const s = (day: string, total: number): ValueSnapshot => ({ day, total, priced: 10, at: 0 });

describe('Wert-Verlauf', () => {
  it('Tag-Schlüssel in Ortszeit', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('Zeitraum, Woche und Monat', () => {
    const now = new Date(2026, 10, 13, 10);
    const hist = [s('2026-06-01', 50), s('2026-10-01', 80), s('2026-10-14', 90), s('2026-11-05', 100), s('2026-11-13', 110)];
    const t = valueTrend(hist, 90, now);
    expect(t.points.map((p) => p.day)).toEqual(['2026-10-01', '2026-10-14', '2026-11-05', '2026-11-13']);
    expect(t.week).toEqual({ abs: 10, rel: 0.1, since: '2026-11-05' });
    expect(t.month?.since).toBe('2026-10-14');
    expect(t.month?.abs).toBe(20);
    expect(valueTrend([s('2026-11-13', 5)], 90, now).week).toBeUndefined();
    expect(valueTrend([], 90, now)).toEqual({ points: [], week: undefined, month: undefined });
  });
});
