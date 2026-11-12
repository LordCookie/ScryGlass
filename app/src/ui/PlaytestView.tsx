import { useMemo, useRef, useState } from 'react';
import {
  makeRng, newGame, mulligan, putOnBottom, nextTurn, drawCard, toggleTable, libraryOf,
  landDistribution, chanceByTurn, HAND_SIZE, type PlayCard, type PlayState,
} from '../domain/playtest';
import { isLand } from '../domain/deckStats';
import { commanderIds, type Card, type Deck } from '../domain/types';
import { CardImage } from './CardImage';
import { PixelCheckbox } from './PixelCheckbox';
import { useBackHandler } from './backStack';
import { hapticTap } from '../native/feedback';

/**
 * „Deck testen" (PLAN.md M20): Probehand ziehen, Mulligan, Züge durchspielen. Im
 * Querformat liegt die Hand in einer Reihe über die ganze Breite (Tailwind `landscape:`),
 * ohne Hinweis — wer das Handy dreht, bekommt es einfach.
 */

const pct = (p: number) => `${Math.round(p * 100)} %`;
const TURNS = [1, 2, 3, 4, 5, 6] as const;

export function PlaytestView({ deck, cards, imgs, onClose }: {
  deck: Deck; cards: Map<string, Card>; imgs: Map<string, string>; onClose: () => void;
}) {
  useBackHandler(true, onClose);
  const rng = useRef(makeRng(Date.now()));
  const leads = deck.format === 'commander' || deck.format === 'brawl';
  const start = (onDraw: boolean) => newGame(deck.cards, rng.current, { onDraw, freeMulligan: leads });
  const [s, setS] = useState<PlayState>(() => start(false));
  const act = (fn: (st: PlayState) => PlayState) => {
    hapticTap();
    setS(fn);
  };

  const library = useMemo(() => libraryOf(deck.cards), [deck.cards]);
  const landCount = useMemo(() => library.filter((c) => { const card = cards.get(c.oracleId); return card ? isLand(card) : false; }).length, [library, cards]);
  const dist = useMemo(() => landDistribution(library.length, landCount), [library.length, landCount]);
  const handLands = s.hand.filter((c) => { const card = cards.get(c.oracleId); return card ? isLand(card) : false; }).length;
  const okRange = dist.slice(2, 5).reduce((a, b) => a + b, 0);
  const maxDist = Math.max(...dist, 0.0001);

  const options = useMemo(() => deck.cards
    .map((c) => ({ id: c.oracleId, qty: c.qty, name: cards.get(c.oracleId)?.name ?? c.oracleId }))
    .sort((a, b) => a.name.localeCompare(b.name)), [deck.cards, cards]);
  const [pick, setPick] = useState<string>('');
  const picked = options.find((o) => o.id === pick);

  const tile = (c: PlayCard, onTap: () => void, mark = false) => {
    const card = cards.get(c.oracleId);
    return (
      <button key={c.uid} onClick={onTap} title={card?.name}
        className={`relative block min-w-0 landscape:max-w-[11rem] landscape:flex-1 ${mark ? 'outline outline-2 outline-offset-1 outline-paper' : ''}`}>
        <CardImage scryfallId={imgs.get(c.oracleId)} name={card?.name} size="normal" className="h-auto w-full" />
      </button>
    );
  };

  const cmds = leads ? commanderIds(deck) : [];

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-bg font-mono text-text">
      <div className="mx-auto max-w-6xl space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg">Deck testen</h2>
          <span className="order-last w-full font-hud text-[9px] text-muted sm:order-none sm:w-auto">
            {s.turn === 0 ? 'STARTHAND' : `ZUG ${s.turn}`} · BIBLIOTHEK {s.library.length}
            {s.mulligans > 0 ? ` · MULLIGAN ${s.mulligans}` : ''}
          </span>
          <button onClick={onClose} aria-label="Schließen" className="px-2 py-1 text-muted hover:text-text">✕</button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button onClick={() => act((st) => nextTurn(st))} disabled={s.toBottom > 0}
            className="rounded bg-accent px-3 py-1.5 text-on-accent disabled:opacity-40">
            {s.turn === 0 ? 'Behalten · Zug 1' : `Zug ${s.turn + 1}`}
          </button>
          <button onClick={() => act(drawCard)} disabled={s.toBottom > 0 || s.library.length === 0}
            className="rounded bg-surface px-3 py-1.5 text-muted hover:text-text disabled:opacity-40">Karte ziehen</button>
          <button onClick={() => act((st) => mulligan(st, rng.current))}
            className="rounded bg-surface px-3 py-1.5 text-muted hover:text-text">Mulligan</button>
          <button onClick={() => act((st) => start(st.onDraw))}
            className="rounded bg-surface px-3 py-1.5 text-muted hover:text-text">Neu mischen</button>
          <PixelCheckbox checked={s.onDraw} onChange={(onDraw) => setS((st) => ({ ...st, onDraw }))} className="text-xs text-muted">
            Auf dem Draw
          </PixelCheckbox>
        </div>

        {s.toBottom > 0 && (
          <p className="bg-surface p-2 text-xs text-paper">
            Noch {s.toBottom === 1 ? 'eine Karte' : `${s.toBottom} Karten`} unter die Bibliothek legen — Karte antippen.
          </p>
        )}

        <div>
          <h3 className="mb-1 font-hud text-[9px] text-muted">HAND ({s.hand.length}) · {handLands} {handLands === 1 ? 'LAND' : 'LÄNDER'}</h3>
          {s.hand.length === 0 ? <p className="text-xs text-muted">Keine Karten auf der Hand.</p> : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-7 landscape:flex landscape:gap-1.5">
              {s.hand.map((c) => tile(c, () => act((st) => (st.toBottom > 0 ? putOnBottom(st, c.uid) : toggleTable(st, c.uid))), s.toBottom > 0))}
            </div>
          )}
          {s.toBottom === 0 && s.hand.length > 0 && <p className="mt-1 text-[10px] text-muted">Antippen legt die Karte auf den Tisch.</p>}
        </div>

        {(s.table.length > 0 || cmds.length > 0) && (
          <div className="grid gap-3 landscape:grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)]">
            {cmds.length > 0 && (
              <div>
                <h3 className="mb-1 font-hud text-[9px] text-muted">BEFEHLSZONE</h3>
                <div className="flex gap-1.5">
                  {cmds.map((id) => (
                    <CardImage key={id} scryfallId={imgs.get(id)} name={cards.get(id)?.name} size="normal" className="h-auto w-20" />
                  ))}
                </div>
              </div>
            )}
            {s.table.length > 0 && (
              <div className="min-w-0">
                <h3 className="mb-1 font-hud text-[9px] text-muted">TISCH ({s.table.length})</h3>
                <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 landscape:grid-cols-10">
                  {s.table.map((c) => tile(c, () => act((st) => toggleTable(st, c.uid))))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-surface p-3 text-xs">
            <h3 className="mb-2 text-sm">Länder in der Starthand</h3>
            <div className="flex gap-1">
              {dist.map((p, i) => (
                <div key={i} className="flex flex-1 flex-col items-center">
                  <div className="flex w-full items-end" style={{ height: 56 }}>
                    <div className={`w-full ${s.turn === 0 && i === handLands && s.hand.length === HAND_SIZE ? 'bg-paper' : 'bg-accent'}`}
                      style={{ height: `${(p / maxDist) * 56}px` }} />
                  </div>
                  <span className="mt-1 text-muted">{i}</span>
                  <span className="text-[9px] text-muted">{p >= 0.005 ? pct(p) : ''}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-muted">
              {landCount} Länder in {library.length} Karten · 2–4 Länder in 7 Karten: <span className="text-text">{pct(okRange)}</span>
            </p>
          </div>

          <div className="rounded-lg bg-surface p-3 text-xs">
            <h3 className="mb-2 text-sm">Karte bis Zug …</h3>
            <select value={pick} onChange={(e) => setPick(e.target.value)}
              className="mb-2 w-full border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper">
              <option value="">Karte wählen…</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name}{o.qty > 1 ? ` (${o.qty}×)` : ''}</option>)}
            </select>
            {picked ? (
              <div className="grid grid-cols-6 gap-1 text-center">
                {TURNS.map((t) => (
                  <div key={t} className="bg-bg p-1">
                    <div className="font-hud text-[8px] text-muted">ZUG {t}</div>
                    <div className="text-text">{pct(chanceByTurn(library.length, picked.qty, t, s.onDraw))}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted">Wie wahrscheinlich eine Karte bis zu einem Zug auf der Hand ist (ohne Mulligan, {s.onDraw ? 'auf dem Draw' : 'auf dem Play'}).</p>
            )}
          </div>
        </div>
        {leads && <p className="text-[10px] text-muted">Commander liegen in der Befehlszone. Der erste Mulligan ist frei.</p>}
      </div>
    </div>
  );
}
