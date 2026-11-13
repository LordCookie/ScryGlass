/**
 * Wert-Verlauf der Sammlung (PLAN.md M22): höchstens ein Stand je Tag, gemerkt, wenn die
 * Statistik den Wert ausrechnet. Hier: Tag-Schlüssel, Zeitraum und Veränderung. Rein.
 */

export interface ValueSnapshot {
  /** lokaler Tag, „2026-11-13" */
  day: string;
  /** Gesamtwert in Euro */
  total: number;
  /** Karten (Stück) mit Preis */
  priced: number;
  at: number;
}

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface Change {
  abs: number;
  /** relativ, 0.05 = +5 % (null, wenn der alte Wert 0 war) */
  rel: number | null;
  since: string;
}

export interface ValueTrend {
  points: ValueSnapshot[];
  week?: Change;
  month?: Change;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Verlauf der letzten `days` Tage (älteste zuerst) und die Veränderung zu vor 7 bzw. 30 Tagen. */
export function valueTrend(history: readonly ValueSnapshot[], days = 90, now = new Date()): ValueTrend {
  const from = dayKey(new Date(now.getTime() - days * DAY_MS));
  const points = [...history].filter((h) => h.day >= from).sort((a, b) => a.day.localeCompare(b.day));
  const last = points[points.length - 1];
  const change = (back: number): Change | undefined => {
    if (!last) return undefined;
    const target = dayKey(new Date(new Date(`${last.day}T12:00:00`).getTime() - back * DAY_MS));
    const old = [...points].reverse().find((p) => p.day <= target);
    if (!old) return undefined;
    return { abs: last.total - old.total, rel: old.total ? (last.total - old.total) / old.total : null, since: old.day };
  };
  return { points, week: change(7), month: change(30) };
}
