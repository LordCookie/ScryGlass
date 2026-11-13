import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { getCards, previewImageIds, catalogFeatures } from '../data/cards';
import { deckCombos } from '../data/combos';
import { recommend, type Reason, type Suggestion } from '../domain/recommend';
import type { DeckCombos } from '../domain/deckCheck';
import type { Card, Deck } from '../domain/types';
import { ColorPips } from './mana';
import { hoverPreview } from './wide';

/**
 * Vorschläge aus der eigenen Sammlung (PLAN.md M22): Karten, die du besitzt und die ins
 * Deck passen — gruppiert nach dem wichtigsten Grund, jede mit Begründung und „+ Deck".
 */
const GROUPS: { kind: Reason; title: string; note: string }[] = [
  { kind: 'kombo', title: 'Schließt eine Kombo', note: 'Dir fehlt genau diese Karte — und du hast sie.' },
  { kind: 'rolle', title: 'Füllt eine Lücke', note: 'Bei Rampe, Kartenvorteil, Removal oder Wipes liegt das Deck unter dem Richtwert.' },
  { kind: 'thema', title: 'Passt zum Thema', note: 'Was der Commander verlangt oder viele Karten im Deck tun.' },
];

export function DeckSuggestView({ deck, cards, onAdd, onOpen }: {
  deck: Deck; cards: Map<string, Card>; onAdd: (oracleId: string) => void; onOpen: (oracleId: string) => void;
}) {
  const ownedRows = useLiveQuery(() => db.owned.toArray(), []);
  const ownedIds = useMemo(() => [...new Set((ownedRows ?? []).map((o) => o.oracleId))], [ownedRows]);
  const ownedCards = useLiveQuery(() => getCards(ownedIds), [ownedIds]);
  const features = useLiveQuery(() => catalogFeatures(), []);
  const [combos, setCombos] = useState<DeckCombos | undefined | null>(null);
  useEffect(() => {
    let alive = true;
    void deckCombos(deck, cards, new Set(ownedIds)).catch(() => undefined).then((c) => { if (alive) setCombos(c); });
    return () => { alive = false; };
  }, [deck, cards, ownedIds]);

  const list = useMemo<Suggestion[] | null>(() => {
    if (!ownedCards || !features || combos === null) return null;
    return recommend({
      deck, deckCards: cards, owned: [...ownedCards.values()], almostCombos: combos?.almost, roleTags: features.roles,
    });
  }, [deck, cards, ownedCards, features, combos]);
  const ids = useMemo(() => (list ?? []).map((s) => s.card.oracleId), [list]);
  const imgs = useLiveQuery(() => previewImageIds(ids), [ids]);
  const [added, setAdded] = useState<Set<string>>(new Set());

  if (!list) return <p className="px-1 font-mono text-sm text-muted">Suche in deiner Sammlung…</p>;
  if (list.length === 0) {
    return (
      <p className="rounded-lg bg-surface p-3 font-mono text-sm text-muted">
        Keine passenden Karten in deiner Sammlung gefunden — oder das Deck hat schon alles, was es braucht.
      </p>
    );
  }
  return (
    <div className="space-y-3 font-mono text-xs">
      {GROUPS.map((g) => {
        const rows = list.filter((s) => s.kinds[0] === g.kind);
        if (rows.length === 0) return null;
        return (
          <div key={g.kind} className="rounded-lg bg-surface p-3">
            <h3 className="text-sm">{g.title} <span className="text-xs text-muted">({rows.length})</span></h3>
            <p className="mb-2 text-[10px] text-muted">{g.note}</p>
            <ul className="space-y-2">
              {rows.map((s) => (
                <li key={s.card.oracleId} className="flex items-start gap-2">
                  <span className="mt-0.5"><ColorPips colors={s.card.colorIdentity} /></span>
                  <div className="min-w-0 flex-1">
                    <button onClick={() => onOpen(s.card.oracleId)} {...hoverPreview(imgs?.get(s.card.oracleId), s.card.name)}
                      className="block max-w-full truncate text-left text-sm text-text hover:text-accent">{s.card.name}</button>
                    {s.reasons.map((r) => <p key={r} className="text-muted">{r}</p>)}
                  </div>
                  <button
                    onClick={() => { onAdd(s.card.oracleId); setAdded((a) => new Set(a).add(s.card.oracleId)); }}
                    disabled={added.has(s.card.oracleId)}
                    className="shrink-0 bg-fill/20 px-2 py-1 text-accent hover:bg-fill/40 disabled:opacity-50">
                    {added.has(s.card.oracleId) ? '✓' : '+ Deck'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p className="px-1 text-[10px] text-muted">
        Nur aus deiner Sammlung, passend zu Format und Farben. Kombos von Commander Spellbook, Beliebtheit als
        EDHREC-Rang über Scryfall. Ein Vorschlag, kein Muss.
      </p>
    </div>
  );
}
