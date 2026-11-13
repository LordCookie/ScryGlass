import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, whereAnyOf } from '../db/db';
import { getCards, previewImageIds } from '../data/cards';
import { setProgressFor } from '../data/setProgress';
import { getSetList } from '../data/nextSet';
import { loadTokenCatalog } from '../data/tokenCatalog';
import { POCKETS, pageCount, setChecklist, sortBinder, type BinderSort } from '../domain/binder';
import { isTokenCard } from '../domain/tokens';
import type { Card, Owned } from '../domain/types';
import { CardImage } from './CardImage';
import { CardDetail } from './CardDetail';
import { PixelCheckbox } from './PixelCheckbox';
import { useWidth, isTypingTarget } from './wide';

/**
 * Sammelordner (PLAN.md M22), Reiter unter Sammlung: 9er-Seiten zum Blättern (Pfeile,
 * ←/→, Wischen); im breiten Layout aufgeschlagen mit zwei Seiten. Entweder die eigene
 * Sammlung oder die Checkliste eines Sets — fehlende Karten ausgegraut.
 */

interface Pocket {
  key: string;
  oracleId: string;
  printingId?: string;
  scryfallId?: string;
  name: string;
  qty?: number;
  missing?: boolean;
}

type Mode = 'sammlung' | 'set';

export function BinderView() {
  const width = useWidth();
  const perPage = width === 'narrow' ? POCKETS : POCKETS * 2;
  const [mode, setMode] = useState<Mode>('sammlung');
  const [sort, setSort] = useState<BinderSort>('set');
  const [setCode, setSetCode] = useState<string>('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<{ oracleId: string; printingId?: string } | null>(null);

  const owned = useLiveQuery(() => db.owned.toArray(), []);
  const ownedIds = useMemo(() => [...new Set((owned ?? []).map((o) => o.oracleId))], [owned]);

  // --- Eigene Sammlung ---
  const collection = useLiveQuery(async () => {
    if (!owned) return null;
    const cards = await getCards(ownedIds);
    const rows = owned.filter((o) => { const c = cards.get(o.oracleId); return c && !isTokenCard(c); });
    const preview = await previewImageIds(rows.filter((o) => !o.printingId).map((o) => o.oracleId));
    const sids = rows.map((o) => o.printingId ?? preview.get(o.oracleId));
    const prints = await db.printings.bulkGet(sids.filter((s): s is string => !!s));
    const printBy = new Map(prints.filter((p) => !!p).map((p) => [p!.scryfallId, p!]));
    return sortBinder(rows.map((o: Owned, i) => {
      const card = cards.get(o.oracleId) as Card;
      const p = sids[i] ? printBy.get(sids[i]!) : undefined;
      return {
        card,
        set: p?.set,
        collectorNumber: p?.collectorNumber,
        pocket: {
          key: `${o.oracleId}-${o.finish}-${o.printingId ?? ''}`,
          oracleId: o.oracleId, printingId: o.printingId, scryfallId: sids[i], name: card.name, qty: o.qty,
        } satisfies Pocket,
      };
    }), sort).map((x): Pocket => x.pocket);
  }, [owned, ownedIds, sort]);

  // --- Set-Checkliste ---
  const sets = useLiveQuery(async () => {
    const [progress, list] = await Promise.all([setProgressFor(ownedIds), getSetList()]);
    const names = new Map(list.map((s) => [s.code, s.name]));
    return progress.map((p) => ({ ...p, name: names.get(p.set) }));
  }, [ownedIds]);
  useEffect(() => {
    if (!setCode && sets && sets.length) setSetCode(sets[0].set);
  }, [sets, setCode]);
  const checklist = useLiveQuery(async () => {
    if (mode !== 'set' || !setCode) return null;
    const [prints, tokens] = await Promise.all([whereAnyOf(db.printings, 'set', [setCode]), loadTokenCatalog()]);
    const chosen = new Map((owned ?? []).filter((o) => o.printingId).map((o) => [o.oracleId, o.printingId!]));
    const entries = setChecklist(prints, new Set(ownedIds), tokens.oracleIds, chosen);
    const cards = await getCards(entries.map((e) => e.oracleId));
    return entries.map((e): Pocket => ({
      key: e.oracleId, oracleId: e.oracleId, scryfallId: e.scryfallId, printingId: e.scryfallId,
      name: cards.get(e.oracleId)?.name ?? e.collectorNumber, missing: !e.owned,
    }));
  }, [mode, setCode, owned, ownedIds]);

  const all: Pocket[] = (mode === 'set' ? checklist : collection) ?? [];
  const pockets = mode === 'set' && onlyMissing ? all.filter((p) => p.missing) : all;
  const pages = pageCount(pockets.length, perPage);
  useEffect(() => { setPage(0); }, [mode, setCode, sort, onlyMissing, perPage]);
  const at = Math.min(page, pages - 1);
  const flip = (d: number) => setPage((p) => Math.max(0, Math.min(pages - 1, p + d)));

  // ←/→ blättern, solange kein Eingabefeld und kein Kartendetail offen ist.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (detail || isTypingTarget(e.target)) return;
      if (e.key === 'ArrowRight') flip(1);
      else if (e.key === 'ArrowLeft') flip(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // Wischen
  const startX = useRef<number | null>(null);

  const shown = pockets.slice(at * perPage, at * perPage + perPage);
  const sheets = width === 'narrow' ? [shown] : [shown.slice(0, POCKETS), shown.slice(POCKETS)];
  const have = mode === 'set' ? all.filter((p) => !p.missing).length : 0;
  const current = sets?.find((s) => s.set === setCode);

  return (
    <div className="space-y-3 font-mono">
      <div className="rounded-lg bg-surface p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          {(['sammlung', 'set'] as Mode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m}
              className={`px-3 py-1 ${mode === m ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
              {m === 'sammlung' ? 'Meine Sammlung' : 'Set-Checkliste'}
            </button>
          ))}
          {mode === 'sammlung' ? (
            <label className="ml-auto flex items-center gap-1 text-muted">
              Sortieren
              <select value={sort} onChange={(e) => setSort(e.target.value as BinderSort)}
                className="border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper">
                <option value="set">Set &amp; Nummer</option>
                <option value="farbe">Farbe</option>
                <option value="name">Name</option>
              </select>
            </label>
          ) : (
            <select value={setCode} onChange={(e) => setSetCode(e.target.value)} aria-label="Set"
              className="ml-auto max-w-full border-2 border-border bg-bg px-2 py-1 text-text outline-none focus:border-paper">
              {(sets ?? []).map((s) => (
                <option key={s.set} value={s.set}>{s.set.toUpperCase()}{s.name ? ` · ${s.name}` : ''} ({s.have}/{s.total})</option>
              ))}
            </select>
          )}
        </div>
        {mode === 'set' && current && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-text">{have} / {all.length} Karten</span>
            <span className={all.length - have > 0 ? 'text-danger' : 'text-ok'}>
              {all.length - have > 0 ? `${all.length - have} fehlen dir` : 'Set komplett!'}
            </span>
            <PixelCheckbox checked={onlyMissing} onChange={setOnlyMissing} className="ml-auto text-muted">nur fehlende</PixelCheckbox>
          </div>
        )}
        {mode === 'set' && sets && sets.length === 0 && <p className="mt-2 text-muted">Noch keine Karten in der Sammlung.</p>}
      </div>

      <div
        onPointerDown={(e) => { startX.current = e.clientX; }}
        onPointerUp={(e) => {
          if (startX.current == null) return;
          const dx = e.clientX - startX.current;
          startX.current = null;
          if (Math.abs(dx) > 60) flip(dx < 0 ? 1 : -1);
        }}
        className="flex flex-col items-center gap-3 lg:flex-row lg:items-start lg:justify-center"
      >
        {/* Eine Doppelseite soll ganz auf den Bildschirm passen (Big Screen). */}
        {sheets.map((sheet, i) => (
          <div key={i} className="frame w-full max-w-md bg-elevated p-2 lg:max-w-[calc((100vh_-_15rem)/1.45)]">
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: POCKETS }, (_, k) => {
                const p = sheet[k];
                return (
                  <div key={k} className="aspect-[5/7] border-2 border-border bg-bg/60">
                    {p && (
                      <button onClick={() => setDetail({ oracleId: p.oracleId, printingId: p.printingId })} title={p.name}
                        className="relative block h-full w-full">
                        <CardImage scryfallId={p.scryfallId} name={p.name} size="normal"
                          className={`h-full w-full ${p.missing ? 'opacity-35 grayscale' : ''}`} />
                        {p.qty != null && p.qty > 1 && (
                          <span className="absolute right-0 top-0 bg-titlebar px-1 font-hud text-[9px] text-paper">{p.qty}</span>
                        )}
                        {p.missing && <span className="absolute bottom-0 left-0 bg-bg px-1 text-[9px] text-danger">fehlt</span>}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-center gap-3 text-sm">
        <button onClick={() => flip(-1)} disabled={at === 0} aria-label="Seite zurück"
          className="bg-surface px-3 py-1.5 text-muted hover:text-text disabled:opacity-30">‹</button>
        <span className="font-hud text-[10px] text-muted">
          SEITE {width === 'narrow' ? at + 1 : `${at * 2 + 1}–${at * 2 + 2}`} / {width === 'narrow' ? pages : pages * 2}
        </span>
        <button onClick={() => flip(1)} disabled={at >= pages - 1} aria-label="Seite vor"
          className="bg-surface px-3 py-1.5 text-muted hover:text-text disabled:opacity-30">›</button>
      </div>

      {detail && <CardDetail oracleId={detail.oracleId} printingId={detail.printingId} onClose={() => setDetail(null)} />}
    </div>
  );
}
