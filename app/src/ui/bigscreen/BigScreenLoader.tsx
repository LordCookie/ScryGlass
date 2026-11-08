import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { db } from '../../db/db';
import type { SyncProgress } from '../../data/catalog';

/**
 * DESIGN.md A10 — „Der Katalog kommt von deinem Handy". Zwei große Kartenrahmen; Karten
 * fliegen vom Handy in den Browser und drehen sich beim Landen um. Auf ihnen echte Namen
 * aus dem laufenden Import. Das Tempo folgt dem echten Fortschritt: hängt das WLAN, bleiben
 * die Karten liegen. Nur aus den Primitiven Stapeln, Flip, Foil-Sweep, Tick.
 */

export type LoadStep =
  | { phase: 'katalog'; progress: SyncProgress | null }
  | { phase: 'extras'; done: number; total: number }
  | { phase: 'sammlung' }
  | { phase: 'fertig' };

const PIPS = ['Karten', 'Druckausgaben', 'Namen', 'Kombos & Fertigdecks', 'Sammlung & Decks'];
const CATALOG_PIP: Record<SyncProgress['phase'], number> = { cards: 0, printings: 1, names: 2 };
const nf = new Intl.NumberFormat('de-DE');
/** Eine fliegende Karte je so vielen importierten Zeilen, höchstens 8 je Sekunde. */
const ROWS_PER_CARD = 1000;
const MAX_FPS = 8;

interface Flyer {
  id: number;
  name: string;
}

function pipIndex(step: LoadStep): number {
  if (step.phase === 'katalog') return step.progress ? CATALOG_PIP[step.progress.phase] : 0;
  if (step.phase === 'extras') return 3;
  if (step.phase === 'sammlung') return 4;
  return 5;
}

function counter(step: LoadStep): number {
  if (step.phase === 'katalog') return step.progress?.overallDone ?? 0;
  if (step.phase === 'extras') return step.done;
  return 0;
}

/** Echte Kartennamen aus der eigenen Datenbank, während sie sich füllt (höchstens 3 je Sekunde). */
function useLiveNames(active: boolean): string {
  const [name, setName] = useState('');
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const t = window.setInterval(async () => {
      const n = await db.cards.count().catch(() => 0);
      if (!n || !alive) return;
      const c = await db.cards.offset(Math.floor(Math.random() * n)).first().catch(() => undefined);
      if (c && alive && c.layout !== 'token') setName(c.name);
    }, 340);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [active]);
  return name;
}

export function BigScreenLoader({ step, device, error, onRetry }: {
  step: LoadStep;
  device: string;
  error?: string | null;
  onRetry?: () => void;
}) {
  const done = step.phase === 'fertig';
  const idx = pipIndex(step);
  const name = useLiveNames(!done && !error);
  const [flyers, setFlyers] = useState<Flyer[]>([]);
  const [landed, setLanded] = useState(0);
  const pending = useRef(0);
  const lastCount = useRef(0);
  const nameRef = useRef(name);
  nameRef.current = name;
  const nextId = useRef(1);

  // Fortschritt → Karten in die Warteschlange (eine je ROWS_PER_CARD Zeilen).
  const count = counter(step);
  useEffect(() => {
    if (count < lastCount.current) lastCount.current = 0; // neue Phase
    const add = Math.floor(count / ROWS_PER_CARD) - Math.floor(lastCount.current / ROWS_PER_CARD);
    if (add > 0) pending.current = Math.min(pending.current + add, 24);
    lastCount.current = count;
    // Kleine Phasen (Sammlung) bekommen wenigstens eine Karte.
    if (step.phase === 'sammlung' && pending.current === 0) pending.current = 1;
  }, [count, step.phase]);

  // Takt: höchstens MAX_FPS Karten je Sekunde starten.
  useEffect(() => {
    if (error) return;
    const t = window.setInterval(() => {
      if (pending.current <= 0) return;
      pending.current--;
      const id = nextId.current++;
      setFlyers((f) => [...f.slice(-10), { id, name: nameRef.current }]);
    }, 1000 / MAX_FPS);
    return () => window.clearInterval(t);
  }, [error]);

  // Strecke zwischen den beiden Stapeln messen (für --fly-x).
  const box = useRef<HTMLDivElement>(null);
  const from = useRef<HTMLDivElement>(null);
  const to = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState({ x: 40, y: 74, dx: 240 });
  useLayoutEffect(() => {
    const measure = () => {
      if (!box.current || !from.current || !to.current) return;
      const b = box.current.getBoundingClientRect();
      const f = from.current.getBoundingClientRect();
      const t = to.current.getBoundingClientRect();
      setGeo({ x: f.left - b.left, y: f.top - b.top, dx: t.left - f.left });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const pct = step.phase === 'katalog' && step.progress
    ? Math.min(100, Math.round((step.progress.overallDone / Math.max(1, step.progress.overallTotal)) * 100))
    : step.phase === 'extras' ? Math.min(100, Math.round((step.done / Math.max(1, step.total)) * 100))
    : step.phase === 'sammlung' ? 50 : 100;
  const stack = Math.min(14, landed);

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-8">
      <h1 className="mb-8 font-hud text-lg">
        <span className="text-muted">Scry</span><span className="text-paper">Glass</span>
        <span className="ml-3 font-mono text-xs text-muted">Big Screen</span>
      </h1>

      <div ref={box} className="relative flex w-full max-w-3xl items-stretch justify-between gap-6">
        {/* Handy: unordentlicher Haufen */}
        <div className="frame w-[45%] bg-surface">
          <div className="titlebar"><span className="truncate text-text">Dein Handy</span></div>
          <div className="relative h-48 p-4">
            <div ref={from} className="absolute left-6 top-10 h-[88px] w-16">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="dither absolute h-[88px] w-16 border-2 border-fill bg-elevated"
                  style={{ left: (i * 7) % 13, top: (i * 5) % 11, opacity: 1 }} />
              ))}
            </div>
            <p className="absolute bottom-2 right-3 max-w-[60%] truncate font-mono text-[10px] text-muted">{device}</p>
          </div>
        </div>

        {/* Dieser Browser: ordentlicher Stapel, wächst */}
        <div className="frame w-[45%] bg-surface">
          <div className="titlebar"><span className="truncate text-text">Dieser Browser</span></div>
          <div className="relative h-48 p-4">
            <div ref={to} className={`absolute left-6 top-10 h-[88px] w-16 ${done ? 'bs-settle' : ''}`}>
              {Array.from({ length: stack }, (_, i) => (
                <div key={i} className="absolute h-[88px] w-16 border-2 border-fill bg-surface"
                  style={{ left: i * 2, top: -i * 2 }} />
              ))}
            </div>
            <p className="absolute bottom-2 right-3 max-w-[70%] truncate text-right font-mono text-[10px] text-text">{name}</p>
          </div>
        </div>

        {/* Fliegende Karten (Stapeln + Flip), Name drauf */}
        <div className="pointer-events-none absolute inset-0">
          {flyers.map((f) => (
            <div key={f.id}
              className="bs-fly absolute flex h-[88px] w-16 flex-col border-2 border-paper bg-elevated"
              style={{
                left: geo.x,
                top: geo.y,
                ['--fly-x' as string]: `${geo.dx}px`,
                ['--fly-y' as string]: '-36px',
              }}
              onAnimationEnd={() => {
                setFlyers((all) => all.filter((x) => x.id !== f.id));
                setLanded((n) => n + 1);
              }}>
              <span className="truncate bg-titlebar px-1 font-mono text-[7px] leading-3 text-paper">{f.name || '…'}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="frame mt-8 w-full max-w-3xl bg-surface p-5">
        {/* Fünf Phasen als Pips */}
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          {PIPS.map((label, i) => (
            <span key={label} className="flex items-center gap-2 font-mono text-[11px] text-muted">
              <span className={`pip ${i < idx || done ? 'on' : ''}`}
                style={i === idx && !done ? { borderColor: 'rgb(var(--c-paper))' } : undefined} />
              <span className={i === idx && !done ? 'text-text' : ''}>{label}</span>
            </span>
          ))}
        </div>
        <div className="foil mb-2 w-full bg-elevated"
          style={{ height: 'max(10px, calc(var(--px) * 8))', border: 'calc(var(--px) * 1) solid rgb(var(--c-fill))' }}>
          <div className="h-full bg-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="font-hud text-[10px] text-text">
          {step.phase === 'katalog' && step.progress
            ? `${nf.format(step.progress.overallDone)} / ${nf.format(step.progress.overallTotal)} Karten, Drucke und Namen`
            : step.phase === 'extras'
              ? `${nf.format(step.done)} / ${nf.format(step.total)}`
              : step.phase === 'sammlung' ? 'Sammlung und Decks…' : step.phase === 'fertig' ? 'Fertig.' : '…'}
        </p>
        {error ? (
          <div className="mt-4 font-mono text-sm">
            <p className="text-danger">{error}</p>
            {onRetry && <button onClick={onRetry} className="pxbtn pxbtn-primary mt-3 font-hud text-[10px]">Nochmal</button>}
          </div>
        ) : (
          <p className="mt-4 font-mono text-sm text-muted">
            Der Katalog kommt von deinem Handy, nicht aus dem Internet. Das passiert nur einmal je Katalogstand.
          </p>
        )}
      </div>
    </div>
  );
}
