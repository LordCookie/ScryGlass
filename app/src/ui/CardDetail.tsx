import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, addOwned } from '../db/db';
import { getCard } from '../data/cards';
import { LEGALITY_FORMATS, FORMAT_LABELS, isLegal, type Card, type Finish, type Owned, type Printing } from '../domain/types';
import { CardImage } from './CardImage';
import { ManaCost, ColorPips } from './mana';

/**
 * Kartendetail als Pixel-Sheet: großes Kartenbild, Regeltext/Effekte, Manakosten,
 * Typ, Formatlegalität und der eigene Bestand je Ausführung (mit −/+).
 *
 * Feature: **Tippen aufs Bild wechselt die Ausgabe/Artwork** (alle Druckausgaben
 * der Karte durchblättern) — mit Set, Sammlernummer, Sprache und Zähler.
 * Overlay über der Sammlung; schließen per Backdrop, ✕ oder Escape.
 */
export function CardDetail({ oracleId, onClose }: { oracleId: string; onClose: () => void }) {
  const [card, setCard] = useState<Card | null>(null);
  const [printings, setPrintings] = useState<Printing[]>([]);
  const [idx, setIdx] = useState(0);
  const owned = useLiveQuery<Owned[]>(
    () => db.owned.where('oracleId').equals(oracleId).toArray(),
    [oracleId],
  );

  useEffect(() => {
    let alive = true;
    void getCard(oracleId).then((c) => alive && setCard(c ?? null));
    void db.printings
      .where('oracleId')
      .equals(oracleId)
      .toArray()
      .then((ps) => {
        if (!alive) return;
        // Sortiert: Set, dann Sammlernummer (numerisch), EN vor DE.
        ps.sort(
          (a, b) =>
            a.set.localeCompare(b.set) ||
            a.collectorNumber.localeCompare(b.collectorNumber, undefined, { numeric: true }) ||
            a.lang.localeCompare(b.lang),
        );
        setPrintings(ps);
        // Start bei der ersten englischen Ausgabe (der „Standard"-Anblick).
        const en = ps.findIndex((p) => p.lang === 'en');
        setIdx(en >= 0 ? en : 0);
      });
    return () => { alive = false; };
  }, [oracleId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, printings.length]);

  function step(delta: number) {
    if (printings.length === 0) return;
    setIdx((i) => (i + delta + printings.length) % printings.length);
  }

  const legal = card ? LEGALITY_FORMATS.filter((f) => isLegal(card.legalities, f)) : [];
  const current = printings[idx];
  const hasMany = printings.length > 1;
  const setLabel = useMemo(
    () => (current ? `${current.set.toUpperCase()} · ${current.collectorNumber} · ${current.lang.toUpperCase()}` : ''),
    [current],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-bg/80 p-3 sm:items-center" onClick={onClose}>
      <div className="frame max-h-[92vh] w-full max-w-md overflow-y-auto bg-surface" onClick={(e) => e.stopPropagation()}>
        <div className="titlebar sticky top-0 z-10">
          <span className="min-w-0 flex-1 truncate text-text">{card?.name ?? '…'}</span>
          {card && <ManaCost cost={card.manaCost} />}
          <button onClick={onClose} aria-label="Schließen" className="ml-1 px-2 text-paper hover:text-danger">✕</button>
        </div>

        {card && (
          <div className="space-y-3 p-3 font-mono text-sm">
            <div className="flex gap-3">
              {/* Bild = Umschalter für die Ausgabe/Artwork */}
              <div className="w-32 shrink-0">
                <button
                  onClick={() => step(1)}
                  disabled={!hasMany}
                  className="relative block w-full"
                  aria-label="Nächste Ausgabe"
                  title={hasMany ? 'Tippen: nächste Ausgabe' : undefined}
                >
                  <CardImage scryfallId={current?.scryfallId} name={card.name} size="normal" className="h-auto w-full" />
                  {hasMany && (
                    <span className="absolute right-0 top-0 bg-titlebar px-1 font-hud text-[8px] text-paper">
                      {idx + 1}/{printings.length}
                    </span>
                  )}
                </button>
                {hasMany && (
                  <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-muted">
                    <button onClick={() => step(-1)} aria-label="Vorherige Ausgabe" className="px-2 text-paper">‹</button>
                    <span className="truncate">{setLabel}</span>
                    <button onClick={() => step(1)} aria-label="Nächste Ausgabe" className="px-2 text-paper">›</button>
                  </div>
                )}
                {hasMany && <p className="mt-1 text-center text-[10px] text-muted">Bild antippen = Artwork wechseln</p>}
                {!hasMany && current && <p className="mt-1 text-center text-[10px] text-muted">{setLabel}</p>}
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <ColorPips colors={card.colorIdentity} />
                  <span className="text-muted">Manawert {card.cmc}</span>
                </div>
                <p className="text-text">{card.typeLine}</p>
                {/* Bestand je Ausführung */}
                <div className="space-y-1">
                  {(['nonfoil', 'foil', 'etched'] as Finish[]).map((f) => {
                    const qty = owned?.find((o) => o.finish === f)?.qty ?? 0;
                    return (
                      <div key={f} className="flex items-center gap-2">
                        <span className="w-14 text-muted">{f === 'nonfoil' ? 'normal' : f}</span>
                        <button onClick={() => void addOwned(oracleId, f, -1)} aria-label="weniger" className="px-2 text-muted hover:text-paper">−</button>
                        <span className="w-8 text-center font-hud text-[10px] text-text">{qty}×</span>
                        <button onClick={() => void addOwned(oracleId, f, 1, { source: 'manual' })} aria-label="mehr" className="px-2 text-muted hover:text-paper">+</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Effekte / Regeltext */}
            {card.oracleText && (
              <div>
                <h4 className="mb-1 font-hud text-[9px] text-muted">EFFEKTE</h4>
                <p className="whitespace-pre-line leading-relaxed text-text">{card.oracleText}</p>
              </div>
            )}

            {/* Formatlegalität */}
            <div>
              <h4 className="mb-1 font-hud text-[9px] text-muted">LEGAL IN</h4>
              {legal.length === 0 ? (
                <p className="text-muted">In keinem der geführten Formate legal.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {legal.map((f) => (
                    <span key={f} className="bg-fill/20 px-2 py-0.5 text-xs text-accent">{FORMAT_LABELS[f]}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
