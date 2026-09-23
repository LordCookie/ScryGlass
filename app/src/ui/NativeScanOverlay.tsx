import { useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CardImage } from './CardImage';
import { hapticTap } from '../native/feedback';
import { PixelIcon } from './PixelIcon';

/**
 * Vollbild-Oberfläche über der NATIVEN Kamera (ScryCamera-Plugin). Das Kamerabild
 * liegt hinter der transparenten WebView; dieses Overlay hängt per Portal direkt an
 * <body>, der Rest der App ist solange ausgeblendet (html.scan-native, index.css).
 *
 * Scan-Rahmen im Pixel-Look (DESIGN § 5): Titel-Balken mit Dither zeigt, wo der
 * Kartenname hingehört; vier Pixelecken melden den Zustand — suchen (pulsiert, A2,
 * dazu eine Scanlinie), sicher erkannt (--ok + Glanz, A3), unsicher/unscharf (--warn,
 * A4); beim Hinzufügen blitzt der Rahmen auf (A6).
 * Modus „qr" (Pairing): quadratischer Rahmen, keine Karten-Bedienelemente.
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
  mode: 'card' | 'qr';
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
  /** zählt bei jeder Übernahme hoch → Rahmen blitzt auf (A6) */
  flashKey: number;
  /** Hinweis im QR-Modus (z. B. „Verbinde…") */
  qrHint?: string | null;
}

const TOP_H = 'h-14';
const BOTTOM_H = 'h-40';
const SURE = 0.85;

type FrameState = 'search' | 'sure' | 'unsure';

/** Vier Pixelecken (L-Form) in der Zustandsfarbe; pulsieren beim Suchen (A2).
 *  Farbe steht mit im Inline-Border — die Kurzschreibweise würde eine Farbklasse sonst
 *  auf currentColor zurücksetzen. */
function Corners({ color, pulse }: { color: 'ok' | 'warn' | 'paper'; pulse: boolean }) {
  const base = `absolute h-4 w-4 ${pulse ? 'reticle-corner' : ''}`;
  const b = `calc(var(--px) * 2) solid rgb(var(--c-${color}))`;
  return (
    <>
      <span className={`${base} left-0 top-0`} style={{ borderLeft: b, borderTop: b }} />
      <span className={`${base} right-0 top-0`} style={{ borderRight: b, borderTop: b }} />
      <span className={`${base} bottom-0 left-0`} style={{ borderLeft: b, borderBottom: b }} />
      <span className={`${base} bottom-0 right-0`} style={{ borderRight: b, borderBottom: b }} />
    </>
  );
}

export function NativeScanOverlay(p: Props) {
  const [fx, setFx] = useState<{ x: number; y: number; k: number } | null>(null);
  const qr = p.mode === 'qr';

  /** Knopf mit leichtem Vibrations-Tick (spürbar, dass der Druck ankam). */
  const withTick = (fn: () => void) => () => {
    hapticTap();
    fn();
  };

  function tap(e: React.MouseEvent) {
    hapticTap();
    p.onTap(e.clientX / (window.innerWidth || 1), e.clientY / (window.innerHeight || 1));
    const k = Date.now();
    setFx({ x: e.clientX, y: e.clientY, k });
    window.setTimeout(() => setFx((f) => (f?.k === k ? null : f)), 900);
  }

  const state: FrameState = p.blurry ? 'unsure' : p.best ? (p.best.score >= SURE ? 'sure' : 'unsure') : 'search';
  const cornerColor = state === 'sure' ? 'ok' : state === 'unsure' ? 'warn' : 'paper';

  const status = qr
    ? (p.qrHint ?? 'QR-Code des Empfängers in den Rahmen halten')
    : p.blurry
      ? 'Unscharf — ruhig halten, Abstand ändern · Tippen stellt scharf'
      : p.best
        ? null
        : p.scanning
          ? 'Lese…'
          : 'Kartenname in den oberen Balken';

  return createPortal(
    <div className="scan-overlay fixed inset-0 z-50 font-mono text-sm text-text">
      {/* Kamerafenster mit Rahmen; außen abgedunkelt (box-shadow-Aussparung). */}
      <div className="absolute inset-x-0 top-14 bottom-40" onClick={tap}>
        <div
          ref={p.reticleRef}
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={
            qr
              ? { width: 'min(70vw, calc((100vh - 13.5rem) * 0.8))', aspectRatio: '1 / 1', boxShadow: '0 0 0 9999px rgb(var(--c-bg) / 0.55)' }
              : {
                  // Höhe = Fensterhöhe minus Leisten (3.5rem + 10rem), 12 % Luft für die Statuszeile.
                  width: 'min(80vw, calc((100vh - 13.5rem) * 0.7163 * 0.88))',
                  aspectRatio: '745 / 1040',
                  boxShadow: '0 0 0 9999px rgb(var(--c-bg) / 0.55)', // folgt dem Farbschema
                }
          }
        >
          {/* Kartenkontur: 1 Design-Pixel, dezent */}
          <div className="absolute inset-0" style={{ border: 'var(--px) solid rgb(var(--c-paper) / 0.35)' }} />

          {!qr && (
            <>
              {/* Titel-Balken: hier gehört der Kartenname hin (Pixelbar, Dither). */}
              <div className="absolute inset-x-0 top-0 h-[13%]">
                <div className="dither absolute inset-0" />
                <span className="absolute left-2 top-1/2 -translate-y-1/2 font-hud text-[7px] text-paper/80">NAME</span>
                <Corners color={cornerColor} pulse={state === 'search'} />
              </div>
              {/* Druckinfo unten links (Sammlernummer) — dezente Dither-Marke. */}
              <div className="absolute bottom-[1.5%] left-[3%] h-[6%] w-[36%]">
                <div className="dither absolute inset-0" style={{ opacity: 0.15 }} />
              </div>
              {/* Suchen: Scanlinie; sicher erkannt: Glanz über den Rahmen. */}
              {state === 'search' && <div className="scan-line" />}
              {state === 'sure' && <div key={p.best?.name} className="foil absolute inset-0" />}
            </>
          )}

          {qr && (
            <>
              <Corners color="paper" pulse />
              <div className="scan-line" />
            </>
          )}

          {/* In den Korb (A6): kurzes Aufblitzen, neu gestartet über den key. */}
          {p.flashKey > 0 && <div key={p.flashKey} className="frame-flash" />}
        </div>
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
        <button onClick={withTick(p.onClose)} aria-label="Scanner schließen" className="px-2 py-1 text-lg text-paper">✕</button>
        <div className="min-w-0 flex-1">
          {qr ? <span className="font-hud text-[9px] text-paper">GERÄT VERBINDEN</span> : p.setPicker}
        </div>
        {p.torchAvailable && (
          <button onClick={withTick(p.onToggleTorch)} aria-pressed={p.torchOn} aria-label="Licht"
            className={`px-2 py-1.5 ${p.torchOn ? 'bg-accent text-on-accent' : 'bg-surface text-muted'}`}>
            <PixelIcon name="torch" />
          </button>
        )}
        {!qr && (
          <button onClick={withTick(p.onToggleAuto)} aria-pressed={p.autoAdd}
            className={`px-2 py-1 text-xs ${p.autoAdd ? 'bg-accent text-on-accent' : 'bg-surface text-muted'}`}>
            Auto-Korb {p.autoAdd ? 'an' : 'aus'}
          </button>
        )}
      </div>

      {/* Untere Leiste: aktueller Treffer, Rückgängig-Hinweis, Korb */}
      <div className={`absolute inset-x-0 bottom-0 ${BOTTOM_H} bg-bg/95 px-3 py-2`}>
        {qr ? (
          <p className="pt-3 text-center text-xs text-muted">
            Auf dem anderen Gerät: Peer → Empfang starten. Dann dessen QR-Code hierher halten.
          </p>
        ) : (
          <>
            {p.toast && (
              <div className="mb-1 flex items-center gap-2 bg-ok/15 px-2 py-0.5 text-xs text-ok">
                <span className="min-w-0 flex-1 truncate">✓ {p.toast} in den Korb</span>
                <button onClick={withTick(p.onUndoToast)} className="shrink-0 px-1 text-paper underline">Rückgängig</button>
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
          </>
        )}
        {/* Fußzeile: Hinweis kürzt sich, statt unter den Knopf zu laufen. */}
        <div className="absolute inset-x-3 bottom-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[10px] text-accent">
            {!qr && p.autoAdd ? 'Auto-Korb an · Karte für Karte hinlegen' : ''}
          </span>
          <button onClick={withTick(p.onClose)} className="shrink-0 bg-surface px-3 py-1 text-xs text-paper">
            {qr ? 'Abbrechen' : `Korb (${p.basketCount}) · Fertig`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
