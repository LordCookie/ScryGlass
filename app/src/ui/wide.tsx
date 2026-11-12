import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

// --- Drag-and-drop (M20, nur mit Maus im breiten Layout) ----------------------------

const DND_TYPE = 'application/x-scryglass-card';
export type DragFrom = 'search' | 'cards' | 'sideboard' | 'commander' | 'partner';
export interface DragCard {
  oracleId: string;
  from: DragFrom;
}

let dragging: DragCard | null = null;
const dragListeners = new Set<() => void>();
function setDragging(c: DragCard | null) {
  dragging = c;
  for (const l of dragListeners) l();
}

/** Wird gerade eine Karte gezogen? (Leere Ablagen nur dann zeigen.) */
export function useDragging(): DragCard | null {
  return useSyncExternalStore(
    (l) => { dragListeners.add(l); return () => { dragListeners.delete(l); }; },
    () => dragging,
    () => null,
  );
}

/** Props zum Ziehen einer Karte — am Handy (ohne Maus) leer. */
export function dragSource(card: DragCard, name?: string) {
  if (!canHover()) return {};
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DND_TYPE, JSON.stringify(card));
      if (name) e.dataTransfer.setData('text/plain', name);
      e.dataTransfer.effectAllowed = card.from === 'search' ? 'copy' : 'move';
      setPreview?.(null);
      setDragging(card);
    },
    onDragEnd: () => setDragging(null),
  };
}

function isCardDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(DND_TYPE);
}

/** Ablage für gezogene Karten; zeigt beim Drüberziehen einen gestrichelten Rand. */
export function DropZone({ onDrop, accept, className = '', children }: {
  onDrop: (c: DragCard) => void;
  accept?: (c: DragCard) => boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const ok = () => !dragging || !accept || accept(dragging);
  return (
    <div
      className={`${className} ${over ? 'outline-dashed outline-2 outline-offset-2 outline-paper' : ''}`}
      onDragEnter={(e) => {
        if (!isCardDrag(e) || !ok()) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!isCardDrag(e) || !ok()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = dragging?.from === 'search' ? 'copy' : 'move';
      }}
      onDragLeave={(e) => {
        if (!isCardDrag(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!isCardDrag(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        setDragging(null);
        try {
          const c = JSON.parse(e.dataTransfer.getData(DND_TYPE)) as DragCard;
          if (typeof c?.oracleId === 'string' && (!accept || accept(c))) onDrop(c);
        } catch {
          /* fremder Inhalt — ignorieren */
        }
      }}
    >
      {children}
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
