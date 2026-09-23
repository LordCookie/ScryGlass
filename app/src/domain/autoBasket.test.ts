import { describe, it, expect } from 'vitest';
import {
  observeFrame, mayAutoAdd, afterAutoAdd, AUTO_BASKET_START, AUTO_BASKET_CHANGE_FRAMES, type AutoBasketState,
} from './autoBasket';

const card = { blurry: false, hasCard: true };
const blur = { blurry: true, hasCard: false };
const empty = { blurry: false, hasCard: false };
const feed = (s: AutoBasketState, frames: { blurry: boolean; hasCard: boolean }[]) =>
  frames.reduce((acc, f) => observeFrame(acc, f), s);

describe('Auto-Korb mit Kartenwechsel-Erkennung', () => {
  it('am Anfang darf jede Karte', () => {
    expect(mayAutoAdd(AUTO_BASKET_START, 'A')).toBe(true);
  });

  it('dieselbe liegende Karte kommt nicht doppelt', () => {
    const s = feed(afterAutoAdd('A'), [card, card, card, card, card]);
    expect(mayAutoAdd(s, 'A')).toBe(false);
  });

  it('eine andere Karte darf sofort', () => {
    expect(mayAutoAdd(afterAutoAdd('A'), 'B')).toBe(true);
  });

  it('Stapel mit gleichen Karten: nach Hand/Unschärfe darf dieselbe Karte wieder', () => {
    const s = feed(afterAutoAdd('A'), [card, blur, blur, empty, card]);
    expect(s.changed).toBe(true);
    expect(mayAutoAdd(s, 'A')).toBe(true);
  });

  it('ein kurzes Fokus-Nachstellen (1–2 unscharfe Bilder) reicht nicht', () => {
    const s = feed(afterAutoAdd('A'), [card, blur, blur, card, card]);
    expect(mayAutoAdd(s, 'A')).toBe(false);
  });

  it('die Wechsel-Bilder müssen am Stück kommen', () => {
    const frames = Array.from({ length: AUTO_BASKET_CHANGE_FRAMES * 2 }, (_, i) => (i % 2 ? card : blur));
    expect(mayAutoAdd(feed(afterAutoAdd('A'), frames), 'A')).toBe(false);
  });

  it('ein erkannter Wechsel bleibt bestehen, bis wieder übernommen wird', () => {
    const s = feed(afterAutoAdd('A'), [empty, empty, empty, card, card, card]);
    expect(mayAutoAdd(s, 'A')).toBe(true);
    expect(mayAutoAdd(afterAutoAdd('A'), 'A')).toBe(false);
  });
});
