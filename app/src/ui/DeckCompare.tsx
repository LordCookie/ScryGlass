import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { listDecks } from '../db/db';
import { getCards, ownedByOracle, ownedPrintingByOracle, previewImageIds } from '../data/cards';
import { ensureRowPrices } from '../data/prices';
import { compareDecks, playedEntries, type CompareRow } from '../domain/deckCompare';
import { computeStats, isBasicLand, CURVE_BUCKETS, COLOR_KEYS } from '../domain/deckStats';
import { deckValueRows, collectionValue, formatEur, type PriceEntry } from '../domain/prices';
import { FORMAT_LABELS, type Card, type Deck } from '../domain/types';
import { ColorPips } from './mana';
import { CardDetail } from './CardDetail';
import { useBackHandler } from './backStack';
import { hoverPreview } from './wide';

/**
 * Zwei Decks nebeneinander (PLAN.md M22): nur in A / in beiden / nur in B, Kurven und
 * Farben, Wert — und welche gemeinsamen Karten die Sammlung nicht für beide gleichzeitig
 * hergibt. Im breiten Layout (Big Screen) in drei Spalten.
 */
export function DeckCompare({ initial, onBack }: { initial: [number, number]; onBack: () => void }) {
  useBackHandler(true, onBack);
  const decks = useLiveQuery(() => listDecks(), []);
  const [ids, setIds] = useState<[number, number]>(initial);
  const a = decks?.find((d) => d.id === ids[0]);
  const b = decks?.find((d) => d.id === ids[1]);

  const refIds = useMemo(() => [...new Set([...(a ? playedEntries(a) : []), ...(b ? playedEntries(b) : [])].map((e) => e.oracleId))], [a, b]);
  const cards = useLiveQuery(() => getCards(refIds), [refIds]);
  const owned = useLiveQuery(() => ownedByOracle(), []);
  const imgs = useLiveQuery(async () => {
    const [prev, chosen] = await Promise.all([previewImageIds(refIds), ownedPrintingByOracle()]);
    for (const [id, pid] of chosen) if (prev.has(id)) prev.set(id, pid);
    return prev;
  }, [refIds]);
  const [detail, setDetail] = useState<string | null>(null);

  const cmp = useMemo(() => (a && b && cards && owned
    ? compareDecks(a, b, owned, (id) => { const c = cards.get(id); return !!c && isBasicLand(c); })
    : null), [a, b, cards, owned]);

  if (!decks || !cards) return <p className="px-1 font-mono text-sm text-muted">Lade…</p>;
  const name = (id: string) => cards.get(id)?.name ?? id;
  const byName = (rows: CompareRow[]) => [...rows].sort((x, y) => name(x.oracleId).localeCompare(name(y.oracleId)));
  const pick = (i: 0 | 1, v: number) => setIds((cur) => (i === 0 ? [v, cur[1]] : [cur[0], v]));

  return (
    <section className={`space-y-3 font-mono ${detail ? 'lg:pr-[30rem]' : ''}`}>
      <div className="rounded-lg bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <button onClick={onBack} className="rounded px-2 py-1 text-sm text-muted hover:text-accent">← Decks</button>
          <h2 className="text-lg">Decks vergleichen</h2>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          {([0, 1] as const).map((i) => (
            <label key={i} className="flex min-w-0 items-center gap-2">
              <span className="font-hud text-[10px] text-paper">{i === 0 ? 'A' : 'B'}</span>
              <select value={ids[i]} onChange={(e) => pick(i, Number(e.target.value))}
                className="min-w-0 flex-1 border-2 border-border bg-bg px-2 py-1 outline-none focus:border-paper">
                {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          ))}
        </div>
        {cmp && (
          <p className="mt-3 text-xs text-muted">
            <span className="text-text">{cmp.both.length}</span> Karten in beiden ·{' '}
            <span className="text-text">{cmp.onlyA.length}</span> nur in A ·{' '}
            <span className="text-text">{cmp.onlyB.length}</span> nur in B
          </p>
        )}
      </div>

      {a && b && (
        <div className="grid gap-3 lg:grid-cols-2">
          <DeckSummary label="A" deck={a} cards={cards} chosen={imgs} />
          <DeckSummary label="B" deck={b} cards={cards} chosen={imgs} />
        </div>
      )}

      {cmp && cmp.short.length > 0 && (
        <div className="rounded-lg bg-surface p-3 text-xs">
          <h3 className="mb-1 text-sm">Reicht nicht für beide gleichzeitig</h3>
          <p className="mb-2 text-muted">Diese Karten stecken in beiden Decks — deine Sammlung hat nicht genug, um beide zusammen aufzubauen.</p>
          <ul className="space-y-0.5">
            {cmp.short.map((s) => (
              <li key={s.oracleId} className="flex gap-2">
                <button onClick={() => setDetail(s.oracleId)} {...hoverPreview(imgs?.get(s.oracleId), name(s.oracleId))}
                  className="min-w-0 flex-1 truncate text-left text-text hover:text-accent">{name(s.oracleId)}</button>
                <span className="text-danger">brauchst {s.need}, hast {s.have}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {cmp && (
        <div className="grid items-start gap-3 lg:grid-cols-3">
          <RowList title="Nur in A" rows={byName(cmp.onlyA)} cards={cards} imgs={imgs} show="a" onOpen={setDetail} />
          <RowList title="In beiden" rows={byName(cmp.both)} cards={cards} imgs={imgs} show="both" onOpen={setDetail} />
          <RowList title="Nur in B" rows={byName(cmp.onlyB)} cards={cards} imgs={imgs} show="b" onOpen={setDetail} />
        </div>
      )}

      {detail && <CardDetail oracleId={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

function RowList({ title, rows, cards, imgs, show, onOpen }: {
  title: string; rows: CompareRow[]; cards: Map<string, Card>; imgs?: Map<string, string>;
  show: 'a' | 'b' | 'both'; onOpen: (id: string) => void;
}) {
  const total = rows.reduce((n, r) => n + (show === 'b' ? r.b : r.a), 0);
  return (
    <div className="rounded-lg bg-surface p-3">
      <h3 className="mb-2 text-sm">{title} <span className="text-xs text-muted">({rows.length} Karten{show !== 'both' ? `, ${total} Stück` : ''})</span></h3>
      {rows.length === 0 ? <p className="text-xs text-muted">—</p> : (
        <ul className="space-y-0.5 text-sm">
          {rows.map((r) => {
            const card = cards.get(r.oracleId);
            return (
              <li key={r.oracleId} className="flex items-center gap-2">
                <ColorPips colors={card?.colorIdentity ?? []} />
                <span className="w-12 shrink-0 text-center font-hud text-[9px] text-text">
                  {show === 'both' ? (r.a === r.b ? `${r.a}×` : `${r.a}|${r.b}`) : `${show === 'a' ? r.a : r.b}×`}
                </span>
                <button onClick={() => onOpen(r.oracleId)} {...hoverPreview(imgs?.get(r.oracleId), card?.name)}
                  className="min-w-0 flex-1 truncate text-left hover:text-accent">{card?.name ?? r.oracleId}</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Kurve, Farben und Wert eines Decks — gleich gebaut für A und B. */
function DeckSummary({ label, deck, cards, chosen }: { label: string; deck: Deck; cards: Map<string, Card>; chosen?: Map<string, string> }) {
  const entries = playedEntries(deck);
  const stats = computeStats(entries, cards);
  const maxCurve = Math.max(1, ...stats.manaCurve);
  const priced = entries.filter((e) => { const c = cards.get(e.oracleId); return !c || !isBasicLand(c); });
  const names = new Map([...cards].map(([id, c]) => [id, c.name]));
  const rows = deckValueRows(priced, names, chosen);
  const sig = rows.map((r) => r.key).join(',');
  const [prices, setPrices] = useState<Map<string, PriceEntry> | null>(null);
  useEffect(() => {
    let alive = true;
    void ensureRowPrices(rows).then((p) => { if (alive) setPrices(p); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const value = prices ? collectionValue(rows, prices).total : null;
  return (
    <div className="rounded-lg bg-surface p-3 text-xs">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-hud text-[10px] text-paper">{label}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-text">{deck.name}</span>
        <span className="text-muted">{FORMAT_LABELS[deck.format]} · {stats.total} Karten · {value == null ? '…' : `≈ ${formatEur(value)}`}</span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: CURVE_BUCKETS }, (_, i) => (
          <div key={i} className="flex flex-1 flex-col items-center">
            <div className="flex w-full items-end" style={{ height: 48 }}>
              <div className="w-full bg-accent" style={{ height: `${(stats.manaCurve[i] / maxCurve) * 48}px` }} />
            </div>
            <span className="mt-0.5 text-muted">{i === CURVE_BUCKETS - 1 ? '7+' : i}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-muted">
        {COLOR_KEYS.filter((c) => stats.colors[c] > 0).map((c) => <span key={c}>{c} {stats.colors[c]}</span>)}
        <span>Länder {stats.lands} ({Math.round(stats.landRatio * 100)} %)</span>
      </div>
    </div>
  );
}
