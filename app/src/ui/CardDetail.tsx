import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, addOwned, setOwnedPrinting } from '../db/db';
import { getCard } from '../data/cards';
import { LEGALITY_FORMATS, FORMAT_LABELS, isLegal, type Card, type Finish, type Owned, type Printing } from '../domain/types';
import { isDoubleFaced, type CardFace } from '../domain/cardFaces';
import { isTokenCard } from '../domain/tokens';
import { formatEur, PRICE_MAX_AGE_MS, type PriceEntry } from '../domain/prices';
import { fetchPrices, priceForPrinting } from '../data/prices';
import { CardImage } from './CardImage';
import { ManaCost, ColorPips } from './mana';
import { useBackHandler } from './backStack';
import { isTypingTarget } from './wide';

/**
 * Kartendetail als Pixel-Sheet: großes Kartenbild, Regeltext/Effekte, Manakosten,
 * Typ, Formatlegalität und der eigene Bestand je Ausführung (mit −/+).
 *
 * Feature: **Tippen aufs Bild wechselt die Ausgabe/Artwork** (alle Druckausgaben
 * der Karte durchblättern) — mit Set, Sammlernummer, Sprache und Zähler.
 * Overlay über der Sammlung; schließen per Backdrop, ✕ oder Escape.
 *
 * Tokens (M14) zählen je Artwork: der Bestand gilt für die GEZEIGTE Ausgabe, Blättern
 * wählt also, welches Artwork man hinzufügt. `printingId` = Startausgabe.
 */
/**
 * Breit (ab 1024 px, M18): Seitenleiste rechts statt bildschirmfüllend — das Raster bleibt
 * sichtbar. ↑/↓ blättern zur vorigen/nächsten Karte (`onPrev`/`onNext`), ←/→ durch die
 * Ausgaben, `+`/`−` ändern die Anzahl (normal), `Esc` schließt.
 */
export function CardDetail({ oracleId, printingId, onClose, onPrev, onNext }: {
  oracleId: string;
  printingId?: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const [card, setCard] = useState<Card | null>(null);
  const [printings, setPrintings] = useState<Printing[]>([]);
  const [idx, setIdx] = useState(0);
  const [face, setFace] = useState<CardFace>('front'); // doppelseitige Karten umdrehen
  const owned = useLiveQuery<Owned[]>(
    () => db.owned.where('oracleId').equals(oracleId).toArray(),
    [oracleId],
  );
  useBackHandler(true, onClose); // Android-Zurück schließt das Detail

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
      });
    return () => { alive = false; };
  }, [oracleId]);

  // Startausgabe EINMAL setzen: gemerkte Ausgabe (owned.printingId), sonst erste EN.
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || printings.length === 0 || owned === undefined) return;
    const savedPid = printingId ?? owned.find((o) => o.printingId)?.printingId;
    let start = savedPid ? printings.findIndex((p) => p.scryfallId === savedPid) : -1;
    if (start < 0) start = printings.findIndex((p) => p.lang === 'en');
    setIdx(start >= 0 ? start : 0);
    inited.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printings, owned]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowDown' && onNext) { e.preventDefault(); onNext(); }
      else if (e.key === 'ArrowUp' && onPrev) { e.preventDefault(); onPrev(); }
      else if (e.key === '+' || e.key === '-') {
        const pid = token ? printings[idx]?.scryfallId : undefined;
        if (token && !pid) return;
        void addOwned(oracleId, 'nonfoil', e.key === '+' ? 1 : -1, { source: 'manual', printingId: pid });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, onPrev, onNext, printings.length, idx, oracleId]);

  function step(delta: number) {
    if (printings.length === 0) return;
    setIdx((i) => {
      const n = (i + delta + printings.length) % printings.length;
      const sid = printings[n]?.scryfallId;
      // Gewählte Ausgabe als „meine" merken → Sammlung/Detail zeigen dieses Artwork.
      // Nicht bei Tokens: deren Bestand IST je Artwork (M14).
      if (sid && owned && owned.length > 0 && !token) void setOwnedPrinting(oracleId, sid);
      return n;
    });
  }

  const token = isTokenCard(card ?? undefined);
  const legal = card ? LEGALITY_FORMATS.filter((f) => isLegal(card.legalities, f)) : [];
  const current = printings[idx];
  // Tokens: Bestand der gezeigten Ausgabe; Karten: Bestand der Karte (je Ausführung).
  const ownedHere = token ? (owned ?? []).filter((o) => o.printingId === current?.scryfallId) : (owned ?? []);
  const tokenTotal = token ? (owned ?? []).reduce((s, o) => s + o.qty, 0) : 0;
  const tokenArts = token ? new Set((owned ?? []).map((o) => o.printingId)).size : 0;
  const hasMany = printings.length > 1;
  const dfc = isDoubleFaced(card?.layout);

  // Preis der gezeigten Ausgabe (kurz verzögert, damit schnelles Blättern keine
  // Anfrageflut auslöst). Ohne Euro-Preis (z. B. deutscher Druck) → Standardpreis.
  const [price, setPrice] = useState<{ entry?: PriceEntry; fallback: boolean } | null>(null);
  const sid = current?.scryfallId;
  useEffect(() => {
    if (!sid) return;
    let alive = true;
    setPrice(null);
    const t = window.setTimeout(() => {
      void (async () => {
        const own = await priceForPrinting(sid, PRICE_MAX_AGE_MS);
        if (own?.eur != null || own?.eurFoil != null) {
          if (alive) setPrice({ entry: own, fallback: false });
          return;
        }
        const key = `oracle:${oracleId}`;
        let std = await db.prices.get(key);
        if (!std || Date.now() - std.at > PRICE_MAX_AGE_MS) {
          try {
            await fetchPrices([{ key, oracleId }]);
          } catch {
            /* offline */
          }
          std = (await db.prices.get(key)) ?? std;
        }
        if (alive) setPrice({ entry: std, fallback: true });
      })();
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [sid, oracleId]);
  const setLabel = useMemo(
    () => (current ? `${current.set.toUpperCase()} · ${current.collectorNumber} · ${current.lang.toUpperCase()}` : ''),
    [current],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-bg/80 p-3 sm:items-center lg:inset-auto lg:bottom-0 lg:right-0 lg:top-0 lg:w-[30rem] lg:items-stretch lg:bg-transparent lg:p-0" onClick={onClose}>
      <div className="frame max-h-[92vh] w-full max-w-md overflow-y-auto bg-surface lg:h-full lg:max-h-none lg:max-w-none" onClick={(e) => e.stopPropagation()}>
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
                  <CardImage
                    key={`${current?.scryfallId}-${face}`}
                    scryfallId={current?.scryfallId}
                    name={card.name}
                    size="normal"
                    face={face}
                    className="h-auto w-full"
                  />
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
                {token && ownedHere.length > 0 && <p className="mt-1 text-center text-[10px] text-ok">✓ dieses Artwork in der Sammlung</p>}
                {!hasMany && current && <p className="mt-1 text-center text-[10px] text-muted">{setLabel}</p>}
                {dfc && (
                  <button
                    onClick={() => setFace((f) => (f === 'front' ? 'back' : 'front'))}
                    className="mt-1 w-full bg-fill/20 px-2 py-1 text-[11px] text-accent hover:bg-fill/40"
                  >
                    ↻ {face === 'front' ? 'Rückseite' : 'Vorderseite'}
                  </button>
                )}
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <ColorPips colors={card.colorIdentity} />
                  <span className="text-muted">{token ? 'Token' : `Manawert ${card.cmc}`}</span>
                </div>
                {/* Preis (Cardmarket via Scryfall) */}
                <p className="text-xs text-muted">
                  {price === null
                    ? 'Preis …'
                    : price.entry?.eur == null && price.entry?.eurFoil == null
                      ? 'Kein Preis bekannt'
                      : <>
                          <span className="text-text">{formatEur(price.entry?.eur)}</span>
                          {price.entry?.eurFoil != null && <> · Foil <span className="text-text">{formatEur(price.entry.eurFoil)}</span></>}
                          {price.fallback && <span className="block text-[10px]">Preis der Standardausgabe</span>}
                        </>}
                </p>
                <p className="text-text">{card.typeLine}</p>
                {/* Bestand je Ausführung (Tokens: dieses Artwork) */}
                <div className="space-y-1">
                  {token && <p className="text-[10px] text-muted">Dieses Artwork:</p>}
                  {(['nonfoil', 'foil', 'etched'] as Finish[]).map((f) => {
                    const qty = ownedHere.find((o) => o.finish === f)?.qty ?? 0;
                    const pid = token ? current?.scryfallId : undefined;
                    return (
                      <div key={f} className="flex items-center gap-2">
                        <span className="w-14 text-muted">{f === 'nonfoil' ? 'normal' : f}</span>
                        <button onClick={() => void addOwned(oracleId, f, -1, { printingId: pid })} disabled={token && !pid}
                          aria-label="weniger" className="px-2 text-muted hover:text-paper">−</button>
                        <span className="w-8 text-center font-hud text-[10px] text-text">{qty}×</span>
                        <button onClick={() => void addOwned(oracleId, f, 1, { source: 'manual', printingId: pid })} disabled={token && !pid}
                          aria-label="mehr" className="px-2 text-muted hover:text-paper">+</button>
                      </div>
                    );
                  })}
                  {token && tokenTotal > 0 && (
                    <p className="text-[10px] text-muted">Gesamt {tokenTotal} in {tokenArts} {tokenArts === 1 ? 'Artwork' : 'Artworks'}</p>
                  )}
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
              {token ? (
                <p className="text-muted">Spielstein — gehört in kein Deck, zählt nur in der Sammlung.</p>
              ) : legal.length === 0 ? (
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
