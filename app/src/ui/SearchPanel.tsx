import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { searchCatalog, catalogSubtypes, type CatalogResult } from '../data/search';
import { ownedByOracle, previewImageIds } from '../data/cards';
import { EMPTY_CARD_FILTER, hasCardFilter, toggleColor, type CardFilter, type ColorMode } from '../domain/cardFilter';
import { TYPE_FILTERS } from '../domain/collectionFilter';
import { LEGALITY_FORMATS, FORMAT_LABELS, type FormatId } from '../domain/types';
import { CardImage } from './CardImage';
import { CardDetail } from './CardDetail';
import { PixelCheckbox } from './PixelCheckbox';
import { ComboSearch } from './ComboSearch';
import { comboRequested, clearComboRequest } from './comboNav';

/**
 * Kartensuche über den ganzen Katalog (eigener Tab): Name, Typ oder Regeltext (DE/EN)
 * plus Filter — mehrere Farben (enthält/genau/höchstens), Kartentyp, Manawert, Format,
 * Regeltext, Typzeile/Kreaturentyp und „nur im Bestand". Nur mit Filtern lässt sich
 * auch stöbern. Tippen öffnet das Kartendetail — dort geht's per + in die Sammlung.
 */

const PAGE = 60;
const COLORS: { key: string; label: string; pip: string }[] = [
  { key: 'W', label: 'W', pip: 'bg-mtg-w' },
  { key: 'U', label: 'U', pip: 'bg-mtg-u' },
  { key: 'B', label: 'B', pip: 'bg-mtg-b' },
  { key: 'R', label: 'R', pip: 'bg-mtg-r' },
  { key: 'G', label: 'G', pip: 'bg-mtg-g' },
  { key: 'C', label: 'farblos', pip: 'bg-mtg-c' },
];
const COLOR_MODES: { key: ColorMode; label: string; hint: string }[] = [
  { key: 'include', label: 'enthält', hint: 'Karten mit allen gewählten Farben (weitere erlaubt)' },
  { key: 'exact', label: 'genau', hint: 'Karten mit genau diesen Farben' },
  { key: 'within', label: 'höchstens', hint: 'passt in ein Deck dieser Farben (inkl. farblos)' },
];
const CMC_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7];
const nf = new Intl.NumberFormat('de-DE');
const inputCls = 'w-full border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper';

export function SearchPanel() {
  // „Kombos" ist ein Zusatz (M17): eine schlichte Zeile unter dem Suchfeld. Die Σ-Statistik
  // kann direkt hierher springen (ui/comboNav).
  const [mode, setMode] = useState<'karten' | 'kombos'>(() => (comboRequested() ? 'kombos' : 'karten'));
  useEffect(() => clearComboRequest(), []);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CardFilter>(EMPTY_CARD_FILTER);
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [sort, setSort] = useState<'treffer' | 'beliebtheit'>('treffer');
  const [showFilters, setShowFilters] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<CatalogResult | null>(null);
  const [imgs, setImgs] = useState<Map<string, string>>(new Map());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [subtypes, setSubtypes] = useState<string[]>([]);
  const owned = useLiveQuery(() => ownedByOracle(), []);
  const patch = (p: Partial<CardFilter>) => setFilter((f) => ({ ...f, ...p }));

  useEffect(() => setLimit(PAGE), [query, filter, ownedOnly]);
  // Untertyp-Vorschläge erst laden, wenn die Filter aufgeklappt werden.
  useEffect(() => {
    if (showFilters && subtypes.length === 0) void catalogSubtypes().then(setSubtypes);
  }, [showFilters, subtypes.length]);

  const active = mode === 'karten' && (!!query.trim() || hasCardFilter(filter) || ownedOnly);
  useEffect(() => {
    if (!active) {
      setResult(null);
      return;
    }
    let alive = true;
    // Tippen entprellen, damit nicht bei jedem Buchstaben 34.000 Karten durchsucht werden.
    const t = window.setTimeout(() => {
      const only = ownedOnly ? new Set(owned?.keys() ?? []) : undefined;
      void searchCatalog(query, filter, limit, only, sort).then(async (r) => {
        if (!alive) return;
        setResult(r);
        const ids = await previewImageIds(r.cards.map((c) => c.oracleId));
        if (alive) setImgs(ids);
      });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // `owned` nur relevant, wenn „nur im Bestand" aktiv ist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, query, filter, limit, ownedOnly, ownedOnly ? owned : null, sort]);

  const extra = [filter.type, filter.cmc, filter.format, filter.text.trim() || null, filter.typeLine.trim() || null]
    .filter((v) => v != null).length;
  const multiColor = filter.colors.length > 0 && !filter.colors.includes('C');

  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-surface p-4">
        <h2 className="mb-2 font-hud text-sm text-text">SUCHE</h2>
        <input data-hotkey="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === 'karten' ? 'Name, Typ oder Regeltext (DE/EN)…' : 'Karte in der Kombo (DE/EN)…'}
          className="mb-2 w-full border-2 border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-paper"
        />
        <div className="mb-2 flex gap-1 font-mono text-xs">
          {(['karten', 'kombos'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m}
              className={`px-2 py-1 ${mode === m ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
              {m === 'karten' ? 'Karten' : 'Kombos'}
            </button>
          ))}
        </div>

        {mode === 'karten' && (<>

        {/* Farben: mehrere wählbar; farblos schließt Farben aus. */}
        <div className="flex flex-wrap gap-1 font-mono text-xs">
          {COLORS.map((c) => {
            const on = filter.colors.includes(c.key);
            return (
              <button key={c.key} onClick={() => patch({ colors: toggleColor(filter.colors, c.key) })} aria-pressed={on}
                className={`flex items-center gap-1 px-2 py-1 ${on ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
                <span className={`inline-block ${c.pip}`} style={{ width: 'calc(var(--px) * 3)', height: 'calc(var(--px) * 3)' }} />
                {c.label}
              </button>
            );
          })}
        </div>
        {multiColor && (
          <div className="mt-2 font-mono text-xs">
            <div className="flex gap-1">
              {COLOR_MODES.map((m) => (
                <button key={m.key} onClick={() => patch({ colorMode: m.key })} aria-pressed={filter.colorMode === m.key}
                  className={`px-2 py-1 ${filter.colorMode === m.key ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
                  {m.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-muted">{COLOR_MODES.find((m) => m.key === filter.colorMode)?.hint}</p>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs">
          <button onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}
            className={`px-2 py-1 ${extra > 0 ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
            Filter{extra > 0 ? ` (${extra})` : ''} {showFilters ? '▴' : '▾'}
          </button>
          <select value={sort} onChange={(e) => setSort(e.target.value as 'treffer' | 'beliebtheit')} aria-label="Sortieren"
            className="ml-auto border-2 border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-paper">
            <option value="treffer">Beste Treffer</option>
            <option value="beliebtheit">Beliebtheit</option>
          </select>
          <PixelCheckbox checked={ownedOnly} onChange={setOwnedOnly} className="text-muted">
            nur im Bestand
          </PixelCheckbox>
        </div>

        {showFilters && (
          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs">
            <label className="col-span-2 flex flex-col gap-1 text-muted">
              Regeltext enthält
              <input value={filter.text} onChange={(e) => patch({ text: e.target.value })}
                placeholder="z. B. draw a card, flying, ninjutsu" className={inputCls} />
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-muted">
              Typ / Kreaturentyp
              <input value={filter.typeLine} onChange={(e) => patch({ typeLine: e.target.value })}
                list="scry-subtypes" placeholder="z. B. Goblin, Elf, Equipment, legendär" className={inputCls} />
              <datalist id="scry-subtypes">
                {subtypes.map((t) => <option key={t} value={t} />)}
              </datalist>
            </label>
            <label className="flex flex-col gap-1 text-muted">
              Kartentyp
              <select value={filter.type ?? ''} onChange={(e) => patch({ type: e.target.value || null })} className={inputCls}>
                <option value="">Alle</option>
                {TYPE_FILTERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-muted">
              Manawert
              <select value={filter.cmc ?? ''} onChange={(e) => patch({ cmc: e.target.value === '' ? null : Number(e.target.value) })}
                className={inputCls}>
                <option value="">Alle</option>
                {CMC_OPTIONS.map((n) => <option key={n} value={n}>{n === 7 ? '7+' : n}</option>)}
              </select>
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-muted">
              Legal in Format
              <select value={filter.format ?? ''} onChange={(e) => patch({ format: (e.target.value || null) as FormatId | null })}
                className={inputCls}>
                <option value="">Alle Formate</option>
                {LEGALITY_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
              </select>
            </label>
            {extra > 0 && (
              <button onClick={() => patch({ type: null, cmc: null, format: null, text: '', typeLine: '' })}
                className="col-span-2 bg-bg px-2 py-1 text-muted hover:text-text">
                Filter zurücksetzen
              </button>
            )}
          </div>
        )}
        </>)}
      </div>

      {mode === 'kombos' ? (
        <ComboSearch query={query} owned={owned} onOpenCard={setDetailId} />
      ) : !active ? (
        <p className="px-1 font-mono text-sm text-muted">
          Suche nach Name, Typ oder Regeltext — oder stöbere nur mit den Filtern (z. B. Format + Farben).
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
