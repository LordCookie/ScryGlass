import { useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CardImage } from './CardImage';

/**
 * Vollbild-Oberfläche über der NATIVEN Kamera (ScryCamera-Plugin). Das Kamerabild
 * liegt hinter der transparenten WebView; dieses Overlay hängt per Portal direkt an
 * <body>, der Rest der App ist solange ausgeblendet (html.scan-native, index.css).
 *
 * Feste Leistenhöhen (oben/unten) → der Scan-Rahmen bleibt stehen, auch wenn unten
 * ein Treffer erscheint. Sonst stimmte der native Ausschnitt nicht mehr.
 */

export interface OverlayMatch {
  name: string;
  typeLine: string;
  scryfallId?: string;
  score: number;
  method: string;
}

interface Props {
  reticleRef: RefObject<HTMLDivElement>;
  onTap: (x: number, y: number) => void;
  onClose: () => void;
  blurry: boolean;
  scanning: boolean;
  best?: OverlayMatch;
  onAdd: () => void;
  autoAdd: boolean;
  onToggleAuto: () => void;
  torchAvailable: boolean;
  torchOn: boolean;
  onToggleTorch: () => void;
  basketCount: number;
  toast: string | null;
  onUndoToast: () => void;
  setPicker: ReactNode;
}

const TOP_H = 'h-14';
const BOTTOM_H = 'h-40';

export function NativeScanOverlay(p: Props) {
  const [fx, setFx] = useState<{ x: number; y: number; k: number } | null>(null);

  function tap(e: React.MouseEvent) {
    p.onTap(e.clientX / (window.innerWidth || 1), e.clientY / (window.innerHeight || 1));
    const k = Date.now();
    setFx({ x: e.clientX, y: e.clientY, k });
    window.setTimeout(() => setFx((f) => (f?.k === k ? null : f)), 900);
  }

  const status = p.blurry
    ? 'Unscharf — ruhig halten, Abstand ändern · Tippen stellt scharf'
    : p.best
      ? null
      : p.scanning
        ? 'Lese…'
        : 'Karte in den Rahmen halten';

  return createPortal(
    <div className="scan-overlay fixed inset-0 z-50 font-mono text-sm text-text">
      {/* Kamerafenster mit Rahmen; außen abgedunkelt (box-shadow-Aussparung). */}
      <div className="absolute inset-x-0 top-14 bottom-40" onClick={tap}>
        <div
          ref={p.reticleRef}
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border-2 ${p.blurry ? 'border-warn' : 'border-paper'}`}
          style={{
            // Höhe = Fensterhöhe minus Leisten (3.5rem + 10rem), 12 % Luft für die Statuszeile.
            width: 'min(80vw, calc((100vh - 13.5rem) * 0.7163 * 0.88))',
            aspectRatio: '745 / 1040',
            boxShadow: '0 0 0 9999px rgba(12, 6, 24, 0.55)',
          }}
        />
        {status && (
          <p className="pointer-events-none absolute inset-x-0 bottom-2 px-4 text-center text-xs text-paper drop-shadow">
            {status}
          </p>
        )}
      </div>

      {fx && (
        <span
          className="pointer-events-none fixed z-10 h-12 w-12 -translate-x-1/2 -translate-y-1/2 border-2 border-paper"
          style={{ left: fx.x, top: fx.y }}
        />
      )}

      {/* Obere Leiste */}
      <div className={`absolute inset-x-0 top-0 flex ${TOP_H} items-center gap-2 bg-bg/90 px-3`}>
        <button onClick={p.onClose} aria-label="Scanner schließen" className="px-2 py-1 text-lg text-paper">✕</button>
        <div className="min-w-0 flex-1">{p.setPicker}</div>
        {p.torchAvailable && (
          <button onClick={p.onToggleTorch} aria-pressed={p.torchOn}
            className={`px-2 py-1 text-xs ${p.torchOn ? 'bg-accent text-on-accent' : 'bg-surface text-muted'}`}>
            🔦
          </button>
        )}
        <button onClick={p.onToggleAuto} aria-pressed={p.autoAdd}
          className={`px-2 py-1 text-xs ${p.autoAdd ? 'bg-accent text-on-accent' : 'bg-surface text-muted'}`}>
          Auto
        </button>
      </div>

      {/* Untere Leiste: aktueller Treffer, Rückgängig-Hinweis, Korb */}
      <div className={`absolute inset-x-0 bottom-0 ${BOTTOM_H} bg-bg/95 px-3 py-2`}>
        {p.toast && (
          <div className="mb-1 flex items-center gap-2 bg-ok/15 px-2 py-0.5 text-xs text-ok">
            <span className="min-w-0 flex-1 truncate">✓ {p.toast} in den Korb</span>
            <button onClick={p.onUndoToast} className="shrink-0 px-1 text-paper underline">Rückgängig</button>
          </div>
        )}
        {p.best ? (
          <div className="flex items-center gap-2">
            <CardImage scryfallId={p.best.scryfallId} name={p.best.name} size="small" className="h-20 w-[3.6rem] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-text">{p.best.name}</div>
              <div className="truncate text-[10px] text-muted">{p.best.typeLine}</div>
              <div className="text-[10px] text-muted">
                {p.best.method} · <span className="font-hud text-[9px] text-text">{Math.round(p.best.score * 100)}%</span>
              </div>
            </div>
            <button onClick={p.onAdd} className="shrink-0 bg-accent px-3 py-2 text-on-accent">＋ Korb</button>
          </div>
        ) : (
          <p className="pt-3 text-center text-xs text-muted">Noch kein Treffer.</p>
        )}
        <button onClick={p.onClose} className="absolute bottom-2 right-3 bg-surface px-3 py-1 text-xs text-paper">
          Korb ({p.basketCount}) · Fertig
        </button>
      </div>
    </div>,
    document.body,
  );
}
