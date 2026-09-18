import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, addOwned } from '../db/db';
import { getCard, previewPrinting } from '../data/cards';
import { LEGALITY_FORMATS, FORMAT_LABELS, isLegal, type Card, type Finish, type Owned } from '../domain/types';
import { CardImage } from './CardImage';
import { ManaCost, ColorPips } from './mana';

/**
 * Kartendetail als Pixel-Sheet (Feedback-Wunsch): großes Kartenbild, Regeltext/
 * Effekte, Manakosten, Typ, Formatlegalität und der eigene Bestand je Ausführung
 * (mit −/+). Overlay über der Sammlung; schließen per Backdrop, ✕ oder Escape.
 */
export function CardDetail({ oracleId, onClose }: { oracleId: string; onClose: () => void }) {
  const [card, setCard] = useState<Card | null>(null);
  const [scryfallId, setScryfallId] = useState<string | undefined>();
  const owned = useLiveQuery<Owned[]>(
    () => db.owned.where('oracleId').equals(oracleId).toArray(),
    [oracleId],
  );

  useEffect(() => {
    let alive = true;
    void getCard(oracleId).then((c) => alive && setCard(c ?? null));
    void previewPrinting(oracleId).then((p) => alive && setScryfallId(p?.scryfallId));
    return () => { alive = false; };
  }, [oracleId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const legal = card ? LEGALITY_FORMATS.filter((f) => isLegal(card.legalities, f)) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-bg/80 p-3 sm:items-center"
      onClick={onClose}
    >
      <div
        className="frame max-h-[92vh] w-full max-w-md overflow-y-auto bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="titlebar sticky top-0 z-10">
          <span className="min-w-0 flex-1 truncate text-text">{card?.name ?? '…'}</span>
          {card && <ManaCost cost={card.manaCost} />}
          <button onClick={onClose} aria-label="Schließen" className="ml-1 px-2 text-paper hover:text-danger">✕</button>
        </div>

        {card && (
          <div className="space-y-3 p-3 font-mono text-sm">
            <div className="flex gap-3">
              <CardImage scryfallId={scryfallId} name={card.name} size="normal" className="h-auto w-32 shrink-0" />
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
