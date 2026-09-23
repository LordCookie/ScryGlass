import { useMemo } from 'react';
import { summarizeCollection } from '../domain/collectionStats';
import { TYPE_LABEL, type FilterRow } from '../domain/collectionFilter';
import { COLOR_KEYS, CURVE_BUCKETS, type ColorKey } from '../domain/deckStats';

/**
 * Sammlungs-Statistik: Kennzahlen, Farben, Kartentypen, Manakurve und die häufigsten
 * Sets. Zeigt immer die aktuell gefilterte Auswahl (ohne Filter = ganze Sammlung).
 */

const COLOR_BAR: Record<ColorKey, string> = {
  W: 'bg-mtg-w', U: 'bg-mtg-u', B: 'bg-mtg-b', R: 'bg-mtg-r', G: 'bg-mtg-g', C: 'bg-mtg-c',
};
const COLOR_NAME: Record<ColorKey, string> = {
  W: 'Weiß', U: 'Blau', B: 'Schwarz', R: 'Rot', G: 'Grün', C: 'Farblos',
};
const nf = new Intl.NumberFormat('de-DE');

export function CollectionStats({ rows }: { rows: readonly FilterRow[] }) {
  const s = useMemo(() => summarizeCollection(rows), [rows]);

  if (s.total === 0) {
    return <p className="px-1 font-mono text-sm text-muted">Keine Karten für die Statistik.</p>;
  }

  const maxColor = Math.max(1, ...COLOR_KEYS.map((c) => s.stats.colors[c]));
  const types = Object.entries(s.stats.types).sort((a, b) => b[1] - a[1]);
  const maxType = Math.max(1, ...types.map(([, n]) => n));
  const maxCurve = Math.max(1, ...s.stats.manaCurve);
  const maxSet = Math.max(1, ...s.sets.map((x) => x.qty));

  return (
    <div className="space-y-3 font-mono text-xs">
      {/* Kennzahlen */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'KARTEN', value: s.total },
          { label: 'VERSCH.', value: s.distinct },
          { label: 'FOIL', value: s.foil },
          { label: 'LÄNDER', value: s.stats.lands },
        ].map((k) => (
          <div key={k.label} className="frame bg-surface px-2 py-2 text-center">
            <div className="font-hud text-[11px] text-text">{nf.format(k.value)}</div>
            <div className="mt-1 font-hud text-[7px] text-muted">{k.label}</div>
          </div>
        ))}
      </div>

      <Section title="FARBEN" note="ohne Länder">
        {COLOR_KEYS.map((c) => (
          <Bar key={c} label={COLOR_NAME[c]} value={s.stats.colors[c]} max={maxColor} barClass={COLOR_BAR[c]} />
        ))}
      </Section>

      <Section title="KARTENTYPEN">
        {types.map(([t, n]) => (
          <Bar key={t} label={TYPE_LABEL[t] ?? t} value={n} max={maxType} />
        ))}
      </Section>

      <Section title="MANAKURVE" note="ohne Länder">
        <div className="flex items-end gap-1" style={{ height: 96 }}>
          {Array.from({ length: CURVE_BUCKETS }, (_, i) => (
            <div key={i} className="flex flex-1 flex-col items-center justify-end">
              <span className="text-[10px] text-muted">{s.stats.manaCurve[i] || ''}</span>
              <div className="w-full bg-fill" style={{ height: `${(s.stats.manaCurve[i] / maxCurve) * 64}px` }} />
              <span className="mt-1 font-hud text-[8px] text-muted">{i === CURVE_BUCKETS - 1 ? '7+' : i}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="SETS" note={`${nf.format(s.knownSetQty)} von ${nf.format(s.total)} mit bekannter Ausgabe`}>
        {s.sets.length === 0 ? (
          <p className="text-muted">Noch keine — das Set kennt die App, sobald im Kartendetail ein Artwork gewählt ist.</p>
        ) : (
          s.sets.map((x) => <Bar key={x.set} label={x.set.toUpperCase()} value={x.qty} max={maxSet} />)
        )}
      </Section>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-surface p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-hud text-[10px] text-text">{title}</h3>
        {note && <span className="text-right text-[10px] text-muted">{note}</span>}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Bar({ label, value, max, barClass = 'bg-fill' }: { label: string; value: number; max: number; barClass?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-muted">{label}</span>
      <div className="h-3 flex-1 bg-bg">
        <div className={`h-3 ${barClass}`} style={{ width: `${(value / max) * 100}%` }} />
      </div>
      <span className="w-10 text-right text-text">{nf.format(value)}</span>
    </div>
  );
}
