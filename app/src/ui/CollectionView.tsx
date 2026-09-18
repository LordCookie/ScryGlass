import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, addOwned } from '../db/db';
import { getCards } from '../data/cards';
import { searchCards } from '../data/search';
import { normalizeName } from '../domain/nameMatch';
import type { Card, Owned, Finish } from '../domain/types';
import { ManaCost, ColorPips } from './mana';

/**
 * Sammlungsansicht (PLAN.md § 5, M5): Bestand, Suche, Filter, Sortierung.
 * Reaktiv über Dexie (`useLiveQuery`) — Änderungen (Scan-Übernahme, Peer-Import)
 * erscheinen sofort.
 */

type SortKey = 'name' | 'cmc' | 'qty';
const COLORS: { key: string; label: string }[] = [
  { key: 'W', label: 'W' }, { key: 'U', label: 'U' }, { key: 'B', label: 'B' },
  { key: 'R', label: 'R' }, { key: 'G', label: 'G' }, { key: 'C', label: 'farblos' },
];

interface Row {
  owned: Owned;
  card?: Card;
}

export function CollectionView() {
  const [query, setQuery] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('name');

  const rows = useLiveQuery<Row[]>(async () => {
    const owned = await db.owned.toArray();
    const cards = await getCards(owned.map((o) => o.oracleId));
    return owned.map((o) => ({ owned: o, card: cards.get(o.oracleId) }));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = normalizeName(query);
    let out = rows.filter((r) => r.card);
    if (q) out = out.filter((r) => r.card!.normName.includes(q));
    if (color) {
      out = out.filter((r) =>
        color === 'C' ? r.card!.colorIdentity.length === 0 : r.card!.colorIdentity.includes(color),
      );
    }
    out.sort((a, b) => {
      if (sort === 'cmc') return a.card!.cmc - b.card!.cmc || a.card!.name.localeCompare(b.card!.name);
      if (sort === 'qty') return b.owned.qty - a.owned.qty || a.card!.name.localeCompare(b.card!.name);
      return a.card!.name.localeCompare(b.card!.name);
    });
    return out;
  }, [rows, query, color, sort]);

  const totalCards = rows?.reduce((s, r) => s + r.owned.qty, 0) ?? 0;
  const distinct = rows?.length ?? 0;

  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-surface p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-mono text-lg">Sammlung</h2>
          <span className="font-mono text-xs text-muted">{totalCards} Karten · {distinct} verschiedene</span>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Suchen (Name)…"
          className="mb-2 w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        />
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <div className="flex gap-1">
            {COLORS.map((c) => (
              <button
                key={c.key}
                onClick={() => setColor(color === c.key ? null : c.key)}
                className={`rounded px-2 py-1 ${color === c.key ? 'bg-accent text-on-accent' : 'bg-bg text-muted hover:text-text'}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <label className="ml-auto flex items-center gap-1 text-muted">
            Sortieren
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent">
              <option value="name">Name</option>
              <option value="cmc">Manawert</option>
              <option value="qty">Anzahl</option>
            </select>
          </label>
        </div>
      </div>

      <ManualAddBox />

      {rows === undefined ? (
        <p className="px-1 font-mono text-sm text-muted">Lade…</p>
      ) : filtered.length === 0 ? (
        <p className="px-1 font-mono text-sm text-muted">
          {distinct === 0 ? 'Noch keine Karten. Scanne welche im Scanner-Tab.' : 'Keine Treffer.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            // Jede Zeile = Mini-Kartenrahmen (DESIGN § 1/§ 6): Titelbalken Name/Mana, Meta-Zeile.
            <li key={`${r.owned.oracleId}-${r.owned.finish}`} className="frame font-mono">
              <div className="titlebar">
                <span className="min-w-0 flex-1 truncate text-text">{r.card!.name}</span>
                <ManaCost cost={r.card!.manaCost} />
              </div>
              <div className="flex items-center gap-2 px-3 py-2 text-sm">
                <ColorPips colors={r.card!.colorIdentity} />
                <span className="min-w-0 flex-1 truncate text-muted">
                  {r.card!.typeLine}
                  {r.owned.finish !== 'nonfoil' && <span className="ml-2 text-accent">✦ {r.owned.finish}</span>}
                </span>
                <button onClick={() => void addOwned(r.owned.oracleId, r.owned.finish, -1)} aria-label="weniger" className="px-2 py-1 text-muted hover:text-paper">−</button>
                <span className="w-10 text-center font-hud text-[10px] text-text">{r.owned.qty}×</span>
                <button onClick={() => void addOwned(r.owned.oracleId, r.owned.finish, 1, { source: 'manual' })} aria-label="mehr" className="px-2 py-1 text-muted hover:text-paper">+</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Karte per Hand in die Sammlung aufnehmen (Katalogsuche DE+EN → Klick fügt +1
 * hinzu). Ergänzt den Scanner für alles, was man lieber tippt (PLAN.md § 0/§ 5).
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
            className="rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent"
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
        placeholder="Kartenname (DE oder EN)…"
        className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
      />
      {added && <p className="mt-2 font-mono text-xs text-ok">✓ „{added}" in die Sammlung ({finish})</p>}
      {results.length > 0 && (
        <ul className="mt-2 divide-y divide-white/5 overflow-hidden rounded-md border border-border">
          {results.map((card) => (
            <li key={card.oracleId}>
              <button
                onClick={() => void add(card)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-sm hover:bg-white/10"
              >
                <ColorPips colors={card.colorIdentity} />
                <span className="min-w-0 flex-1 truncate">{card.name}</span>
                <span className="truncate text-[10px] text-muted">{card.typeLine}</span>
                <span className="shrink-0 text-accent">＋</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
