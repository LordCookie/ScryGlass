import { useEffect, useMemo, useState } from 'react';
import { byPopularity } from '../domain/popularity';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, addOwned } from '../db/db';
import { getCards, previewImageIds } from '../data/cards';
import { searchCards, searchTokens } from '../data/search';
import type { Card, Owned, Finish } from '../domain/types';
import {
  matchesFilter, extraFilterCount, EMPTY_FILTER, TYPE_FILTERS,
  type CollectionFilter, type FilterRow,
} from '../domain/collectionFilter';
import { priceKey, fallbackPriceKey, ownedUnitPrice, formatEur } from '../domain/prices';
import { isTokenCard } from '../domain/tokens';
import { getPrices } from '../data/prices';
import { CardImage } from './CardImage';
import { CardDetail } from './CardDetail';
import { CollectionStats } from './CollectionStats';
import { addTokens, getTokenCount } from '../data/tokens';
import { ManaCost, ColorPips } from './mana';
import { PreconsView } from './PreconsView';
import { hoverPreview } from './wide';

/**
 * Sammlungsansicht (PLAN.md § 5, M5): Bestand, Suche, Filter, Sortierung.
 * Drei Ansichten: Bild-Raster (mit Anzahl-Badge), Liste (Mini-Kartenrahmen) und
 * Statistik (der gefilterten Auswahl). Klick auf eine Karte öffnet das Detail.
 * Reaktiv über Dexie.
 *
 * Karten und Tokens getrennt (Großes Token-Update, M14): Tokens zählen je Artwork,
 * ihr Raster zeigt deshalb jede Druckausgabe einzeln. Dritter Reiter: Fertigdecks (M19).
 */

type SortKey = 'name' | 'cmc' | 'qty' | 'value' | 'rank';
type ViewMode = 'grid' | 'list' | 'stats';
type Kind = 'cards' | 'tokens' | 'precons';
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
  token: boolean;
}
type KnownRow = FilterRow & { scryfallId?: string };

export function CollectionView() {
  const [kind, setKind] = useState<Kind>('cards');
  if (kind === 'precons') {
    return (
      <section className="space-y-3">
        <div className="rounded-lg bg-surface p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-hud text-sm text-text">SAMMLUNG</h2>
          </div>
          <KindToggle kind={kind} onKind={setKind} />
        </div>
        <PreconsView />
      </section>
    );
  }
  return <OwnedCollection kind={kind} onKind={setKind} />;
}

/** Karten | Tokens | Fertigdecks (M14, M19) — Tokens zählen je Artwork und nicht für Decks. */
function KindToggle({ kind, onKind, tokenTotal = 0 }: { kind: Kind; onKind: (k: Kind) => void; tokenTotal?: number }) {
  const label = (k: Kind) => (k === 'cards' ? 'Karten' : k === 'tokens' ? `Tokens${tokenTotal > 0 ? ` (${tokenTotal})` : ''}` : 'Fertigdecks');
  return (
    <div className="mb-2 flex gap-1 font-mono text-xs">
      {(['cards', 'tokens', 'precons'] as Kind[]).map((k) => (
        <button key={k} onClick={() => onKind(k)} aria-pressed={kind === k}
          className={`px-3 py-1 ${kind === k ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
          {label(k)}
        </button>
      ))}
    </div>
  );
}

function OwnedCollection({ kind, onKind }: { kind: Exclude<Kind, 'precons'>; onKind: (k: Kind) => void }) {
  const [filter, setFilter] = useState<CollectionFilter>(EMPTY_FILTER);
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<SortKey>('name');
  const [view, setView] = useState<ViewMode>('grid');
  const [detail, setDetail] = useState<{ oracleId: string; printingId?: string } | null>(null);
  const patch = (p: Partial<CollectionFilter>) => setFilter((f) => ({ ...f, ...p }));

  const rows = useLiveQuery<Row[]>(async () => {
    const owned = await db.owned.toArray();
    const ids = owned.map((o) => o.oracleId);
    const pids = owned.map((o) => o.printingId).filter((p): p is string => !!p);
    const [cards, imgs, prints] = await Promise.all([getCards(ids), previewImageIds(ids), db.printings.bulkGet(pids)]);
    const setOf = new Map<string, string>();
    for (const p of prints) if (p) setOf.set(p.scryfallId, p.set);
    // Gewählte Ausgabe (printingId) bevorzugen, sonst die Standard-Vorschau.
    return owned.map((o) => {
      const card = cards.get(o.oracleId);
      return {
        owned: o,
        card,
        scryfallId: o.printingId ?? imgs.get(o.oracleId),
        set: o.printingId ? setOf.get(o.printingId) : undefined,
        token: isTokenCard(card),
      };
    });
  }, []);
  const ownRows = useMemo(() => (rows ?? []).filter((r) => r.token === (kind === 'tokens')), [rows, kind]);

  // Preise (gemerkte Ausgabe + Ersatz über die Standardausgabe) für Wert-Sortierung und Liste.
  const priceKeys = useMemo(
    () => ownRows.flatMap((r) => {
      const fb = fallbackPriceKey(r.owned);
      return fb ? [priceKey(r.owned), fb] : [priceKey(r.owned)];
    }),
    [ownRows],
  );
  const prices = useLiveQuery(() => getPrices(priceKeys), [priceKeys]);

  const filtered = useMemo<KnownRow[]>(() => {
    const out = ownRows.filter((r): r is Row & KnownRow => !!r.card && matchesFilter(r as KnownRow, filter));
    out.sort((a, b) => {
      if (sort === 'cmc') return a.card.cmc - b.card.cmc || a.card.name.localeCompare(b.card.name);
      if (sort === 'qty') return b.owned.qty - a.owned.qty || a.card.name.localeCompare(b.card.name);
      if (sort === 'rank') return byPopularity(a.card, b.card);
      if (sort === 'value') {
        // Gesamtwert der Position, teuerste zuerst; ohne Preis ans Ende.
        const val = (r: KnownRow) => { const u = prices ? ownedUnitPrice(r.owned, prices) : undefined; return u == null ? -1 : u * r.owned.qty; };
        return val(b) - val(a) || a.card.name.localeCompare(b.card.name);
      }
      return a.card.name.localeCompare(b.card.name);
    });
    return out;
  }, [ownRows, filter, sort, prices]);

  // Sets, die in der Auswahl vorkommen (für den Set-Filter), nach Anzahl sortiert.
  const setOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of ownRows) if (r.set) m.set(r.set, (m.get(r.set) ?? 0) + r.owned.qty);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [ownRows]);
  const extraCount = extraFilterCount(filter);

  // Fürs Raster zusammenfassen (Anzahl über Ausführungen summieren): Karten je oracleId,
  // Tokens je Artwork.
  const gridItems = useMemo(() => {
    const map = new Map<string, { key: string; card: Card; scryfallId?: string; printingId?: string; qty: number }>();
    for (const r of filtered) {
      const key = kind === 'tokens' ? `${r.owned.oracleId}|${r.owned.printingId ?? ''}` : r.owned.oracleId;
      const cur = map.get(key);
      if (cur) cur.qty += r.owned.qty;
      else map.set(key, { key, card: r.card, scryfallId: r.scryfallId, printingId: r.owned.printingId, qty: r.owned.qty });
    }
    return [...map.values()];
  }, [filtered, kind]);

  const cardRows = (rows ?? []).filter((r) => !r.token);
  const totalCards = cardRows.reduce((s, r) => s + r.owned.qty, 0);
  const distinct = new Set(cardRows.map((r) => r.owned.oracleId)).size;
  const withoutArt = useLiveQuery(() => getTokenCount(), []) ?? 0;
  const tokenTotal = (rows ?? []).reduce((s, r) => s + (r.token ? r.owned.qty : 0), 0) + withoutArt;
  const tokens = kind === 'tokens';

  // Reihenfolge fürs Blättern im Detail (↑/↓, breites Layout): wie gerade angezeigt.
  const order = view === 'grid'
    ? gridItems.map((it) => ({ oracleId: it.card.oracleId, printingId: it.printingId }))
    : filtered.map((r) => ({ oracleId: r.owned.oracleId, printingId: r.owned.printingId }));
  const detailAt = detail ? order.findIndex((o) => o.oracleId === detail.oracleId && (!tokens || o.printingId === detail.printingId)) : -1;
  const goto = (delta: number) => {
    if (detailAt < 0 || order.length === 0) return;
    setDetail(order[(detailAt + delta + order.length) % order.length]);
  };

  return (
    // Breit (M18): Filter als Spalte links, Raster/Liste rechts; offenes Detail bekommt rechts Platz.
    <section className={`space-y-3 lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start lg:gap-4 lg:space-y-0 ${detail ? 'lg:pr-[30rem]' : ''}`}>
      <div className="space-y-3 lg:sticky lg:top-4">
      <div className="rounded-lg bg-surface p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-hud text-sm text-text">SAMMLUNG</h2>
          <span className="font-mono text-xs text-muted">{totalCards} Karten · {distinct} verschiedene{tokenTotal > 0 ? ` · ${tokenTotal} Tokens` : ''}</span>
        </div>
        <KindToggle kind={kind} onKind={onKind} tokenTotal={tokenTotal} />
        <input
          value={filter.query}
          onChange={(e) => patch({ query: e.target.value })}
          data-hotkey="search"
          placeholder={tokens ? 'Tokens suchen (Name oder Typ)…' : 'Suchen (Name, Typ oder Regeltext)…'}
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
                <option value="rank">Beliebtheit</option>
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
            {setOptions.length === 0 && !tokens && (
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

      <ManualAddBox tokens={tokens} onPickToken={(card) => setDetail({ oracleId: card.oracleId })} />
      </div>

      <div className="min-w-0 space-y-3">

      {/* Ohne Artwork gezählte Tokens (Katalog kannte sie nicht, oder von vor dem Update). */}
      {tokens && withoutArt > 0 && (
        <div className="flex items-center gap-2 rounded-lg bg-surface px-4 py-2 font-mono text-xs">
          <span className="min-w-0 flex-1 text-muted">Ohne Artwork gezählt: <span className="text-text">{withoutArt}</span></span>
          <button onClick={() => void addTokens(-1)} aria-label="Ein Token weniger" className="bg-bg px-3 py-1 text-paper">−</button>
          <button onClick={() => void addTokens(1)} aria-label="Ein Token mehr" className="bg-bg px-3 py-1 text-paper">+</button>
        </div>
      )}

      {rows === undefined ? (
        <p className="px-1 font-mono text-sm text-muted">Lade…</p>
      ) : filtered.length === 0 ? (
        <p className="px-1 font-mono text-sm text-muted">
          {ownRows.length > 0
            ? 'Keine Treffer.'
            : tokens
              ? 'Noch keine Tokens mit Artwork. Scanne welche oder füge sie oben hinzu.'
              : 'Noch keine Karten. Scanne welche im Scanner-Tab.'}
        </p>
      ) : view === 'stats' ? (
        // Statistik der aktuell gefilterten Auswahl.
        <CollectionStats rows={filtered} tokens={tokens} />
      ) : view === 'grid' ? (
        // Bild-Raster mit Anzahl-Badge oben rechts.
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-5 min-[1600px]:grid-cols-7 min-[2000px]:grid-cols-9">
          {gridItems.map((it) => (
            <li key={it.key}>
              <button onClick={() => setDetail({ oracleId: it.card.oracleId, printingId: it.printingId })}
                className="relative block w-full" title={it.card.name}>
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
        <>
        {/* Breit: Tabelle mit sortierbaren Spalten (M18). */}
        <CollectionTable rows={filtered} prices={prices} tokens={tokens} sort={sort} onSort={setSort}
          onOpen={(r) => setDetail({ oracleId: r.owned.oracleId, printingId: r.owned.printingId })} />
        <ul className="space-y-2 lg:hidden">
          {filtered.map((r) => (
            // Jede Zeile = Mini-Kartenrahmen (DESIGN § 1/§ 6): Titelbalken Name/Mana, Meta-Zeile.
            <li key={`${r.owned.oracleId}-${r.owned.finish}-${r.owned.printingId ?? ''}`} className="frame font-mono">
              <button onClick={() => setDetail({ oracleId: r.owned.oracleId, printingId: r.owned.printingId })} className="titlebar w-full text-left">
                <span className="min-w-0 flex-1 truncate text-text">{r.card!.name}</span>
                <ManaCost cost={r.card!.manaCost} />
              </button>
              <div className="flex items-center gap-2 px-3 py-2 text-sm">
                <ColorPips colors={r.card!.colorIdentity} />
                <span className="min-w-0 flex-1 truncate text-muted">
                  {r.card!.typeLine}
                  {tokens && r.set && <span className="ml-2">{r.set.toUpperCase()}</span>}
                  {r.owned.finish !== 'nonfoil' && <span className="ml-2 text-accent">✦ {r.owned.finish}</span>}
                </span>
                {prices && ownedUnitPrice(r.owned, prices) != null && (
                  <span className="shrink-0 text-xs text-text">{formatEur(ownedUnitPrice(r.owned, prices))}</span>
                )}
                <button onClick={() => void addOwned(r.owned.oracleId, r.owned.finish, -1, { printingId: r.owned.printingId })}
                  aria-label="weniger" className="px-2 py-1 text-muted hover:text-paper">−</button>
                <span className="w-10 text-center font-hud text-[10px] text-text">{r.owned.qty}×</span>
                <button onClick={() => void addOwned(r.owned.oracleId, r.owned.finish, 1, { source: 'manual', printingId: r.owned.printingId })}
                  aria-label="mehr" className="px-2 py-1 text-muted hover:text-paper">+</button>
              </div>
            </li>
          ))}
        </ul>
        </>
      )}
      </div>

      {detail && (
        <CardDetail oracleId={detail.oracleId} printingId={detail.printingId} onClose={() => setDetail(null)}
          onPrev={order.length > 1 ? () => goto(-1) : undefined} onNext={order.length > 1 ? () => goto(1) : undefined} />
      )}
    </section>
  );
}

/**
 * Karte per Hand in die Sammlung aufnehmen (Katalogsuche über Name, Typ UND
 * Regeltext, DE+EN → Klick fügt +1 hinzu). Ergänzt den Scanner (PLAN.md § 0/§ 5).
 * Tokens: Klick öffnet das Detail — dort das Artwork wählen und hinzufügen (M14).
 */
function ManualAddBox({ tokens, onPickToken }: { tokens: boolean; onPickToken: (card: Card) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Card[]>([]);
  // Suchbegriff, zu dem `results` gehören — „nichts gefunden" erst, wenn die Suche fertig ist.
  const [doneQ, setDoneQ] = useState('');
  const [finish, setFinish] = useState<Finish>('nonfoil');
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const query = q.trim();
    if (query) {
      void (tokens ? searchTokens(query, 8) : searchCards(query, 8)).then((r) => {
        if (!alive) return;
        setResults(r);
        setDoneQ(query);
      });
    } else setResults([]);
    return () => { alive = false; };
  }, [q, tokens]);

  async function add(card: Card) {
    if (tokens) {
      onPickToken(card);
      return;
    }
    await addOwned(card.oracleId, finish, 1, { source: 'manual' });
    setAdded(card.name);
    window.setTimeout(() => setAdded(null), 1500);
  }

  return (
    <div className="rounded-lg bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-mono text-sm">{tokens ? 'Token manuell hinzufügen' : 'Karte manuell hinzufügen'}</h3>
        {!tokens && (
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
        )}
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={tokens ? 'Token-Name oder Typ (EN), z. B. Treasure…' : 'Name, Typ oder Regeltext (DE/EN)…'}
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
                <span className="shrink-0 text-accent">{tokens ? 'Artwork ›' : '＋'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {tokens && results.length === 0 && q.trim() !== '' && doneQ === q.trim() && (
        <p className="mt-2 font-mono text-[10px] text-muted">Kein Token gefunden — der Katalog braucht den Stand mit Tokens.</p>
      )}
    </div>
  );
}

/**
 * Listenansicht im breiten Layout (M18): Tabelle mit sortierbaren Spalten. Name, Manawert,
 * Anzahl und Preis sortieren über dieselbe Einstellung wie oben; Maus über dem Namen zeigt
 * das Kartenbild.
 */
const nfRank = new Intl.NumberFormat('de-DE');

function CollectionTable({ rows, prices, tokens, sort, onSort, onOpen }: {
  rows: KnownRow[];
  prices: Awaited<ReturnType<typeof getPrices>> | undefined;
  tokens: boolean;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  onOpen: (r: KnownRow) => void;
}) {
  const head = (label: string, key?: SortKey, right = false, cls = '') => (
    <th className={`px-2 py-1.5 font-normal ${right ? 'text-right' : 'text-left'} ${cls}`}>
      {key ? (
        <button onClick={() => onSort(key)} className={sort === key ? 'text-paper' : 'text-muted hover:text-text'}>
          {label}{sort === key ? ' ▾' : ''}
        </button>
      ) : <span className="text-muted">{label}</span>}
    </th>
  );
  return (
    <table className="hidden w-full border-collapse bg-surface font-mono text-sm lg:table">
      <thead className="sticky top-0 bg-titlebar text-xs">
        <tr>
          {head('Name', 'name', false, 'w-[38%]')}
          {head('Typ')}
          {head('Set')}
          {head('Ausführung')}
          {head('Manawert', 'cmc', true)}
          {head('Rang', 'rank', true)}
          {head('Preis', 'value', true)}
          {head('Anzahl', 'qty', true)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const unit = prices ? ownedUnitPrice(r.owned, prices) : undefined;
          return (
            <tr key={`${r.owned.oracleId}-${r.owned.finish}-${r.owned.printingId ?? ''}`} className="border-t border-border hover:bg-elevated">
              <td className="max-w-0 px-2 py-1">
                <button onClick={() => onOpen(r)} {...hoverPreview(r.scryfallId, r.card.name)}
                  className="flex w-full min-w-0 items-center gap-2 text-left text-text hover:text-accent">
                  <ColorPips colors={r.card.colorIdentity} />
                  <span className="truncate">{r.card.name}</span>
                  <span className="ml-auto shrink-0"><ManaCost cost={r.card.manaCost} /></span>
                </button>
              </td>
              <td className="max-w-[14rem] truncate px-2 py-1 text-xs text-muted">{r.card.typeLine}</td>
              <td className="px-2 py-1 text-xs text-muted">{r.set?.toUpperCase() ?? (tokens ? '?' : '–')}</td>
              <td className="px-2 py-1 text-xs">{r.owned.finish !== 'nonfoil' ? <span className="text-accent">✦ {r.owned.finish}</span> : <span className="text-muted">normal</span>}</td>
              <td className="px-2 py-1 text-right text-xs text-muted">{r.card.cmc}</td>
              <td className="px-2 py-1 text-right text-xs text-muted" title="EDHREC-Rang über Scryfall">{r.card.edhrecRank != null ? nfRank.format(r.card.edhrecRank) : ''}</td>
              <td className="px-2 py-1 text-right text-xs text-text">{unit != null ? formatEur(unit) : ''}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right">
                <button onClick={() => void addOwned(r.owned.oracleId, r.owned.finish, -1, { printingId: r.owned.printingId })}
                  aria-label="weniger" className="px-1.5 text-muted hover:text-paper">−</button>
                <span className="inline-block w-9 text-center font-hud text-[10px] text-text">{r.owned.qty}×</span>
                <button onClick={() => void addOwned(r.owned.oracleId, r.owned.finish, 1, { source: 'manual', printingId: r.owned.printingId })}
                  aria-label="mehr" className="px-1.5 text-muted hover:text-paper">+</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
