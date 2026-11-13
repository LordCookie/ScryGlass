import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { formatEur } from '../domain/prices';
import { valueTrend, type Change } from '../domain/valueHistory';

/**
 * Wert-Verlauf der Sammlung (PLAN.md M22): Pixel-Balken je gemerktem Tag, die letzten 90
 * Tage, dazu die Veränderung zu vor einer Woche und einem Monat. Im breiten Layout höher.
 */
const dayFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const pct = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

function ChangeLabel({ label, c }: { label: string; c?: Change }) {
  if (!c) return null;
  const up = c.abs >= 0;
  return (
    <span>
      {label}: <span className={up ? 'text-ok' : 'text-danger'}>{up ? '+' : ''}{formatEur(c.abs)}</span>
      {c.rel != null && <span className="text-muted"> ({up ? '+' : ''}{pct.format(c.rel * 100)} %)</span>}
    </span>
  );
}

export function ValueChart() {
  const history = useLiveQuery(() => db.valueHistory.toArray(), []);
  const trend = useMemo(() => valueTrend(history ?? []), [history]);
  if (!history) return null;
  const pts = trend.points;
  if (pts.length < 2) {
    return (
      <p className="mt-2 text-[10px] text-muted">
        Wert-Verlauf: Der Wert wird einmal am Tag gemerkt, wenn du die Statistik öffnest — ab dem zweiten Tag siehst du hier den Verlauf.
      </p>
    );
  }
  const max = Math.max(...pts.map((p) => p.total));
  const min = Math.min(...pts.map((p) => p.total));
  // Unten etwas Luft lassen, damit kleine Schwankungen sichtbar bleiben.
  const floor = Math.max(0, min - (max - min) * 0.5);
  const h = (v: number) => (max === floor ? 100 : 12 + ((v - floor) / (max - floor)) * 88);
  return (
    <div className="mt-3">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 text-[10px]">
        <span className="font-hud text-[9px] text-muted">VERLAUF ({pts.length} TAGE)</span>
        <ChangeLabel label="Woche" c={trend.week} />
        <ChangeLabel label="Monat" c={trend.month} />
      </div>
      <div className="flex h-20 items-end gap-px bg-bg p-1 lg:h-36">
        {pts.map((p) => (
          <div key={p.day} title={`${dayFmt.format(new Date(`${p.day}T12:00:00`))}: ${formatEur(p.total)}`}
            className="min-w-[2px] flex-1 bg-accent hover:bg-paper" style={{ height: `${h(p.total)}%` }} />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-muted">
        <span>{dayFmt.format(new Date(`${pts[0].day}T12:00:00`))}</span>
        <span>{dayFmt.format(new Date(`${pts[pts.length - 1].day}T12:00:00`))}</span>
      </div>
    </div>
  );
}
