import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import QRCode from 'qrcode';
import {
  startReceiver, stopReceiver, receiverState, subscribeReceiver, type ReceiverState,
} from '../peer/peerServer';
import { getDeviceName, setDeviceName } from '../peer/peerStore';
import { listInbox, deleteInbox, setInboxStatus, addOwnedBatch } from '../db/db';
import { getCards } from '../data/cards';
import type { Card, InboxBasket, BasketEntry } from '../domain/types';
import { ColorPips } from './mana';

/**
 * Gemeinsam scannen (PLAN.md § 8). Empfangen = Ein-/Ausschalter (kein globaler
 * Modus). Eingehende Körbe landen im Eingang und werden VOR der Übernahme geprüft
 * — nach Confidence aufsteigend (Verdächtiges oben).
 */

function useReceiver(): ReceiverState {
  return useSyncExternalStore(subscribeReceiver, receiverState, receiverState);
}

export function PeerPanel() {
  const state = useReceiver();
  const [name, setName] = useState('');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const inbox = useLiveQuery(() => listInbox(), []);

  useEffect(() => { void getDeviceName().then(setName); }, []);
  useEffect(() => {
    if (state.qr) void QRCode.toDataURL(state.qr, { width: 220, margin: 1 }).then(setQrUrl).catch(() => setQrUrl(null));
    else setQrUrl(null);
  }, [state.qr]);

  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-surface p-4">
        <h2 className="mb-1 font-mono text-lg">Gemeinsam scannen</h2>
        <p className="mb-3 text-xs text-muted">
          Mehrere Handys im selben WLAN scannen zusammen. Du sammelst hier ein und prüfst,
          bevor etwas in deine Sammlung wandert. Helfer wählen im Scanner dein Gerät als Ziel.
        </p>

        <label className="mb-3 flex items-center gap-2 font-mono text-xs text-muted">
          Gerätename
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void setDeviceName(name)}
            className="flex-1 rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent" />
        </label>

        {!state.running ? (
          <button onClick={() => void startReceiver()} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">
            Empfang starten
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-col items-center gap-2 rounded-md bg-bg p-3">
              {qrUrl && <img src={qrUrl} alt="Pairing-QR" className="rounded bg-white p-1" />}
              <div className="text-center font-mono text-xs text-muted">
                <div>Token: <span className="text-accent">{state.token}</span></div>
                <div className="break-all">{state.url}</div>
              </div>
            </div>
            <button onClick={() => void stopReceiver()} className="rounded border border-border px-3 py-1.5 font-mono text-sm text-muted hover:border-danger hover:text-danger">
              Empfang stoppen
            </button>
          </div>
        )}
        {state.error && <p className="mt-2 font-mono text-xs text-danger">{state.error}</p>}
      </div>

      <div className="rounded-lg bg-surface p-4">
        <h3 className="mb-2 font-mono text-sm">Eingang {inbox && inbox.length > 0 && <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs text-accent">{inbox.length}</span>}</h3>
        {!inbox || inbox.length === 0 ? (
          <p className="font-mono text-sm text-muted">Kein Korb im Eingang.</p>
        ) : (
          <ul className="space-y-2">
            {inbox.map((b) => <InboxRow key={b.basketId} basket={b} />)}
          </ul>
        )}
      </div>
    </section>
  );
}

function InboxRow({ basket }: { basket: InboxBasket }) {
  const [open, setOpen] = useState(false);
  const total = basket.entries.reduce((s, e) => s + e.qty, 0);
  return (
    <li className="rounded-md bg-bg p-2">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left font-mono text-sm">
        <span className="flex-1 truncate">Von „{basket.deviceName}"</span>
        <span className="text-xs text-muted">{total} Karten</span>
        <span className="text-xs text-accent">{open ? '▾' : '▸'}</span>
      </button>
      {open && <InboxReview basket={basket} />}
    </li>
  );
}

function InboxReview({ basket }: { basket: InboxBasket }) {
  const [entries, setEntries] = useState<BasketEntry[]>(
    // aufsteigend nach Confidence — Verdächtiges oben (§ 8)
    [...basket.entries].sort((a, b) => a.confidence - b.confidence),
  );
  const [cards, setCards] = useState<Map<string, Card>>(new Map());
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void getCards(basket.entries.map((e) => e.oracleId)).then(setCards);
  }, [basket]);

  function adjust(entryId: string, delta: number) {
    setEntries((es) => es.map((e) => (e.entryId === entryId ? { ...e, qty: e.qty + delta } : e)).filter((e) => e.qty > 0));
  }

  async function accept() {
    await addOwnedBatch(
      entries.map((e) => ({ oracleId: e.oracleId, finish: e.finish, qty: e.qty, source: 'peer' as const, peerDevice: basket.deviceName })),
    );
    await setInboxStatus(basket.basketId, 'accepted');
    await deleteInbox(basket.basketId);
    setDone(`${entries.reduce((s, e) => s + e.qty, 0)} Karten übernommen.`);
  }

  if (done) return <p className="mt-2 font-mono text-xs text-ok">✓ {done}</p>;

  return (
    <div className="mt-2 space-y-1">
      <ul className="space-y-1">
        {entries.map((e) => {
          const card = cards.get(e.oracleId);
          return (
            <li key={e.entryId} className="flex items-center gap-2 font-mono text-xs">
              <ColorPips colors={card?.colorIdentity ?? []} />
              <button onClick={() => adjust(e.entryId, -1)} className="rounded px-1.5 text-muted hover:bg-white/10">−</button>
              <span className="w-6 text-center text-accent">{e.qty}×</span>
              <button onClick={() => adjust(e.entryId, 1)} className="rounded px-1.5 text-muted hover:bg-white/10">+</button>
              <span className="min-w-0 flex-1 truncate">{card?.name ?? e.oracleId}</span>
              {e.confidence < 0.7 && (
                <span className="text-[10px] text-danger" title={`OCR: „${e.ocrRaw}"`}>
                  ? {Math.round(e.confidence * 100)}%
                </span>
              )}
              <button onClick={() => adjust(e.entryId, -e.qty)} className="rounded px-1.5 text-muted hover:text-danger">✕</button>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2 pt-1">
        <button onClick={() => void accept()} className="rounded bg-accent px-3 py-1 font-mono text-xs text-on-accent">
          In Sammlung übernehmen
        </button>
        <button onClick={() => void deleteInbox(basket.basketId)} className="rounded border border-border px-3 py-1 font-mono text-xs text-muted hover:text-danger">
          Verwerfen
        </button>
      </div>
    </div>
  );
}
