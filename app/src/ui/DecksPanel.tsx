import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, createDeck, changeDeck, deleteDeck, listDecks } from '../db/db';
import type { DeckOp } from '../domain/deckOps';
import { getCards, ownedByOracle, ownedPrintingByOracle, previewImageIds, previewPrinting, catalogFeatures } from '../data/cards';
import { deckCombos } from '../data/combos';
import { spellbookUrl } from '../domain/combos';
import { Stars } from './Stars';
import { searchCards } from '../data/search';
import { normalizeName } from '../domain/nameMatch';
import { isTokenCard } from '../domain/tokens';
import { validateDeck, availableColors, commanderIdentity } from '../domain/deckValidate';
import { computeStats, isBasicLand, CURVE_BUCKETS, COLOR_KEYS } from '../domain/deckStats';
import { computeMissing } from '../domain/deckMissing';
import { checkDeck, type CheckLevel, type DeckCombos } from '../domain/deckCheck';
import { TYPE_LABEL } from '../domain/collectionFilter';
import { parseDeckText, serializeDeckText } from '../domain/deckText';
import { LEGALITY_FORMATS, FORMAT_LABELS, commanderIds, type Card, type Deck, type DeckCard, type FormatId } from '../domain/types';
import { PixelCheckbox } from './PixelCheckbox';
import { PlaytestView } from './PlaytestView';
import { DeckCompare } from './DeckCompare';
import { ColorPips } from './mana';
import { CardImage } from './CardImage';
import { CardDetail } from './CardDetail';
import { feedbackAdded, hapticTap } from '../native/feedback';
import { useBackHandler } from './backStack';
import { deckRequested, clearDeckRequest } from './deckNav';
import { useWidth, hoverPreview, dragSource, DropZone, useDragging, type DragCard } from './wide';
import { ensureRowPrices } from '../data/prices';
import { deckValueRows, missingValueRows, collectionValue, formatEur, priceKey, type PriceEntry, type ValueRow } from '../domain/prices';

/** Stabile leere Map — sonst rechnet der Deck-Check bei jedem Rendern neu. */
const EMPTY_OWNED = new Map<string, number>();

const COLOR_NAME: Record<string, string> = {
  W: 'Weiß', U: 'Blau', B: 'Schwarz', R: 'Rot', G: 'Grün', C: 'Farblos',
};
function colorNames(colors: readonly string[]): string {
  if (colors.length === 0) return 'Farblos';
  return colors.map((c) => COLOR_NAME[c] ?? c).join(' / ');
}

/** Deckbau (PLAN.md § 7). Bewusst klein: Zählen statt Solver. */

export function DecksPanel() {
  const decks = useLiveQuery(() => listDecks(), []);
  const [editingId, setEditingId] = useState<number | null>(() => deckRequested());
  // Deck-Vergleich (M22): zwei Decks nebeneinander.
  const [compare, setCompare] = useState<[number, number] | null>(null);
  useEffect(() => clearDeckRequest(), []);

  if (editingId != null) {
    return <DeckEditor deckId={editingId} onBack={() => setEditingId(null)} />;
  }
  if (compare) {
    return <DeckCompare initial={compare} onBack={() => setCompare(null)} />;
  }

  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="flex-1 font-mono text-lg">Decks</h2>
          {decks && decks.length >= 2 && (
            <button onClick={() => setCompare([decks[0].id!, decks[1].id!])}
              className="rounded bg-bg px-3 py-1.5 font-mono text-xs text-muted hover:text-text">Decks vergleichen</button>
          )}
        </div>
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
                  {FORMAT_LABELS[d.format]} · {d.cards.reduce((s, c) => s + c.qty, 0) + commanderIds(d).length} Karten
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
  const [two, setTwo] = useState(false);
  const leads = format === 'commander' || format === 'brawl';
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
          const id = await createDeck({
            name: name.trim() || 'Neues Deck', format, ...(leads && two ? { twoCommanders: true } : {}),
            cards: [], sideboard: [], updatedAt: Date.now(),
          });
          onCreated(id as number);
        }}
        className="rounded bg-accent px-3 py-2 font-mono text-sm text-on-accent"
      >
        Neu
      </button>
      {leads && (
        <PixelCheckbox checked={two} onChange={setTwo} className="w-full font-mono text-xs text-muted">
          Zwei Commander (Partner, Hintergrund)
        </PixelCheckbox>
      )}
    </div>
  );
}

// --- Editor -----------------------------------------------------------------

function DeckEditor({ deckId, onBack }: { deckId: number; onBack: () => void }) {
  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId]);
  const owned = useLiveQuery(() => ownedByOracle(), []);
  const [tab, setTab] = useState<'liste' | 'stats' | 'check' | 'fehlt' | 'text'>('liste');
  // Breites Layout (M18): Liste links, Statistik/Check/… rechts; ab 1440 px noch die Suche davor.
  const width = useWidth();
  useBackHandler(true, onBack); // Android-Zurück = zur Deckliste

  // Karten-Lookup für alle im Deck referenzierten oracleIds.
  const refIds = useMemo(() => {
    if (!deck) return [];
    const ids = [...deck.cards, ...deck.sideboard].map((c) => c.oracleId);
    ids.push(...commanderIds(deck));
    return ids;
  }, [deck]);
  const cards = useLiveQuery(() => getCards(refIds), [refIds]);
  const imgs = useLiveQuery(() => previewImageIds(refIds), [refIds]);
  // Gewählte Ausgabe (Artwork) aus der Sammlung — überlagert die Standard-Vorschau,
  // damit Deck-Raster/Commander dasselbe Bild wie die Sammlung zeigen.
  const ownedPrint = useLiveQuery(() => ownedPrintingByOracle(), []);
  const effectiveImgs = useMemo(() => {
    const m = new Map(imgs ?? []);
    if (ownedPrint) for (const [oid, pid] of ownedPrint) m.set(oid, pid);
    return m;
  }, [imgs, ownedPrint]);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Probehand hier oben, damit sie einen Layout-Wechsel (Tablet drehen) übersteht.
  const [testing, setTesting] = useState(false);
  // Name als Entwurf tippen und erst nach einer Pause speichern — im Big Screen geht jeder
  // Schritt übers WLAN, ein Schritt je Taste würde Buchstaben verschlucken.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const nameTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(nameTimer.current), []);

  if (!deck || !cards) return <p className="px-1 font-mono text-sm text-muted">Lade…</p>;

  const rules = deck.format === 'commander' || deck.format === 'brawl';

  // Jede Änderung als kleiner Schritt auf den aktuellen Stand (M18) — so überschreiben sich
  // Handy und Big Screen nicht, wenn beide dasselbe Deck bearbeiten.
  function change(op: DeckOp) {
    void changeDeck(deckId, op).catch((e: Error) => alert(e.message));
  }
  /**
   * Karte abgelegt (Drag-and-drop, M20): ins Ziel und — wenn sie aus dem Deck kam — aus
   * der Quelle heraus. Schritte nacheinander, damit Big Screen sie in Reihenfolge bekommt.
   */
  function dropInto(target: 'cards' | 'sideboard' | 'commander' | 'partner', c: DragCard) {
    if (c.from === target) return;
    const ops: DeckOp[] = [];
    if (target === 'commander' || target === 'partner') ops.push({ kind: target, oracleId: c.oracleId });
    else ops.push({ kind: 'adjust', list: target, oracleId: c.oracleId, delta: 1 });
    if (c.from === 'cards' || c.from === 'sideboard') ops.push({ kind: 'adjust', list: c.from, oracleId: c.oracleId, delta: -1 });
    if (c.from === 'commander' || c.from === 'partner') ops.push({ kind: c.from, oracleId: null });
    feedbackAdded();
    void (async () => {
      for (const op of ops) await changeDeck(deckId, op);
    })().catch((e: Error) => alert(e.message));
  }
  function adjust(list: 'cards' | 'sideboard', oracleId: string, delta: number) {
    // Spürbares Feedback wie im Scanner: Hinzufügen = Ton + Vibration, Entfernen = kurzes Tippen.
    if (delta > 0) feedbackAdded();
    else hapticTap();
    change({ kind: 'adjust', list, oracleId, delta });
  }

  const TABS = ['liste', 'stats', 'check', 'fehlt', 'text'] as const;
  const sideTab = tab === 'liste' ? 'stats' : tab;
  const tabBar = (list: readonly (typeof TABS)[number][]) => (
    <div className="flex flex-wrap gap-1 font-mono text-xs">
      {list.map((t) => {
        const on = width === 'narrow' ? tab === t : sideTab === t;
        return (
          <button key={t} onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded px-3 py-1.5 ${on ? 'bg-accent text-on-accent' : 'bg-surface text-muted hover:text-text'}`}>
            {t === 'liste' ? 'Liste' : t === 'stats' ? 'Statistik' : t === 'check' ? 'Deck-Check' : t === 'fehlt' ? 'Fehlt mir' : 'Text'}
          </button>
        );
      })}
    </div>
  );
  const tabContent = (t: (typeof TABS)[number]) => (
    <>
      {t === 'stats' && <DeckStatsView deck={deck} cards={cards} owned={owned ?? new Map()} chosen={ownedPrint} />}
      {t === 'check' && <DeckCheckView deck={deck} cards={cards} owned={owned ?? EMPTY_OWNED} onTest={() => setTesting(true)} />}
      {t === 'fehlt' && <MissingView deck={deck} cards={cards} owned={owned ?? new Map()} />}
      {t === 'text' && <DeckTextView deck={deck} cards={cards} onImport={(lists) => change({ kind: 'replaceLists', ...lists })} />}
    </>
  );
  const first = deck.commanderId ? cards.get(deck.commanderId) : undefined;
  const second = deck.partnerId ? cards.get(deck.partnerId) : undefined;
  const commanderEl = rules && (
    <>
      <CommanderSection
        commander={first}
        identity={commanderIdentity([first, second].filter((c): c is Card => !!c))}
        both={!!second}
        chosenScryfallId={deck.commanderId ? effectiveImgs.get(deck.commanderId) : undefined}
        onSet={(id) => change({ kind: 'commander', oracleId: id ?? null })}
        onDropCard={(c) => dropInto('commander', c)}
      />
      {deck.twoCommanders && (
        <CommanderSection
          second
          commander={second}
          chosenScryfallId={deck.partnerId ? effectiveImgs.get(deck.partnerId) : undefined}
          onSet={(id) => change({ kind: 'partner', oracleId: id ?? null })}
          onDropCard={(c) => dropInto('partner', c)}
        />
      )}
    </>
  );
  const addEl = <AddCardBox owned={owned ?? new Map()} onAdd={(id, list) => adjust(list, id, 1)} allowSideboard={!rules} />;
  const listEl = (
    <DeckList deck={deck} cards={cards} imgs={effectiveImgs} owned={owned ?? new Map()}
      onAdjust={adjust} allowSideboard={!rules} onOpenDetail={setDetailId} onDrop={dropInto} />
  );

  return (
    <section className={`space-y-3 ${detailId ? 'lg:pr-[30rem]' : ''}`}>
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
          value={nameDraft ?? deck.name}
          onChange={(e) => {
            const name = e.target.value;
            setNameDraft(name);
            window.clearTimeout(nameTimer.current);
            nameTimer.current = window.setTimeout(() => change({ kind: 'rename', name }), 400);
          }}
          onBlur={() => {
            if (nameDraft == null) return;
            window.clearTimeout(nameTimer.current);
            const name = nameDraft;
            void changeDeck(deckId, { kind: 'rename', name }).finally(() => setNameDraft(null));
          }}
          className="mb-2 w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-lg outline-none focus:border-accent"
        />
        <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
          <select value={deck.format} onChange={(e) => change({ kind: 'format', format: e.target.value as FormatId })}
            className="rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent">
            {LEGALITY_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
          </select>
          {rules && (
            <PixelCheckbox checked={!!deck.twoCommanders} onChange={(on) => change({ kind: 'twoCommanders', on })} className="text-xs text-muted">
              Zwei Commander
            </PixelCheckbox>
          )}
        </div>
      </div>

      {width === 'narrow' ? (
        <>
          {commanderEl}
          {addEl}
          {/* Fünf Reiter passen am Handy nicht in eine Zeile — lieber umbrechen als Wörter trennen. */}
          {tabBar(TABS)}
          {tab === 'liste' && listEl}
          {tab !== 'liste' && tabContent(tab)}
        </>
      ) : (
        <div className={`grid items-start gap-4 ${width === 'xwide' ? 'grid-cols-[20rem_minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-2'}`}>
          {width === 'xwide' && <div className="sticky top-4 space-y-3">{commanderEl}{addEl}</div>}
          <div className="min-w-0 space-y-3">
            {width === 'wide' && <>{commanderEl}{addEl}</>}
            {listEl}
          </div>
          <div className="min-w-0 space-y-3">
            {tabBar(TABS.filter((t) => t !== 'liste'))}
            {tabContent(sideTab)}
          </div>
        </div>
      )}

      {detailId && <CardDetail oracleId={detailId} onClose={() => setDetailId(null)} />}
      {testing && <PlaytestView deck={deck} cards={cards} imgs={effectiveImgs} onClose={() => setTesting(false)} />}
    </section>
  );
}

function combinedEntries(deck: Deck): DeckCard[] {
  const entries = [...deck.cards];
  for (const id of commanderIds(deck)) entries.push({ oracleId: id, qty: 1 });
  return entries;
}

/**
 * Commander-Platz. Der erste zeigt die verfügbaren Farben (bei zwei: beide zusammen), der
 * zweite (`second`, M20) nimmt auch einen Hintergrund.
 */
function CommanderSection(props: {
  commander?: Card; chosenScryfallId?: string; onSet: (id: string | undefined) => void;
  second?: boolean; identity?: string[]; both?: boolean; onDropCard?: (c: DragCard) => void;
}) {
  const slot = props.second ? 'partner' : 'commander';
  const inner = <CommanderSlot {...props} />;
  if (!props.onDropCard) return inner;
  return <DropZone onDrop={props.onDropCard} accept={(c) => c.from !== slot}>{inner}</DropZone>;
}

function CommanderSlot({ commander, chosenScryfallId, onSet, second = false, identity, both = false }: {
  commander?: Card; chosenScryfallId?: string; onSet: (id: string | undefined) => void;
  second?: boolean; identity?: string[]; both?: boolean;
}) {
  const title = second ? 'Zweiter Commander' : 'Commander';
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Card[]>([]);
  const [scryfallId, setScryfallId] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    // Gewählte Ausgabe aus der Sammlung bevorzugen, sonst Standard-Vorschau.
    if (chosenScryfallId) { setScryfallId(chosenScryfallId); return () => { alive = false; }; }
    if (commander) void previewPrinting(commander.oracleId).then((p) => alive && setScryfallId(p?.scryfallId));
    return () => { alive = false; };
  }, [commander, chosenScryfallId]);
  useEffect(() => {
    let alive = true;
    if (q.trim()) void searchCards(q, 6).then((r) => { if (alive) setResults(r); });
    else setResults([]);
    return () => { alive = false; };
  }, [q]);

  // Commander gewählt und nicht im Ändern-Modus → prominent anzeigen.
  if (commander && !editing) {
    return (
      <div className="frame" {...dragSource({ oracleId: commander.oracleId, from: second ? 'partner' : 'commander' }, commander.name)}>
        <div className="titlebar">
          <span className="min-w-0 flex-1 truncate text-text">{title}</span>
          <button onClick={() => { setEditing(true); setQ(''); }} className="px-1 text-xs text-paper">ändern</button>
          <button onClick={() => onSet(undefined)} className="px-1 text-xs text-paper hover:text-danger">entfernen</button>
        </div>
        <div className="flex gap-3 p-3 font-mono">
          <CardImage scryfallId={scryfallId} name={commander.name} size="normal" className="h-auto w-24 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base text-text">{commander.name}</div>
            <div className="text-xs text-muted">{commander.typeLine}</div>
            {!second && (
              <div className="mt-3">
                <div className="mb-1 font-hud text-[9px] text-muted">{both ? 'VERFÜGBARE FARBEN (BEIDE)' : 'VERFÜGBARE FARBEN'}</div>
                <div className="flex items-center gap-2">
                  <ColorPips colors={availableColors(identity ?? commander.colorIdentity)} />
                  <span className="text-sm text-text">{colorNames(availableColors(identity ?? commander.colorIdentity))}</span>
                </div>
                <div className="mt-1 text-[10px] text-muted">Farblose Karten passen immer.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Kein Commander oder Ändern-Modus → Suche.
  return (
    <div className="rounded-lg bg-surface p-3">
      <div className="mb-1 flex items-center justify-between font-mono text-xs text-muted">
        <span>{second ? 'Zweiter Commander (Partner oder Hintergrund)' : 'Commander wählen (legendäre Kreatur)'}</span>
        {commander && <button onClick={() => setEditing(false)} className="hover:text-text">abbrechen</button>}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={second ? 'Partner oder Hintergrund suchen…' : 'Legendäre Kreatur suchen…'}
        className="w-full border-2 border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-paper" />
      {results.length > 0 && (
        <ul className="mt-2 divide-y divide-white/5 overflow-hidden border-2 border-border">
          {results.map((c) => (
            <li key={c.oracleId}>
              <button onClick={() => { feedbackAdded(); onSet(c.oracleId); setQ(''); setEditing(false); }}
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
      <input value={q} onChange={(e) => setQ(e.target.value)} data-hotkey="search" placeholder="Karte hinzufügen (Name)…"
        className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent" />
      {results.length > 0 && (
        <ul className="mt-2 divide-y divide-white/5 overflow-hidden rounded-md border border-border">
          {results.map((c) => (
            <li key={c.oracleId} {...dragSource({ oracleId: c.oracleId, from: 'search' }, c.name)}
              className="flex items-center gap-2 px-3 py-1.5 font-mono text-sm">
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
  deck, cards, imgs, owned, onAdjust, allowSideboard, onOpenDetail, onDrop,
}: {
  deck: Deck; cards: Map<string, Card>; imgs: Map<string, string>; owned: Map<string, number>;
  onAdjust: (list: 'cards' | 'sideboard', id: string, delta: number) => void;
  allowSideboard: boolean; onOpenDetail: (oracleId: string) => void;
  onDrop: (list: 'cards' | 'sideboard', c: DragCard) => void;
}) {
  const [view, setView] = useState<'list' | 'grid'>('list');
  const validation = validateDeck(deck, cards);
  const dragging = useDragging();
  const renderList = (list: 'cards' | 'sideboard', title: string) => {
    const entries = deck[list];
    // Leere Liste nur beim Ziehen als Ablage zeigen.
    if (entries.length === 0) {
      if (!dragging || dragging.from === list) return null;
      return (
        <DropZone onDrop={(c) => onDrop(list, c)} className="rounded-lg border-2 border-dashed border-border p-4 text-center font-mono text-xs text-muted">
          {title} — hierher ziehen
        </DropZone>
      );
    }
    return (
      <DropZone onDrop={(c) => onDrop(list, c)} accept={(c) => c.from !== list} className="rounded-lg bg-surface p-3">
        <h3 className="mb-2 font-mono text-sm">{title} ({entries.reduce((s, c) => s + c.qty, 0)})</h3>
        {view === 'grid' ? (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {entries.map((e) => {
              const card = cards.get(e.oracleId);
              const have = owned.get(e.oracleId) ?? 0;
              return (
                <li key={e.oracleId}>
                  <button onClick={() => onOpenDetail(e.oracleId)} {...dragSource({ oracleId: e.oracleId, from: list }, card?.name)}
                    className="relative block w-full" title={card?.name}>
                    <CardImage scryfallId={imgs.get(e.oracleId)} name={card?.name} size="normal" className="h-auto w-full" />
                    <span className="absolute right-0 top-0 bg-titlebar px-1.5 py-0.5 font-hud text-[10px] text-paper">{e.qty}×</span>
                    <span className={`absolute bottom-0 left-0 bg-bg px-1 font-hud text-[8px] ${have >= e.qty ? 'text-ok' : 'text-danger'}`}>{have}/{e.qty}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="space-y-1">
            {entries.map((e) => {
              const card = cards.get(e.oracleId);
              const have = owned.get(e.oracleId) ?? 0;
              return (
                <li key={e.oracleId} {...dragSource({ oracleId: e.oracleId, from: list }, card?.name)}
                  className="flex items-center gap-2 font-mono text-sm">
                  <ColorPips colors={card?.colorIdentity ?? []} />
                  <button onClick={() => onAdjust(list, e.oracleId, -1)} aria-label="weniger" className="px-2 py-0.5 text-muted hover:text-paper">−</button>
                  <span className="w-7 text-center font-hud text-[10px] text-text">{e.qty}×</span>
                  <button onClick={() => onAdjust(list, e.oracleId, 1)} aria-label="mehr" className="px-2 py-0.5 text-muted hover:text-paper">+</button>
                  <button onClick={() => onOpenDetail(e.oracleId)} {...hoverPreview(imgs.get(e.oracleId), card?.name)} className="min-w-0 flex-1 truncate text-left hover:text-accent">{card?.name ?? e.oracleId}</button>
                  <span className={`text-[10px] ${have >= e.qty ? 'text-ok' : 'text-danger'}`}>{have}/{e.qty}</span>
                </li>
              );
            })}
          </ul>
        )}
      </DropZone>
    );
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-1 font-mono text-xs">
        <button onClick={() => setView('list')} aria-label="Liste"
          className={`px-2 py-1 ${view === 'list' ? 'bg-fill text-paper' : 'bg-surface text-muted'}`}>≣</button>
        <button onClick={() => setView('grid')} aria-label="Raster"
          className={`px-2 py-1 ${view === 'grid' ? 'bg-fill text-paper' : 'bg-surface text-muted'}`}>▦</button>
      </div>
      <div className={`rounded-lg p-3 font-mono text-xs ${validation.ok ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>
        {validation.ok ? '✓ Deck ist legal.' : (
          <ul className="space-y-0.5">
            {validation.issues.slice(0, 12).map((i, k) => <li key={k}>• {i.message}</li>)}
          </ul>
        )}
      </div>
      {deck.cards.length === 0 && commanderIds(deck).length === 0 && <p className="px-1 font-mono text-sm text-muted">Deck ist leer — Karten oben hinzufügen.</p>}
      {renderList('cards', 'Deck')}
      {allowSideboard && renderList('sideboard', 'Sideboard')}
    </div>
  );
}

/** Namen je oracleId (für Wert-Zeilen). */
function nameMap(cards: Map<string, Card>): Map<string, string> {
  return new Map([...cards].map(([id, c]) => [id, c.name]));
}

/** Preise für Wert-Zeilen laden (Cache/Scryfall, E7); `null` solange noch nichts da ist. */
function useRowPrices(rows: readonly ValueRow[]): Map<string, PriceEntry> | null {
  const sig = rows.map((r) => `${r.key}|${r.fallbackKey ?? ''}`).join(',');
  const [prices, setPrices] = useState<Map<string, PriceEntry> | null>(null);
  useEffect(() => {
    let alive = true;
    void ensureRowPrices(rows).then((p) => {
      if (alive) setPrices(p);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return prices;
}

/** Deck-Einträge ohne Standardländer — die kosten praktisch nichts und haben bei
 *  Scryfall oft keinen Preis (würden sonst als „ohne Preis" zählen). */
function pricedEntries(deck: Deck, cards: Map<string, Card>): DeckCard[] {
  return combinedEntries(deck).filter((e) => {
    const c = cards.get(e.oracleId);
    return !c || !isBasicLand(c);
  });
}

/** Deck-Wert + was die fehlenden Karten ungefähr kosten (Richtwerte, nicht-foil). */
function DeckValueBox({ deck, cards, owned, chosen }: {
  deck: Deck; cards: Map<string, Card>; owned: Map<string, number>; chosen?: Map<string, string>;
}) {
  const names = nameMap(cards);
  const entries = pricedEntries(deck, cards);
  const valueRows = deckValueRows(entries, names, chosen);
  const missing = computeMissing(entries, owned);
  const missingRows = missingValueRows(missing, names);
  const prices = useRowPrices([...valueRows, ...missingRows]);
  if (entries.length === 0) return null;
  const deckVal = prices ? collectionValue(valueRows, prices) : null;
  const missVal = prices ? collectionValue(missingRows, prices) : null;
  const missingQty = missing.reduce((n, m) => n + m.missing, 0);
  // Fehlende Karten sind eine Teilmenge des Decks → „ohne Preis" nur einmal zählen.
  const unpriced = deckVal?.unpricedQty ?? 0;
  return (
    <div className="rounded-lg bg-surface p-3 font-mono text-xs">
      <h3 className="mb-2 text-sm">Wert</h3>
      {!prices ? (
        <p className="text-muted">Preise werden geladen…</p>
      ) : (
        <>
          <div className="flex justify-between"><span className="text-muted">Deck{deck.sideboard.length ? ' (ohne Sideboard)' : ''}</span><span className="text-text">≈ {formatEur(deckVal?.total)}</span></div>
          <div className="flex justify-between">
            <span className="text-muted">Fehlt dir ({missingQty} {missingQty === 1 ? 'Karte' : 'Karten'})</span>
            <span className={missingQty ? 'text-danger' : 'text-ok'}>≈ {formatEur(missVal?.total ?? 0)}</span>
          </div>
          <p className="mt-2 text-[10px] text-muted">
            Richtwerte (Cardmarket über Scryfall), nicht-foil — deine gewählte Ausgabe bzw. die
            Standardausgabe; Standardländer zählen nicht mit.{unpriced > 0 && ` ${unpriced} ohne Preis.`}
          </p>
        </>
      )}
    </div>
  );
}

const BRACKET_TEXT: Record<2 | 3 | 4, { label: string; note: string }> = {
  2: { label: 'Bracket 1–2', note: 'Nichts, was ein höheres Bracket verlangt. Ob 1 (Exhibition) oder 2 (Core), hängt davon ab, wie das Deck gemeint ist.' },
  3: { label: 'Mindestens Bracket 3', note: 'Upgraded. Ob es eher 4 ist, hängt von Tempo und Absicht ab.' },
  4: { label: 'Mindestens Bracket 4', note: 'Optimized. Ein cEDH-Deck (5) ist es nur, wenn es aufs Turnier-Metagame zielt.' },
};
const LEVEL_TAG: Record<CheckLevel, { text: string; cls: string }> = {
  ok: { text: 'OK', cls: 'bg-bg text-muted' },
  info: { text: 'TIPP', cls: 'bg-fill text-paper' },
  warn: { text: 'ACHTUNG', cls: 'bg-danger text-paper' },
};

/** Deck-Check (M17): Bracket-Schätzung, Manabasis, Rollen, Kombos — jeweils mit Begründung. */
function DeckCheckView({ deck, cards, owned, onTest }: {
  deck: Deck; cards: Map<string, Card>; owned: Map<string, number>; onTest: () => void;
}) {
  const features = useLiveQuery(() => catalogFeatures(), []);
  // Kombos aus Commander Spellbook — `null` = lädt noch, `undefined` = keine Daten (älterer Katalog).
  const [combos, setCombos] = useState<DeckCombos | undefined | null>(null);
  useEffect(() => {
    let alive = true;
    void deckCombos(deck, cards, new Set(owned.keys()))
      .catch(() => undefined)
      .then((c) => { if (alive) setCombos(c); });
    return () => { alive = false; };
  }, [deck, cards, owned]);
  const result = useMemo(
    () => (features == null || combos === null ? null
      : checkDeck(deck, cards, { gameChangerData: features.gameChanger, roleData: features.roles, combos })),
    [deck, cards, features, combos],
  );
  if (!result) return <p className="px-1 font-mono text-sm text-muted">Prüfe…</p>;
  const b = result.bracket;
  return (
    <div className="space-y-3 font-mono text-xs">
      {b && (
        <div className="rounded-lg bg-surface p-3">
          <h3 className="mb-1 font-hud text-[9px] text-muted">COMMANDER-BRACKET (SCHÄTZUNG)</h3>
          <p className="mb-1 text-lg text-text">{BRACKET_TEXT[b.floor].label}</p>
          <p className="mb-2 text-muted">{BRACKET_TEXT[b.floor].note}</p>
          {b.reasons.length > 0 && (
            <ul className="space-y-1.5">
              {b.reasons.map((r) => (
                <li key={r.text}>
                  <span className="text-text">{r.text}</span>
                  <span className="block text-muted">{r.cards.join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
          {b.missingGameChangers && (
            <p className="mt-2 text-accent">
              Game Changer zählt die Schätzung erst nach dem nächsten Katalog-Update mit (Mehr → Katalog).
            </p>
          )}
        </div>
      )}
      {result.sections.map((sec) => (
        <div key={sec.title} className="rounded-lg bg-surface p-3">
          <h3 className="mb-2 text-sm">{sec.title}</h3>
          <ul className="space-y-2">
            {sec.items.map((it) => (
              <li key={it.key} className="flex gap-2">
                {/* Kombos zeigen ihre Sterne statt OK/TIPP. */}
                {it.stars ? <Stars n={it.stars} className="mt-0.5" /> : (
                  <span className={`h-fit shrink-0 px-1 py-0.5 font-hud text-[7px] ${LEVEL_TAG[it.level].cls}`}>{LEVEL_TAG[it.level].text}</span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-text">{it.title}</p>
                  {it.detail && <p className="text-muted">{it.detail}</p>}
                  {it.link && (
                    <a href={spellbookUrl(it.link)} target="_blank" rel="noreferrer" className="text-accent underline">
                      Ablauf bei Commander Spellbook
                    </a>
                  )}
                  {it.cards && it.cards.length > 0 && (
                    <details className="text-muted">
                      <summary className="cursor-pointer">Karten zeigen</summary>
                      <p className="mt-1">{it.cards.join(', ')}</p>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="px-1 text-[10px] text-muted">
        Regelbasiert: Brackets nach den offiziellen Commander-Regeln, Länderzahl nach Frank Karsten,
        {features?.roles ? ' Rollen aus den Scryfall-Tags,' : ' Rollen grob am Regeltext erkannt,'}
        {combos ? ' Kombos von Commander Spellbook (Sterne: eigene Einstufung).' : ' Kombos aus einer Auswahl bekannter Paare.'}
        {' '}Ein Hinweis, kein Urteil.
      </p>
      <div className="rounded-lg bg-surface p-3">
        <h3 className="mb-1 text-sm">Deck testen</h3>
        <p className="mb-2 text-muted">Probehand ziehen, Mulligan, ein paar Züge durchspielen — und wie wahrscheinlich Länder und Karten kommen.</p>
        <button onClick={onTest} disabled={deck.cards.length === 0}
          className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-40">Probehand ziehen</button>
      </div>
    </div>
  );
}

function DeckStatsView({ deck, cards, owned, chosen }: {
  deck: Deck; cards: Map<string, Card>; owned: Map<string, number>; chosen?: Map<string, string>;
}) {
  const stats = computeStats(combinedEntries(deck), cards);
  const maxCurve = Math.max(1, ...stats.manaCurve);
  const maxColor = Math.max(1, ...COLOR_KEYS.map((c) => stats.colors[c]));
  return (
    <div className="space-y-3">
      <DeckValueBox deck={deck} cards={cards} owned={owned} chosen={chosen} />
      <div className="rounded-lg bg-surface p-3 font-mono text-xs">
        <h3 className="mb-2 text-sm">Manakurve (ohne Länder)</h3>
        {/* Feste Höhe nur für die Balken — die Beschriftung darunter darf nicht in die
            Überschrift ragen (vorher 90 px für alles: hohe Balken überdeckten den Titel). */}
        <div className="flex gap-1">
          {Array.from({ length: CURVE_BUCKETS }, (_, i) => (
            <div key={i} className="flex flex-1 flex-col items-center">
              <div className="flex w-full items-end" style={{ height: 70 }}>
                <div className="w-full rounded-t bg-accent" style={{ height: `${(stats.manaCurve[i] / maxCurve) * 70}px` }} />
              </div>
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
            <div key={t} className="flex justify-between text-muted"><span>{TYPE_LABEL[t] ?? t}</span><span>{n}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MissingView({ deck, cards, owned }: { deck: Deck; cards: Map<string, Card>; owned: Map<string, number> }) {
  const rows = computeMissing(combinedEntries(deck), owned);
  // Preise nur für Nicht-Standardländer (wie im Wert-Kasten der Statistik).
  const valueRows = missingValueRows(rows.filter((r) => { const c = cards.get(r.oracleId); return !c || !isBasicLand(c); }), nameMap(cards));
  const prices = useRowPrices(valueRows);
  if (rows.length === 0) return <p className="rounded-lg bg-ok/10 p-3 font-mono text-sm text-ok">✓ Du besitzt alle Karten für dieses Deck.</p>;
  const totalMissing = rows.reduce((s, r) => s + r.missing, 0);
  const total = prices ? collectionValue(valueRows, prices) : null;
  return (
    <div className="rounded-lg bg-surface p-3">
      <h3 className="mb-2 flex items-baseline justify-between font-mono text-sm">
        <span>Fehlt mir ({totalMissing})</span>
        <span className="text-xs text-muted">{total ? `≈ ${formatEur(total.total)}` : '…'}</span>
      </h3>
      <ul className="space-y-1 font-mono text-sm">
        {rows.map((r) => {
          const e = prices?.get(priceKey({ oracleId: r.oracleId }));
          const sum = e?.eur != null ? e.eur * r.missing : undefined;
          return (
            <li key={r.oracleId} className="flex items-center gap-2">
              <ColorPips colors={cards.get(r.oracleId)?.colorIdentity ?? []} />
              <span className="min-w-0 flex-1 truncate">{cards.get(r.oracleId)?.name ?? r.oracleId}</span>
              <span className="text-danger">{r.missing} fehlen</span>
              <span className="text-xs text-muted">({r.have}/{r.need})</span>
              <span className="w-16 shrink-0 text-right text-xs text-muted">{prices ? formatEur(sum) : ''}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 font-mono text-[10px] text-muted">Richtwerte für die Standardausgabe, nicht-foil.</p>
    </div>
  );
}

function DeckTextView({
  deck, cards, onImport,
}: { deck: Deck; cards: Map<string, Card>; onImport: (lists: { cards: DeckCard[]; sideboard: DeckCard[] }) => void }) {
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
        // Tokens gehören nicht ins Deck (M14) — nur echte Karten auflösen.
        const id = nameHit?.oracleId ?? (await db.cards.where('normName').equals(norm).filter((c) => !isTokenCard(c)).first())?.oracleId;
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
