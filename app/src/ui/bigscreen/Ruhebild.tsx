import { useEffect, useState, useSyncExternalStore } from 'react';
import { bigScreenPhone, wakeFromDim } from '../../bigscreen/phone';

/**
 * Ruhebild am Handy (PLAN.md M18, Wachmodus): schwarz, nur das Nötigste in Pixel-Schrift.
 * Rückt jede Minute ein Stück weiter, damit sich auf OLED nichts einbrennt. Antippen weckt.
 */
export function Ruhebild() {
  const st = useSyncExternalStore(bigScreenPhone.subscribe, () => bigScreenPhone.state);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!st.dimmed) return;
    const t = window.setInterval(() => setStep((s) => s + 1), 60_000);
    return () => window.clearInterval(t);
  }, [st.dimmed]);
  if (!st.dimmed) return null;
  // 5 × 4 Positionen, je ein paar Pixel versetzt
  const dx = ((step * 3) % 5) * 12 - 24;
  const dy = ((step * 2) % 4) * 16 - 24;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black" onPointerDown={wakeFromDim}>
      <div className="text-center font-hud" style={{ transform: `translate(${dx}px, ${dy}px)` }}>
        <p className="text-[11px] text-muted">BIG SCREEN LÄUFT</p>
        <p className="mt-2 text-[9px] text-muted">
          {st.sessions.length === 1 ? '1 BROWSER' : `${st.sessions.length} BROWSER`}
        </p>
        {st.url && <p className="mt-2 text-[9px] text-muted">{st.url.replace('http://', '')}</p>}
        <p className="mt-6 font-mono text-[10px] text-muted/60">Antippen zum Aufwecken</p>
      </div>
    </div>
  );
}
