import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { searchCatalog, type CatalogResult } from '../data/search';
import { ownedByOracle, previewImageIds } from '../data/cards';
import { EMPTY_CARD_FILTER, hasCardFilter, type CardFilter } from '../domain/cardFilter';
import { TYPE_FILTERS } from '../domain/collectionFilter';
import { LEGALITY_FORMATS, FORMAT_LABELS, type FormatId } from '../domain/types';
import { CardImage } from './CardImage';
import { CardDetail } from './CardDetail';

/**
 * Kartensuche über den ganzen Katalog (eigener Tab): Name, Typ oder Regeltext (DE/EN)
 * plus Filter nach Farbe, Kartentyp, Manawert, Format und „nur im Bestand". Nur mit
 * Filtern lässt sich auch stöbern. Tippen öffnet das Kartendetail — dort geht's per +
 * direkt in die Sammlung.
 */

const PAGE = 60;
const COLORS: { key: string; label: string }[] = [
  { key: 'W', label: 'W' }, { key: 'U', label: 'U' }, { key: 'B', label: 'B' },
  { key: 'R', label: 'R' }, { key: 'G', label: 'G' }, { key: 'C', label: 'farblos' },
];
const CMC_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7];
const nf = new Intl.NumberFormat('de-DE');

export function SearchPanel() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState<CardFilter>(EMPTY_CARD_FILTER);
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<CatalogResult | null>(null);
  const [imgs, setImgs] = useState<Map<string, string>>(new Map());
  const [detailId, setDetailId] = useState<string | null>(null);
  const owned = useLiveQuery(() => ownedByOracle(), []);
  const patch = (p: Partial<CardFilter>) => setFilter((f) => ({ ...f, ...p }));

  // Tippen entprellen, damit nicht bei jedem Buchstaben 34.000 Karten durchsucht werden.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query), 200);
    return () => window.clearTimeout(t);
  }, [query]);
  useEffect(() => setLimit(PAGE), [debounced, filter, ownedOnly]);

  const active = !!debounced.trim() || hasCardFilter(filter) || ownedOnly;
  useEffect(() => {
    if (!active) {
      setResult(null);
      return;
    }
    let alive = true;
    const only = ownedOnly ? new Set(owned?.keys() ?? []) : undefined;
    void searchCatalog(debounced, filter, limit, only).then(async (r) => {
      if (!alive) return;
      setResult(r);
      const ids = await previewImageIds(r.cards.map((c) => c.oracleId));
      if (alive) setImgs(ids);
    });
    return () => {
      alive = false;
    };
    // `owned` nur relevant, wenn „nur im Bestand" aktiv ist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, filter, limit, ownedOnly, ownedOnly ? owned : null]);

  const extra = [filter.type, filter.cmc, filter.format].filter((v) => v != null).length;

  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-surface p-4">
        <h2 className="mb-2 font-hud text-sm text-text">SUCHE</h2>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name, Typ oder Regeltext (DE/EN)…"
          className="mb-2 w-full border-2 border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-paper"
        />
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <div className="flex gap-1">
            {COLORS.map((c) => (
              <button key={c.key} onClick={() => patch({ color: filter.color === c.key ? null : c.key })}
                className={`px-2 py-1 ${filter.color === c.key ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
                {c.label}
              </button>
            ))}
          </div>
          <button onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}
            className={`px-2 py-1 ${extra > 0 ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
            Filter{extra > 0 ? ` (${extra})` : ''} {showFilters ? '▴' : '▾'}
          </button>
          <label className="ml-auto flex items-center gap-1 text-muted">
            <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} />
            nur im Bestand
          </label>
        </div>

        {showFilters && (
          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs">
            <label className="flex flex-col gap-1 text-muted">
              Kartentyp
              <select value={filter.type ?? ''} onChange={(e) => patch({ type: e.target.value || null })}
                className="border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper">
                <option value="">Alle</option>
                {TYPE_FILTERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-muted">
              Manawert
              <select value={filter.cmc ?? ''} onChange={(e) => patch({ cmc: e.target.value === '' ? null : Number(e.target.value) })}
                className="border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper">
                <option value="">Alle</option>
                {CMC_OPTIONS.map((n) => <option key={n} value={n}>{n === 7 ? '7+' : n}</option>)}
              </select>
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-muted">
              Legal in Format
              <select value={filter.format ?? ''} onChange={(e) => patch({ format: (e.target.value || null) as FormatId | null })}
                className="border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper">
                <option value="">Alle Formate</option>
                {LEGALITY_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
              </select>
            </label>
            {extra > 0 && (
              <button onClick={() => patch({ type: null, cmc: null, format: null })}
                className="col-span-2 bg-bg px-2 py-1 text-muted hover:text-text">
                Filter zurücksetzen
              </button>
            )}
          </div>
        )}
      </div>

      {!active ? (
        <p className="px-1 font-mono text-sm text-muted">
          Suche nach Name, Typ oder Regeltext — oder stöbere nur mit den Filtern (z. B. Format + Farbe).
        </p>
      ) : result === null ? (
        <p className="px-1 font-mono text-sm text-muted">Suche…</p>
      ) : result.total === 0 ? (
        <p className="px-1 font-mono text-sm text-muted">Keine Treffer.</p>
      ) : (
        <>
          <p className="px-1 font-mono text-xs text-muted">{nf.format(result.total)} Treffer</p>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {result.cards.map((c) => {
              const have = owned?.get(c.oracleId) ?? 0;
              return (
                <li key={c.oracleId}>
                  <button onClick={() => setDetailId(c.oracleId)} className="relative block w-full" title={c.name}>
                    <CardImage scryfallId={imgs.get(c.oracleId)} name={c.name} size="normal" className="aspect-[5/7] h-auto w-full" />
                    {have > 0 && (
                      <span className="absolute right-0 top-0 bg-titlebar px-1.5 py-0.5 font-hud text-[10px] text-paper">{have}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {result.total > result.cards.length && (
            <button onClick={() => setLimit((l) => l + PAGE)}
              className="w-full bg-surface px-3 py-2 font-mono text-sm text-accent hover:bg-elevated">
              Mehr anzeigen ({nf.format(result.total - result.cards.length)} weitere)
            </button>
          )}
        </>
      )}

      {detailId && <CardDetail oracleId={detailId} onClose={() => setDetailId(null)} />}
    </section>
  );
}
