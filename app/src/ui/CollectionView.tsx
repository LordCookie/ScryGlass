import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, addOwned } from '../db/db';
import { getCards, previewImageIds } from '../data/cards';
import { searchCards } from '../data/search';
import type { Card, Owned, Finish } from '../domain/types';
import {
  matchesFilter, extraFilterCount, EMPTY_FILTER, TYPE_FILTERS,
  type CollectionFilter, type FilterRow,
} from '../domain/collectionFilter';
import { priceKey, fallbackPriceKey, ownedUnitPrice, formatEur } from '../domain/prices';
import { getPrices } from '../data/prices';
import { CardImage } from './CardImage';
import { CardDetail } from './CardDetail';
import { CollectionStats } from './CollectionStats';
import { getTokenCount } from '../data/tokens';
import { ManaCost, ColorPips } from './mana';

/**
 * Sammlungsansicht (PLAN.md § 5, M5): Bestand, Suche, Filter, Sortierung.
 * Drei Ansichten: Bild-Raster (mit Anzahl-Badge), Liste (Mini-Kartenrahmen) und
 * Statistik (der gefilterten Auswahl). Klick auf eine Karte öffnet das Detail.
 * Reaktiv über Dexie.
 */

type SortKey = 'name' | 'cmc' | 'qty' | 'value';
type ViewMode = 'grid' | 'list' | 'stats';
const CMC_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7];
const FINISH_LABEL: Record<Finish, string> = { nonfoil: 'normal', foil: 'foil', etched: 'etched' };
const COLORS: { key: string; label: string }[] = [
  { key: 'W', label: 'W' }, { key: 'U', label: 'U' }, { key: 'B', label: 'B' },
  { key: 'R', label: 'R' }, { key: 'G', label: 'G' }, { key: 'C', label: 'farblos' },
];

interface Row {
  owned: Owned;
  card?: Card;
  scryfallId?: string;
  /** Set der gemerkten Ausgabe (nur mit printingId bekannt). */
  set?: string;
}
type KnownRow = FilterRow & { scryfallId?: string };

export function CollectionView() {
  const [filter, setFilter] = useState<CollectionFilter>(EMPTY_FILTER);
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<SortKey>('name');
  const [view, setView] = useState<ViewMode>('grid');
  const [detailId, setDetailId] = useState<string | null>(null);
  const patch = (p: Partial<CollectionFilter>) => setFilter((f) => ({ ...f, ...p }));

  const rows = useLiveQuery<Row[]>(async () => {
    const owned = await db.owned.toArray();
    const ids = owned.map((o) => o.oracleId);
    const pids = owned.map((o) => o.printingId).filter((p): p is string => !!p);
    const [cards, imgs, prints] = await Promise.all([getCards(ids), previewImageIds(ids), db.printings.bulkGet(pids)]);
    const setOf = new Map<string, string>();
    for (const p of prints) if (p) setOf.set(p.scryfallId, p.set);
    // Gewählte Ausgabe (printingId) bevorzugen, sonst die Standard-Vorschau.
    return owned.map((o) => ({
      owned: o,
      card: cards.get(o.oracleId),
      scryfallId: o.printingId ?? imgs.get(o.oracleId),
      set: o.printingId ? setOf.get(o.printingId) : undefined,
    }));
  }, []);

  // Preise (gemerkte Ausgabe + Ersatz über die Standardausgabe) für Wert-Sortierung und Liste.
  const priceKeys = useMemo(
    () => (rows ?? []).flatMap((r) => {
      const fb = fallbackPriceKey(r.owned);
      return fb ? [priceKey(r.owned), fb] : [priceKey(r.owned)];
    }),
    [rows],
  );
  const prices = useLiveQuery(() => getPrices(priceKeys), [priceKeys]);

  const filtered = useMemo<KnownRow[]>(() => {
    if (!rows) return [];
    const out = rows.filter((r): r is KnownRow => !!r.card && matchesFilter(r as KnownRow, filter));
    out.sort((a, b) => {
      if (sort === 'cmc') return a.card.cmc - b.card.cmc || a.card.name.localeCompare(b.card.name);
      if (sort === 'qty') return b.owned.qty - a.owned.qty || a.card.name.localeCompare(b.card.name);
      if (sort === 'value') {
        // Gesamtwert der Position, teuerste zuerst; ohne Preis ans Ende.
        const val = (r: KnownRow) => { const u = prices ? ownedUnitPrice(r.owned, prices) : undefined; return u == null ? -1 : u * r.owned.qty; };
        return val(b) - val(a) || a.card.name.localeCompare(b.card.name);
      }
      return a.card.name.localeCompare(b.card.name);
    });
    return out;
  }, [rows, filter, sort, prices]);

  // Sets, die in der Sammlung vorkommen (für den Set-Filter), nach Anzahl sortiert.
  const setOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) if (r.set) m.set(r.set, (m.get(r.set) ?? 0) + r.owned.qty);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [rows]);
  const extraCount = extraFilterCount(filter);

  // Fürs Raster je oracleId zusammenfassen (Anzahl über Ausführungen summieren).
  const gridItems = useMemo(() => {
    const map = new Map<string, { card: Card; scryfallId?: string; qty: number }>();
    for (const r of filtered) {
      const cur = map.get(r.owned.oracleId);
      if (cur) cur.qty += r.owned.qty;
      else map.set(r.owned.oracleId, { card: r.card!, scryfallId: r.scryfallId, qty: r.owned.qty });
    }
    return [...map.values()];
  }, [filtered]);

  const totalCards = rows?.reduce((s, r) => s + r.owned.qty, 0) ?? 0;
  const distinct = new Set(rows?.map((r) => r.owned.oracleId)).size;
  const tokens = useLiveQuery(() => getTokenCount(), []) ?? 0;

  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-surface p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-hud text-sm text-text">SAMMLUNG</h2>
          <span className="font-mono text-xs text-muted">{totalCards} Karten · {distinct} verschiedene{tokens > 0 ? ` · ${tokens} Tokens` : ''}</span>
        </div>
        <input
          value={filter.query}
          onChange={(e) => patch({ query: e.target.value })}
          placeholder="Suchen (Name, Typ oder Regeltext)…"
          className="mb-2 w-full border-2 border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-paper"
        />
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <div className="flex gap-1">
            {COLORS.map((c) => (
              <button
                key={c.key}
                onClick={() => patch({ color: filter.color === c.key ? null : c.key })}
                className={`px-2 py-1 ${filter.color === c.key ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
            className={`px-2 py-1 ${extraCount > 0 ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}
          >
            Filter{extraCount > 0 ? ` (${extraCount})` : ''} {showFilters ? '▴' : '▾'}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1 text-muted">
              Sortieren
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
                className="border-2 border-border bg-bg px-2 py-1 outline-none focus:border-paper">
                <option value="name">Name</option>
                <option value="cmc">Manawert</option>
                <option value="qty">Anzahl</option>
                <option value="value">Wert</option>
              </select>
            </label>
            {/* Ansicht umschalten: Raster / Liste / Statistik */}
            <div className="flex">
              <button onClick={() => setView('grid')} aria-label="Raster"
                className={`px-2 py-1 ${view === 'grid' ? 'bg-fill text-paper' : 'bg-bg text-muted'}`}>▦</button>
              <button onClick={() => setView('list')} aria-label="Liste"
                className={`px-2 py-1 ${view === 'list' ? 'bg-fill text-paper' : 'bg-bg text-muted'}`}>≣</button>
              <button onClick={() => setView('stats')} aria-label="Statistik"
                className={`px-2 py-1 ${view === 'stats' ? 'bg-fill text-paper' : 'bg-bg text-muted'}`}>Σ</button>
            </div>
          </div>
        </div>

        {/* Zusatzfilter (Typ, Manawert, Set, Ausführung) */}
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
            <label className="flex flex-col gap-1 text-muted">
              Set
              <select value={filter.set ?? ''} onChange={(e) => patch({ set: e.target.value || null })}
                disabled={setOptions.length === 0}
                className="border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper disabled:opacity-40">
                <option value="">Alle</option>
                {setOptions.map(([s, n]) => <option key={s} value={s}>{s.toUpperCase()} ({n})</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-muted">
              Ausführung
              <select value={filter.finish ?? ''} onChange={(e) => patch({ finish: (e.target.value || null) as Finish | null })}
                className="border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper">
                <option value="">Alle</option>
                {(Object.keys(FINISH_LABEL) as Finish[]).map((f) => <option key={f} value={f}>{FINISH_LABEL[f]}</option>)}
              </select>
            </label>
            {setOptions.length === 0 && (
              <p className="col-span-2 text-[10px] text-muted">
                Set-Filter: kennt nur Karten, deren Artwork im Kartendetail gewählt wurde.
              </p>
            )}
            {extraCount > 0 && (
              <button onClick={() => patch({ type: null, cmc: null, set: null, finish: null })}
                className="col-span-2 bg-bg px-2 py-1 text-muted hover:text-text">
                Filter zurücksetzen
              </button>
            )}
          </div>
        )}
      </div>

      <ManualAddBox />

      {rows === undefined ? (
        <p className="px-1 font-mono text-sm text-muted">Lade…</p>
      ) : filtered.length === 0 ? (
        <p className="px-1 font-mono text-sm text-muted">
          {distinct === 0 ? 'Noch keine Karten. Scanne welche im Scanner-Tab.' : 'Keine Treffer.'}
        </p>
      ) : view === 'stats' ? (
        // Statistik der aktuell gefilterten Auswahl.
        <CollectionStats rows={filtered} />
      ) : view === 'grid' ? (
        // Bild-Raster mit Anzahl-Badge oben rechts.
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {gridItems.map((it) => (
            <li key={it.card.oracleId}>
              <button onClick={() => setDetailId(it.card.oracleId)} className="relative block w-full" title={it.card.name}>
                <CardImage scryfallId={it.scryfallId} name={it.card.name} size="normal" className="h-auto w-full" />
                <span className="absolute right-0 top-0 bg-titlebar px-1.5 py-0.5 font-hud text-[10px] text-paper"
                  style={{ boxShadow: 'calc(var(--px)*-1) calc(var(--px)*1) 0 rgb(var(--c-fill))' }}>
                  {it.qty}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            // Jede Zeile = Mini-Kartenrahmen (DESIGN § 1/§ 6): Titelbalken Name/Mana, Meta-Zeile.
            <li key={`${r.owned.oracleId}-${r.owned.finish}`} className="frame font-mono">
              <button onClick={() => setDetailId(r.owned.oracleId)} className="titlebar w-full text-left">
                <span className="min-w-0 flex-1 truncate text-text">{r.card!.name}</span>
                <ManaCost cost={r.card!.manaCost} />
              </button>
              <div className="flex items-center gap-2 px-3 py-2 text-sm">
                <ColorPips colors={r.card!.colorIdentity} />
                <span className="min-w-0 flex-1 truncate text-muted">
                  {r.card!.typeLine}
                  {r.owned.finish !== 'nonfoil' && <span className="ml-2 text-accent">✦ {r.owned.finish}</span>}
                </span>
                {prices && ownedUnitPrice(r.owned, prices) != null && (
                  <span className="shrink-0 text-xs text-text">{formatEur(ownedUnitPrice(r.owned, prices))}</span>
                )}
                <button onClick={() => void addOwned(r.owned.oracleId, r.owned.finish, -1)} aria-label="weniger" className="px-2 py-1 text-muted hover:text-paper">−</button>
                <span className="w-10 text-center font-hud text-[10px] text-text">{r.owned.qty}×</span>
                <button onClick={() => void addOwned(r.owned.oracleId, r.owned.finish, 1, { source: 'manual' })} aria-label="mehr" className="px-2 py-1 text-muted hover:text-paper">+</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {detailId && <CardDetail oracleId={detailId} onClose={() => setDetailId(null)} />}
    </section>
  );
}

/**
 * Karte per Hand in die Sammlung aufnehmen (Katalogsuche über Name, Typ UND
 * Regeltext, DE+EN → Klick fügt +1 hinzu). Ergänzt den Scanner (PLAN.md § 0/§ 5).
 */
function ManualAddBox() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Card[]>([]);
  const [finish, setFinish] = useState<Finish>('nonfoil');
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (q.trim()) void searchCards(q, 8).then((r) => { if (alive) setResults(r); });
    else setResults([]);
    return () => { alive = false; };
  }, [q]);

  async function add(card: Card) {
    await addOwned(card.oracleId, finish, 1, { source: 'manual' });
    setAdded(card.name);
    window.setTimeout(() => setAdded(null), 1500);
  }

  return (
    <div className="rounded-lg bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-mono text-sm">Karte manuell hinzufügen</h3>
        <label className="flex items-center gap-1 font-mono text-xs text-muted">
          Ausführung
          <select
            value={finish}
            onChange={(e) => setFinish(e.target.value as Finish)}
            className="border-2 border-border bg-bg px-2 py-1 outline-none focus:border-paper"
          >
            <option value="nonfoil">normal</option>
            <option value="foil">foil</option>
            <option value="etched">etched</option>
          </select>
        </label>
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Name, Typ oder Regeltext (DE/EN)…"
        className="w-full border-2 border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-paper"
      />
      {added && <p className="mt-2 font-mono text-xs text-ok">✓ „{added}" in die Sammlung ({finish})</p>}
      {results.length > 0 && (
        <ul className="mt-2 divide-y divide-white/5 overflow-hidden border-2 border-border">
          {results.map((card) => (
            <li key={card.oracleId}>
              <button
                onClick={() => void add(card)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-sm hover:bg-white/10"
              >
                <ColorPips colors={card.colorIdentity} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{card.name}</span>
                  <span className="block truncate text-[10px] text-muted">{card.typeLine}</span>
                </span>
                <span className="shrink-0 text-accent">＋</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
