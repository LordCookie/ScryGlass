import { useEffect, useState, useSyncExternalStore } from 'react';
import { CardImage } from './CardImage';

/**
 * Breites Layout (PLAN.md M18): ab 1024 px Navigation links, mehr Spalten, Detail als
 * Seitenleiste; ab 1440 px drei Spalten im Deck-Editor. Hängt an der Fensterbreite, nicht
 * am Big Screen — ein Tablet mit der App bekommt es genauso.
 */

export type Width = 'narrow' | 'wide' | 'xwide';

const WIDE = '(min-width: 1024px)';
const XWIDE = '(min-width: 1440px)';

function current(): Width {
  if (typeof window === 'undefined' || !window.matchMedia) return 'narrow';
  if (window.matchMedia(XWIDE).matches) return 'xwide';
  return window.matchMedia(WIDE).matches ? 'wide' : 'narrow';
}

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const a = window.matchMedia(WIDE);
  const b = window.matchMedia(XWIDE);
  a.addEventListener('change', cb);
  b.addEventListener('change', cb);
  return () => {
    a.removeEventListener('change', cb);
    b.removeEventListener('change', cb);
  };
}

export function useWidth(): Width {
  return useSyncExternalStore(subscribe, current, () => 'narrow' as Width);
}

// --- Kartenbild bei Mausüber (nur breit und mit Maus) -----------------------------

type Preview = { id?: string; name?: string; x: number; y: number } | null;
let setPreview: ((p: Preview) => void) | null = null;

function canHover(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(`(hover: hover) and ${WIDE}`).matches;
}

/** Props für eine Listenzeile: zeigt neben der Maus das Kartenbild (reine Vorschau, kein Effekt). */
export function hoverPreview(scryfallId: string | undefined, name?: string) {
  return {
    onMouseEnter: (e: React.MouseEvent) => { if (canHover()) setPreview?.({ id: scryfallId, name, x: e.clientX, y: e.clientY }); },
    onMouseMove: (e: React.MouseEvent) => { if (canHover()) setPreview?.({ id: scryfallId, name, x: e.clientX, y: e.clientY }); },
    onMouseLeave: () => setPreview?.(null),
  };
}

export function HoverPreviewHost() {
  const [p, setP] = useState<Preview>(null);
  useEffect(() => {
    setPreview = setP;
    return () => { setPreview = null; };
  }, []);
  if (!p?.id) return null;
  const w = 224;
  const h = 312;
  const left = p.x + 24 + w > window.innerWidth ? p.x - 24 - w : p.x + 24;
  const top = Math.max(8, Math.min(p.y - h / 3, window.innerHeight - h - 8));
  return (
    <div className="pointer-events-none fixed z-[70]" style={{ left, top, width: w }}>
      <CardImage scryfallId={p.id} name={p.name} size="normal" className="h-auto w-full" />
    </div>
  );
}

// --- Tastatur ----------------------------------------------------------------------

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** `/` springt in die Suche der aktuellen Ansicht (Feld mit `data-hotkey="search"`). */
export function useSearchHotkey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const el = [...document.querySelectorAll<HTMLInputElement>('[data-hotkey="search"]')].find((x) => x.offsetParent !== null);
      if (!el) return;
      e.preventDefault();
      el.focus();
      el.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export { typing as isTypingTarget };
