import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { summarizeCollection } from '../domain/collectionStats';
import { TYPE_LABEL, type FilterRow } from '../domain/collectionFilter';
import { COLOR_KEYS, CURVE_BUCKETS, type ColorKey } from '../domain/deckStats';
import { collectionValue, fallbackPriceKey, formatEur, isStale, priceKey } from '../domain/prices';
import { getPrices, refreshCollectionPrices } from '../data/prices';
import { setProgressFor } from '../data/setProgress';
import { getSetList } from '../data/nextSet';
import type { SetProgress } from '../domain/setProgress';
import { addTokens, getTokenSummary } from '../data/tokens';

/**
 * Sammlungs-Statistik: Kennzahlen, Farben, Kartentypen, Manakurve und die häufigsten
 * Sets. Zeigt immer die aktuell gefilterte Auswahl (ohne Filter = ganze Sammlung).
 * Für Tokens (M14) nur das Passende: Kennzahlen je Artwork, Wert, Farben, Sets.
 */

const COLOR_BAR: Record<ColorKey, string> = {
  W: 'bg-mtg-w', U: 'bg-mtg-u', B: 'bg-mtg-b', R: 'bg-mtg-r', G: 'bg-mtg-g', C: 'bg-mtg-c',
};
const COLOR_NAME: Record<ColorKey, string> = {
  W: 'Weiß', U: 'Blau', B: 'Schwarz', R: 'Rot', G: 'Grün', C: 'Farblos',
};
const nf = new Intl.NumberFormat('de-DE');

export function CollectionStats({ rows, tokens = false }: { rows: readonly FilterRow[]; tokens?: boolean }) {
  const s = useMemo(() => summarizeCollection(rows), [rows]);
  const artworks = useMemo(() => new Set(rows.map((r) => r.owned.printingId ?? r.owned.oracleId)).size, [rows]);

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
        {(tokens
          ? [
              { label: 'TOKENS', value: s.total },
              { label: 'VERSCH.', value: s.distinct },
              { label: 'ARTWORKS', value: artworks },
              { label: 'FOIL', value: s.foil },
            ]
          : [
              { label: 'KARTEN', value: s.total },
              { label: 'VERSCH.', value: s.distinct },
              { label: 'FOIL', value: s.foil },
              { label: 'LÄNDER', value: s.stats.lands },
            ]
        ).map((k) => (
          <div key={k.label} className="frame bg-surface px-2 py-2 text-center">
            <div className="font-hud text-[11px] text-text">{nf.format(k.value)}</div>
            <div className="mt-1 font-hud text-[7px] text-muted">{k.label}</div>
          </div>
        ))}
      </div>

      <ValueSection rows={rows} unit={tokens ? 'Tokens' : 'Karten'} />

      <TokenSection />

      <Section title="FARBEN" note="ohne Länder">
        {COLOR_KEYS.map((c) => (
          <Bar key={c} label={COLOR_NAME[c]} value={s.stats.colors[c]} max={maxColor} barClass={COLOR_BAR[c]} />
        ))}
      </Section>

      {!tokens && (
        <>
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

          <SetProgressSection rows={rows} />
        </>
      )}

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

/** Spielsteine (Tokens) der ganzen Sammlung: je Artwork erfasst + ohne Artwork gezählt (M14). */
function TokenSection() {
  // Live (Dexie beobachtet owned + meta), damit Scanner-Zählungen sofort erscheinen.
  const t = useLiveQuery(() => getTokenSummary(), []);
  const n = t?.withoutArt ?? 0;
  return (
    <Section title="TOKENS" note="Spielsteine, ganze Sammlung">
      <div className="flex items-center gap-2">
        <span className="font-hud text-[14px] text-text">{nf.format(t?.withArt ?? 0)}</span>
        <span className="flex-1 text-muted">mit Artwork ({nf.format(t?.artworks ?? 0)} verschiedene) · unter Sammlung → Tokens</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-hud text-[14px] text-text">{nf.format(n)}</span>
        <span className="flex-1 text-muted">ohne Artwork gezählt</span>
        <button onClick={() => void addTokens(-1)} disabled={n === 0} aria-label="Ein Token weniger"
          className="bg-bg px-3 py-1 text-paper disabled:text-muted">−</button>
        <button onClick={() => void addTokens(1)} aria-label="Ein Token mehr" className="bg-bg px-3 py-1 text-paper">+</button>
      </div>
    </Section>
  );
}

const SET_PREVIEW = 10;

/** Set-Fortschritt: verschiedene Karten je Set, egal welche Ausgabe (domain/setProgress). */
function SetProgressSection({ rows }: { rows: readonly FilterRow[] }) {
  const ids = useMemo(() => [...new Set(rows.map((r) => r.owned.oracleId))], [rows]);
  const sig = ids.join(',');
  const [progress, setProgress] = useState<SetProgress[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    setProgress(null);
    void setProgressFor(ids).then((p) => {
      if (alive) setProgress(p);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useEffect(() => {
    void getSetList().then((l) => setNames(new Map(l.map((x) => [x.code, x.name]))));
  }, []);

  const shown = progress ? (showAll ? progress : progress.slice(0, SET_PREVIEW)) : [];
  return (
    <Section title="SET-FORTSCHRITT" note="verschiedene Karten je Set, egal welche Ausgabe">
      {progress === null ? (
        <p className="text-muted">Wird berechnet…</p>
      ) : progress.length === 0 ? (
        <p className="text-muted">Noch keine Sets.</p>
      ) : (
        <>
          {shown.map((p) => (
            <div key={p.set} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-muted" title={names.get(p.set) ?? p.set.toUpperCase()}>
                {names.get(p.set) ?? p.set.toUpperCase()}
              </span>
              <div className="h-3 flex-1 bg-bg">
                <div className={`h-3 ${p.have === p.total ? 'bg-ok' : 'bg-fill'}`} style={{ width: `${Math.max(2, p.ratio * 100)}%` }} />
              </div>
              <span className="w-20 shrink-0 text-right text-text">{nf.format(p.have)} / {nf.format(p.total)}</span>
            </div>
          ))}
          {progress.length > SET_PREVIEW && (
            <button onClick={() => setShowAll((v) => !v)} className="mt-1 w-full bg-bg px-2 py-1 text-muted hover:text-text">
              {showAll ? 'Weniger zeigen' : `Alle ${nf.format(progress.length)} Sets zeigen`}
            </button>
          )}
        </>
      )}
    </Section>
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

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Sammlungswert (Cardmarket-Euro via Scryfall) der gefilterten Auswahl. Fehlen Preise
 * oder sind sie älter als 24 h, werden sie beim Öffnen einmal automatisch geholt
 * (nur online); offline gilt der letzte Stand.
 */
function ValueSection({ rows, unit }: { rows: readonly FilterRow[]; unit: string }) {
  const valueRows = useMemo(
    () => rows.map((r) => ({
      key: priceKey(r.owned), fallbackKey: fallbackPriceKey(r.owned), finish: r.owned.finish, qty: r.owned.qty, name: r.card.name,
    })),
    [rows],
  );
  const keys = useMemo(() => valueRows.flatMap((v) => (v.fallbackKey ? [v.key, v.fallbackKey] : [v.key])), [valueRows]);
  const prices = useLiveQuery(() => getPrices(keys), [keys]);
  const value = useMemo(() => collectionValue(valueRows, prices ?? new Map()), [valueRows, prices]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);

  async function refresh() {
    setError(null);
    setProgress({ done: 0, total: 1 });
    try {
      await refreshCollectionPrices((done, total) => setProgress({ done, total }));
    } catch {
      setError(navigator.onLine ? 'Scryfall gerade nicht erreichbar — später nochmal.' : 'Offline — es gilt der letzte Stand.');
    } finally {
      setProgress(null);
    }
  }

  // Einmal pro Öffnen automatisch aktualisieren, wenn Preise fehlen oder veraltet sind.
  useEffect(() => {
    if (!prices || autoTried.current || !navigator.onLine || valueRows.length === 0) return;
    const missing = valueRows.some((v) => !prices.has(v.key));
    if (missing || isStale(value.oldestAt, Date.now())) {
      autoTried.current = true;
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices]);

  return (
    <Section title="WERT" note="Cardmarket-Preise via Scryfall">
      <div className="flex items-end justify-between gap-2">
        <div className="font-hud text-[16px] text-paper">{formatEur(value.total)}</div>
        <button onClick={() => void refresh()} disabled={!!progress}
          className="shrink-0 bg-fill/20 px-2 py-1 text-xs text-accent hover:bg-fill/40 disabled:opacity-50">
          {progress ? `Lade ${progress.done}/${progress.total}…` : 'Preise aktualisieren'}
        </button>
      </div>
      <p className="text-[10px] text-muted">
        {nf.format(value.pricedQty)} {unit} mit Preis
        {value.unpricedQty > 0 ? ` · ${nf.format(value.unpricedQty)} ohne` : ''}
        {value.oldestAt ? ` · Stand ${dateFmt.format(value.oldestAt)}` : ''}
      </p>
      {error && <p className="text-[10px] text-warn">{error}</p>}
      {value.top.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {value.top.map((t, i) => (
            // Index im Schlüssel: Token-Artworks teilen sich Name und Ausführung.
            <li key={`${t.name}-${t.finish}-${i}`} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate text-muted">
                {t.name}{t.finish !== 'nonfoil' ? ' ✦' : ''}
              </span>
              <span className="shrink-0 text-muted">{t.qty}× {formatEur(t.unit)}</span>
              <span className="w-16 shrink-0 text-right text-text">{formatEur(t.sum)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
