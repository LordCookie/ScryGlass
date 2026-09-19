import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, saveDeck, deleteDeck, listDecks } from '../db/db';
import { getCards, ownedByOracle } from '../data/cards';
import { searchCards } from '../data/search';
import { normalizeName } from '../domain/nameMatch';
import { validateDeck } from '../domain/deckValidate';
import { computeStats, CURVE_BUCKETS, COLOR_KEYS } from '../domain/deckStats';
import { computeMissing } from '../domain/deckMissing';
import { parseDeckText, serializeDeckText } from '../domain/deckText';
import { LEGALITY_FORMATS, FORMAT_LABELS, type Card, type Deck, type DeckCard, type FormatId } from '../domain/types';
import { ColorPips } from './mana';

/** Deckbau (PLAN.md § 7). Bewusst klein: Zählen statt Solver. */

export function DecksPanel() {
  const decks = useLiveQuery(() => listDecks(), []);
  const [editingId, setEditingId] = useState<number | null>(null);

  if (editingId != null) {
    return <DeckEditor deckId={editingId} onBack={() => setEditingId(null)} />;
  }

  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-surface p-4">
        <h2 className="mb-3 font-mono text-lg">Decks</h2>
        <NewDeckForm onCreated={(id) => setEditingId(id)} />
      </div>
      {decks === undefined ? (
        <p className="px-1 font-mono text-sm text-muted">Lade…</p>
      ) : decks.length === 0 ? (
        <p className="px-1 font-mono text-sm text-muted">Noch keine Decks.</p>
      ) : (
        <ul className="space-y-1">
          {decks.map((d) => (
            <li key={d.id} className="flex items-center gap-2 rounded-md bg-surface p-3 font-mono text-sm">
              <button onClick={() => setEditingId(d.id!)} className="min-w-0 flex-1 text-left hover:text-accent">
                <div className="truncate">{d.name}</div>
                <div className="text-xs text-muted">
                  {FORMAT_LABELS[d.format]} · {d.cards.reduce((s, c) => s + c.qty, 0) + (d.commanderId ? 1 : 0)} Karten
                </div>
              </button>
              <button
                onClick={() => { if (confirm(`Deck „${d.name}" löschen?`)) void deleteDeck(d.id!); }}
                className="rounded px-2 py-1 text-muted hover:text-danger"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewDeckForm({ onCreated }: { onCreated: (id: number) => void }) {
  const [name, setName] = useState('');
  const [format, setFormat] = useState<FormatId>('commander');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Deckname…"
        className="flex-1 rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
      />
      <select value={format} onChange={(e) => setFormat(e.target.value as FormatId)}
        className="rounded-md border border-border bg-bg px-2 py-2 font-mono text-sm outline-none focus:border-accent">
        {LEGALITY_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
      </select>
      <button
        onClick={async () => {
          const id = await saveDeck({ name: name.trim() || 'Neues Deck', format, cards: [], sideboard: [], updatedAt: Date.now() });
          onCreated(id as number);
        }}
        className="rounded bg-accent px-3 py-2 font-mono text-sm text-on-accent"
      >
        Neu
      </button>
    </div>
  );
}

// --- Editor -----------------------------------------------------------------

function DeckEditor({ deckId, onBack }: { deckId: number; onBack: () => void }) {
  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId]);
  const owned = useLiveQuery(() => ownedByOracle(), []);
  const [tab, setTab] = useState<'liste' | 'stats' | 'fehlt' | 'text'>('liste');

  // Karten-Lookup für alle im Deck referenzierten oracleIds.
  const refIds = useMemo(() => {
    if (!deck) return [];
    const ids = [...deck.cards, ...deck.sideboard].map((c) => c.oracleId);
    if (deck.commanderId) ids.push(deck.commanderId);
    return ids;
  }, [deck]);
  const cards = useLiveQuery(() => getCards(refIds), [refIds]);

  if (!deck || !cards) return <p className="px-1 font-mono text-sm text-muted">Lade…</p>;

  const rules = deck.format === 'commander' || deck.format === 'brawl';

  async function update(patch: Partial<Deck>) {
    await saveDeck({ ...deck!, ...patch });
  }
  function adjust(list: 'cards' | 'sideboard', oracleId: string, delta: number) {
    const arr = [...deck![list]];
    const i = arr.findIndex((c) => c.oracleId === oracleId);
    if (i >= 0) {
      const qty = arr[i].qty + delta;
      if (qty <= 0) arr.splice(i, 1);
      else arr[i] = { ...arr[i], qty };
    } else if (delta > 0) arr.push({ oracleId, qty: delta });
    void update({ [list]: arr } as Partial<Deck>);
  }

  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-surface p-4">
        <div className="mb-2 flex items-center gap-2">
          <button onClick={onBack} className="rounded px-2 py-1 font-mono text-sm text-muted hover:text-accent">← Decks</button>
          <button
            onClick={() => { if (confirm('Deck löschen?')) { void deleteDeck(deckId); onBack(); } }}
            className="ml-auto rounded px-2 py-1 font-mono text-xs text-muted hover:text-danger"
          >
            Deck löschen
          </button>
        </div>
        <input
          value={deck.name}
          onChange={(e) => void update({ name: e.target.value })}
          className="mb-2 w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-lg outline-none focus:border-accent"
        />
        <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
          <select value={deck.format} onChange={(e) => void update({ format: e.target.value as FormatId })}
            className="rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent">
            {LEGALITY_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
          </select>
          {rules && (
            <span className="text-xs text-muted">
              Commander: {deck.commanderId ? cards.get(deck.commanderId)?.name ?? '—' : 'keiner'}
            </span>
          )}
        </div>
      </div>

      {rules && <CommanderPicker deck={deck} onSet={(id) => void update({ commanderId: id })} />}

      <AddCardBox owned={owned ?? new Map()} onAdd={(id, list) => adjust(list, id, 1)} allowSideboard={!rules} />

      <div className="flex gap-1 font-mono text-xs">
        {(['liste', 'stats', 'fehlt', 'text'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 ${tab === t ? 'bg-accent text-on-accent' : 'bg-surface text-muted hover:text-text'}`}>
            {t === 'liste' ? 'Liste' : t === 'stats' ? 'Statistik' : t === 'fehlt' ? 'Fehlt mir' : 'Text'}
          </button>
        ))}
      </div>

      {tab === 'liste' && (
        <DeckList deck={deck} cards={cards} owned={owned ?? new Map()} onAdjust={adjust} allowSideboard={!rules} />
      )}
      {tab === 'stats' && <DeckStatsView deck={deck} cards={cards} />}
      {tab === 'fehlt' && <MissingView deck={deck} cards={cards} owned={owned ?? new Map()} />}
      {tab === 'text' && <DeckTextView deck={deck} cards={cards} onImport={(patch) => void update(patch)} />}
    </section>
  );
}

function combinedEntries(deck: Deck): DeckCard[] {
  const entries = [...deck.cards];
  if (deck.commanderId) entries.push({ oracleId: deck.commanderId, qty: 1 });
  return entries;
}

function CommanderPicker({ deck, onSet }: { deck: Deck; onSet: (id: string | undefined) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Card[]>([]);
  useEffect(() => {
    let alive = true;
    if (q.trim()) void searchCards(q, 6).then((r) => { if (alive) setResults(r); });
    else setResults([]);
    return () => { alive = false; };
  }, [q]);
  return (
    <div className="rounded-lg bg-surface p-3">
      <div className="mb-1 flex items-center justify-between font-mono text-xs text-muted">
        <span>Commander wählen</span>
        {deck.commanderId && <button onClick={() => onSet(undefined)} className="hover:text-danger">entfernen</button>}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Legendäre Kreatur suchen…"
        className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent" />
      {results.length > 0 && (
        <ul className="mt-2 divide-y divide-white/5 overflow-hidden rounded-md border border-border">
          {results.map((c) => (
            <li key={c.oracleId}>
              <button onClick={() => { onSet(c.oracleId); setQ(''); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-sm hover:bg-white/10">
                <ColorPips colors={c.colorIdentity} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.name}</span>
                  <span className="block truncate text-[10px] text-muted">{c.typeLine}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddCardBox({
  owned, onAdd, allowSideboard,
}: { owned: Map<string, number>; onAdd: (id: string, list: 'cards' | 'sideboard') => void; allowSideboard: boolean }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Card[]>([]);
  useEffect(() => {
    let alive = true;
    if (q.trim()) void searchCards(q, 8).then((r) => { if (alive) setResults(r); });
    else setResults([]);
    return () => { alive = false; };
  }, [q]);
  return (
    <div className="rounded-lg bg-surface p-3">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Karte hinzufügen (Name)…"
        className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent" />
      {results.length > 0 && (
        <ul className="mt-2 divide-y divide-white/5 overflow-hidden rounded-md border border-border">
          {results.map((c) => (
            <li key={c.oracleId} className="flex items-center gap-2 px-3 py-1.5 font-mono text-sm">
              <ColorPips colors={c.colorIdentity} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{c.name}</span>
                <span className="block truncate text-[10px] text-muted">
                  {c.typeLine}
                  {owned.get(c.oracleId) ? <span className="text-ok"> · im Bestand: {owned.get(c.oracleId)}</span> : ''}
                </span>
              </span>
              <button onClick={() => onAdd(c.oracleId, 'cards')} className="shrink-0 bg-fill/20 px-2 py-1 text-xs text-accent hover:bg-fill/40">+ Deck</button>
              {allowSideboard && <button onClick={() => onAdd(c.oracleId, 'sideboard')} className="shrink-0 bg-white/10 px-2 py-1 text-xs text-muted hover:text-text">+ SB</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeckList({
  deck, cards, owned, onAdjust, allowSideboard,
}: {
  deck: Deck; cards: Map<string, Card>; owned: Map<string, number>;
  onAdjust: (list: 'cards' | 'sideboard', id: string, delta: number) => void; allowSideboard: boolean;
}) {
  const validation = validateDeck(deck, cards);
  const renderList = (list: 'cards' | 'sideboard', title: string) => {
    const entries = deck[list];
    if (entries.length === 0) return null;
    return (
      <div className="rounded-lg bg-surface p-3">
        <h3 className="mb-2 font-mono text-sm">{title} ({entries.reduce((s, c) => s + c.qty, 0)})</h3>
        <ul className="space-y-1">
          {entries.map((e) => {
            const card = cards.get(e.oracleId);
            const have = owned.get(e.oracleId) ?? 0;
            return (
              <li key={e.oracleId} className="flex items-center gap-2 font-mono text-sm">
                <ColorPips colors={card?.colorIdentity ?? []} />
                <button onClick={() => onAdjust(list, e.oracleId, -1)} className="rounded px-2 py-0.5 text-muted hover:bg-white/10">−</button>
                <span className="w-7 text-center text-accent">{e.qty}×</span>
                <button onClick={() => onAdjust(list, e.oracleId, 1)} className="rounded px-2 py-0.5 text-muted hover:bg-white/10">+</button>
                <span className="min-w-0 flex-1 truncate">{card?.name ?? e.oracleId}</span>
                <span className={`text-[10px] ${have >= e.qty ? 'text-ok' : 'text-danger'}`}>{have}/{e.qty}</span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };
  return (
    <div className="space-y-3">
      <div className={`rounded-lg p-3 font-mono text-xs ${validation.ok ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>
        {validation.ok ? '✓ Deck ist legal.' : (
          <ul className="space-y-0.5">
            {validation.issues.slice(0, 12).map((i, k) => <li key={k}>• {i.message}</li>)}
          </ul>
        )}
      </div>
      {deck.cards.length === 0 && !deck.commanderId && <p className="px-1 font-mono text-sm text-muted">Deck ist leer — Karten oben hinzufügen.</p>}
      {renderList('cards', 'Deck')}
      {allowSideboard && renderList('sideboard', 'Sideboard')}
    </div>
  );
}

function DeckStatsView({ deck, cards }: { deck: Deck; cards: Map<string, Card> }) {
  const stats = computeStats(combinedEntries(deck), cards);
  const maxCurve = Math.max(1, ...stats.manaCurve);
  const maxColor = Math.max(1, ...COLOR_KEYS.map((c) => stats.colors[c]));
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-surface p-3 font-mono text-xs">
        <h3 className="mb-2 text-sm">Manakurve (ohne Länder)</h3>
        <div className="flex items-end gap-1" style={{ height: 90 }}>
          {Array.from({ length: CURVE_BUCKETS }, (_, i) => (
            <div key={i} className="flex flex-1 flex-col items-center justify-end">
              <div className="w-full rounded-t bg-accent" style={{ height: `${(stats.manaCurve[i] / maxCurve) * 70}px` }} />
              <span className="mt-1 text-muted">{i === CURVE_BUCKETS - 1 ? '7+' : i}</span>
              <span className="text-[10px] text-muted">{stats.manaCurve[i] || ''}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-lg bg-surface p-3 font-mono text-xs">
        <h3 className="mb-2 text-sm">Farbverteilung</h3>
        {COLOR_KEYS.map((c) => (
          <div key={c} className="mb-1 flex items-center gap-2">
            <span className="w-4">{c}</span>
            <div className="h-3 flex-1 rounded bg-bg">
              <div className="h-3 rounded bg-accent" style={{ width: `${(stats.colors[c] / maxColor) * 100}%` }} />
            </div>
            <span className="w-6 text-right text-muted">{stats.colors[c]}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-surface p-3 font-mono text-xs">
          <h3 className="mb-1 text-sm">Länder</h3>
          <p className="text-muted">{stats.lands} von {stats.total} ({Math.round(stats.landRatio * 100)}%)</p>
        </div>
        <div className="rounded-lg bg-surface p-3 font-mono text-xs">
          <h3 className="mb-1 text-sm">Typen</h3>
          {Object.entries(stats.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
            <div key={t} className="flex justify-between text-muted"><span>{t}</span><span>{n}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MissingView({ deck, cards, owned }: { deck: Deck; cards: Map<string, Card>; owned: Map<string, number> }) {
  const rows = computeMissing(combinedEntries(deck), owned);
  if (rows.length === 0) return <p className="rounded-lg bg-ok/10 p-3 font-mono text-sm text-ok">✓ Du besitzt alle Karten für dieses Deck.</p>;
  const totalMissing = rows.reduce((s, r) => s + r.missing, 0);
  return (
    <div className="rounded-lg bg-surface p-3">
      <h3 className="mb-2 font-mono text-sm">Fehlt mir ({totalMissing})</h3>
      <ul className="space-y-1 font-mono text-sm">
        {rows.map((r) => (
          <li key={r.oracleId} className="flex items-center gap-2">
            <ColorPips colors={cards.get(r.oracleId)?.colorIdentity ?? []} />
            <span className="min-w-0 flex-1 truncate">{cards.get(r.oracleId)?.name ?? r.oracleId}</span>
            <span className="text-danger">{r.missing} fehlen</span>
            <span className="text-xs text-muted">({r.have}/{r.need})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeckTextView({
  deck, cards, onImport,
}: { deck: Deck; cards: Map<string, Card>; onImport: (patch: Partial<Deck>) => void }) {
  const exportText = useMemo(() => {
    const main = deck.cards.map((e) => ({ qty: e.qty, name: cards.get(e.oracleId)?.name ?? e.oracleId }));
    const side = deck.sideboard.map((e) => ({ qty: e.qty, name: cards.get(e.oracleId)?.name ?? e.oracleId }));
    return serializeDeckText(main, side);
  }, [deck, cards]);

  const [text, setText] = useState('');
  const [report, setReport] = useState<string | null>(null);

  async function doImport() {
    const parsed = parseDeckText(text);
    const unresolved: string[] = [];
    const resolveList = async (lines: { qty: number; name: string }[]): Promise<DeckCard[]> => {
      const out: DeckCard[] = [];
      for (const l of lines) {
        const norm = normalizeName(l.name);
        const nameHit = await db.names.where('normName').equals(norm).first();
        const id = nameHit?.oracleId ?? (await db.cards.where('normName').equals(norm).first())?.oracleId;
        if (id) {
          const ex = out.find((c) => c.oracleId === id);
          if (ex) ex.qty += l.qty;
          else out.push({ oracleId: id, qty: l.qty });
        } else unresolved.push(l.name);
      }
      return out;
    };
    const mainCards = await resolveList(parsed.main);
    const sideCards = await resolveList(parsed.sideboard);
    onImport({ cards: mainCards, sideboard: sideCards });
    setReport(unresolved.length ? `Importiert. Nicht gefunden: ${unresolved.join(', ')}` : 'Importiert.');
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-surface p-3">
        <h3 className="mb-2 font-mono text-sm">Export (Moxfield)</h3>
        <textarea readOnly value={exportText} rows={6}
          className="w-full rounded-md border border-border bg-bg p-2 font-mono text-xs outline-none" />
        <button onClick={() => void navigator.clipboard?.writeText(exportText)}
          className="mt-2 rounded border border-border px-3 py-1.5 font-mono text-xs hover:border-accent">In Zwischenablage</button>
      </div>
      <div className="rounded-lg bg-surface p-3">
        <h3 className="mb-2 font-mono text-sm">Import (Moxfield-Text)</h3>
        <p className="mb-1 font-mono text-[11px] text-muted">Ersetzt die aktuelle Deckliste. Format: „4 Lightning Bolt", „SIDEBOARD:" trennt.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={'4 Lightning Bolt\n1 Sol Ring'}
          className="w-full rounded-md border border-border bg-bg p-2 font-mono text-xs outline-none focus:border-accent" />
        <button onClick={() => void doImport()} disabled={!text.trim()}
          className="mt-2 rounded bg-accent px-3 py-1.5 font-mono text-xs text-on-accent disabled:opacity-40">Importieren</button>
        {report && <p className="mt-2 font-mono text-xs text-muted">{report}</p>}
      </div>
    </div>
  );
}
