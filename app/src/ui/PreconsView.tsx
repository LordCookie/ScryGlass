import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getMeta } from '../db/db';
import {
  listPrecons, listOwnedPrecons, preconDetails, addPreconToCollection, previewPreconRemoval,
  removePreconFromCollection, PRECONS_META_KEY, type PreconDetails, type AddPreconResult,
} from '../data/precons';
import {
  PRECON_GROUPS, filterPrecons, preconTypeLabel, preconDeckSize, preconMakesDeck, preconBookings, ownedCoverage,
  type PreconHead,
} from '../domain/precons';
import { primaryType } from '../domain/deckStats';
import { TYPE_LABEL } from '../domain/collectionFilter';
import type { OwnedPrecon, Precon, PreconCard, PreconGroup } from '../domain/types';
import { CardImage } from './CardImage';
import { PixelCheckbox } from './PixelCheckbox';
import { useBackHandler } from './backStack';
import { openDeck } from './deckNav';

/**
 * Fertigdecks (Precons, PLAN.md M19) unter Sammlung: suchen, ansehen, mit einem Tipp in
 * die Sammlung — und wieder heraus, wenn das Deck verkauft ist. Listen von MTGJSON.
 */

const PAGE = 30;
const nf = new Intl.NumberFormat('de-DE');
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function plural(n: number, one: string, many: string): string {
  return `${nf.format(n)} ${n === 1 ? one : many}`;
}

function year(date: string): string {
  return date.slice(0, 4);
}

/** Kartenbild fürs Fertigdeck: Commander, sonst die erste Karte. */
function coverPrinting(p: Precon): string | undefined {
  return p.commander[0]?.p ?? p.main[0]?.p;
}

export function PreconsView() {
  const all = useLiveQuery(() => listPrecons(), []);
  const mine = useLiveQuery(() => listOwnedPrecons(), []);
  const meta = useLiveQuery(() => getMeta<PreconHead['meta']>(PRECONS_META_KEY), []);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<PreconGroup | null>('commander');
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<Precon | null>(null);
  useEffect(() => setLimit(PAGE), [query, group]);
  useBackHandler(open != null, () => setOpen(null));

  // Bei Suchtext über alle Gruppen suchen — wer „Zhalfir" tippt, will nicht erst den Filter lösen.
  const hits = useMemo(
    () => (all ? filterPrecons(all, { query, group: query.trim() ? null : group }) : []),
    [all, query, group],
  );
  const mineKeys = useMemo(() => new Set((mine ?? []).map((m) => m.key)), [mine]);

  if (open) return <PreconDetail precon={open} onBack={() => setOpen(null)} />;

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-surface p-4">
        <input data-hotkey="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Fertigdeck suchen (Name, Set oder Commander)…"
          className="mb-2 w-full border-2 border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-paper"
        />
        <div className="flex flex-wrap gap-1 font-mono text-xs">
          {PRECON_GROUPS.map((g) => (
            <button key={g.key} onClick={() => setGroup(group === g.key ? null : g.key)} aria-pressed={group === g.key}
              disabled={!!query.trim()}
              className={`px-2 py-1 disabled:opacity-40 ${group === g.key && !query.trim() ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {mine && mine.length > 0 && !query.trim() && <OwnedPrecons list={mine} all={all} onOpen={setOpen} />}

      {all === undefined ? (
        <p className="px-1 font-mono text-sm text-muted">Lade…</p>
      ) : all.length === 0 ? (
        <p className="px-1 font-mono text-sm text-muted">
          Die Fertigdecks kommen mit dem nächsten Katalog-Update (Mehr → Katalog).
        </p>
      ) : (
        <>
          <p className="px-1 font-mono text-xs text-muted">
            {plural(hits.length, 'Fertigdeck', 'Fertigdecks')}{query.trim() ? ` mit „${query.trim()}"` : ''} · neueste zuerst
          </p>
          <ul className="space-y-2">
            {hits.slice(0, limit).map((p) => (
              <li key={p.key}>
                <button onClick={() => setOpen(p)} className="frame flex w-full items-center gap-3 p-2 text-left font-mono">
                  <CardImage scryfallId={coverPrinting(p)} name={p.name} size="small" className="h-16 w-11 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text">{p.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {preconTypeLabel(p.type)} · {p.set.toUpperCase()}{p.date ? ` · ${year(p.date)}` : ''}
                    </span>
                    <span className="block text-xs text-muted">
                      {plural(preconDeckSize(p), 'Karte', 'Karten')}
                      {mineKeys.has(p.key) && <span className="ml-2 text-accent">in deiner Sammlung</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {hits.length > limit && (
            <button onClick={() => setLimit((l) => l + PAGE)}
              className="w-full bg-surface px-3 py-2 font-mono text-sm text-accent hover:bg-elevated">
              Mehr anzeigen ({nf.format(hits.length - limit)} weitere)
            </button>
          )}
        </>
      )}
      <p className="px-1 font-mono text-[10px] text-muted">
        Decklisten von{' '}
        <a href="https://mtgjson.com" target="_blank" rel="noreferrer" className="text-accent underline">MTGJSON</a>
        {meta?.date ? ` (Stand ${meta.date})` : ''}. Kaufbare Produkte: Commander-, Einsteiger- und Duel Decks,
        Jumpstart, Secret Lair und mehr.
      </p>
    </div>
  );
}

/** „Deine Fertigdecks" — was schon in der Sammlung steckt. */
function OwnedPrecons({ list, all, onOpen }: { list: OwnedPrecon[]; all: Precon[] | undefined; onOpen: (p: Precon) => void }) {
  const byKey = useMemo(() => new Map((all ?? []).map((p) => [p.key, p])), [all]);
  const deckIds = useLiveQuery(async () => new Set((await db.decks.toCollection().primaryKeys()) as number[]), []);
  const [removing, setRemoving] = useState<OwnedPrecon | null>(null);
  return (
    <div className="rounded-lg bg-surface p-4 font-mono text-xs">
      <h3 className="mb-2 font-hud text-[9px] text-text">DEINE FERTIGDECKS</h3>
      <ul className="space-y-2">
        {list.map((op) => {
          const p = byKey.get(op.key);
          return (
            <li key={op.id} className="flex flex-wrap items-center gap-2">
              <button disabled={!p} onClick={() => p && onOpen(p)} className="min-w-0 flex-1 text-left hover:text-accent disabled:hover:text-text">
                <span className="block truncate text-sm text-text">{op.copies > 1 ? `${op.copies}× ` : ''}{op.name}</span>
                <span className="block text-muted">{op.set.toUpperCase()} · hinzugefügt am {dateFmt.format(op.addedAt)}</span>
              </button>
              {op.deckId != null && deckIds?.has(op.deckId) && (
                <button onClick={() => openDeck(op.deckId!)} className="bg-bg px-2 py-1 text-muted hover:text-text">Deck öffnen</button>
              )}
              <button onClick={() => setRemoving(op)} className="bg-bg px-2 py-1 text-muted hover:text-danger">Entfernen</button>
            </li>
          );
        })}
      </ul>
      {removing && (
        <RemovePrecon op={removing} hasDeck={removing.deckId != null && !!deckIds?.has(removing.deckId)} onDone={() => setRemoving(null)} />
      )}
    </div>
  );
}

function RemovePrecon({ op, hasDeck, onDone }: { op: OwnedPrecon; hasDeck: boolean; onDone: () => void }) {
  const [preview, setPreview] = useState<{ total: number; missing: number } | null>(null);
  const [withDeck, setWithDeck] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void previewPreconRemoval(op).then(setPreview); }, [op]);
  async function remove() {
    setBusy(true);
    try {
      await removePreconFromCollection(op, { deleteDeck: withDeck });
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 bg-bg p-3">
      <p className="mb-1 text-text">„{op.name}" aus der Sammlung nehmen?</p>
      {preview && (
        <p className="mb-2 text-muted">
          Zieht {plural(preview.total - preview.missing, 'Karte', 'Karten')} wieder ab.
          {preview.missing > 0 && ` ${plural(preview.missing, 'Karte ist', 'Karten sind')} schon nicht mehr da — die bleiben weg.`}
          {' '}Andere Exemplare derselben Karten bleiben.
        </p>
      )}
      {hasDeck && (
        <PixelCheckbox checked={withDeck} onChange={setWithDeck} className="my-2">
          Auch das Deck „{op.name}" löschen
        </PixelCheckbox>
      )}
      <div className="flex gap-2">
        <button disabled={busy || !preview} onClick={() => void remove()}
          className="rounded border border-border px-3 py-1.5 text-sm hover:border-danger hover:text-danger disabled:opacity-40">
          Entfernen
        </button>
        <button disabled={busy} onClick={onDone} className="px-3 py-1.5 text-sm text-muted hover:text-text">Abbrechen</button>
      </div>
    </div>
  );
}

const SECTION_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Sonstige'];

/** Vorschau eines Fertigdecks mit „Zur Sammlung hinzufügen". */
function PreconDetail({ precon: p, onBack }: { precon: Precon; onBack: () => void }) {
  const [details, setDetails] = useState<PreconDetails | null>(null);
  const owned = useLiveQuery(async () => {
    const m = new Map<string, number>();
    for (const o of await db.owned.toArray()) m.set(o.oracleId, (m.get(o.oracleId) ?? 0) + o.qty);
    return m;
  }, []);
  const [copies, setCopies] = useState(1);
  const [withTokens, setWithTokens] = useState(true);
  const [createDeck, setCreateDeck] = useState(() => preconMakesDeck(p));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AddPreconResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void preconDetails(p).then(setDetails); }, [p]);

  const booking = useMemo(
    () => (details ? preconBookings(p, details.printings, { copies, withTokens }) : null),
    [details, p, copies, withTokens],
  );
  const coverage = useMemo(
    () => (details && owned ? ownedCoverage(p, details.printings, owned) : null),
    [details, owned, p],
  );

  async function add() {
    setBusy(true);
    setError(null);
    try {
      setDone(await addPreconToCollection(p, { copies, withTokens: withTokens && p.tokens.length > 0, createDeck }));
    } catch (e) {
      setError(`Hinzufügen fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const name = (c: PreconCard) => {
    const info = details?.printings.get(c.p);
    return info ? details!.cards.get(info.oracleId)?.name ?? '?' : 'Unbekannte Karte';
  };
  const sections = useMemo(() => {
    if (!details) return [];
    const byType = new Map<string, PreconCard[]>();
    for (const c of p.main) {
      const info = details.printings.get(c.p);
      const card = info ? details.cards.get(info.oracleId) : undefined;
      const t = card ? primaryType(card) : 'Sonstige';
      byType.set(t, [...(byType.get(t) ?? []), c]);
    }
    const out: { title: string; cards: PreconCard[] }[] = [];
    if (p.commander.length) out.push({ title: 'Commander', cards: p.commander });
    for (const t of SECTION_ORDER) {
      const cards = byType.get(t);
      if (cards) out.push({ title: TYPE_LABEL[t] ?? t, cards });
    }
    if (p.side.length) out.push({ title: 'Sideboard', cards: p.side });
    if (p.extra.length) out.push({ title: 'Liegt bei (nicht im Deck)', cards: p.extra });
    if (p.tokens.length) out.push({ title: 'Tokens', cards: p.tokens });
    return out;
  }, [details, p]);

  const total = booking ? booking.cards + booking.tokens : 0;

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="px-1 font-mono text-sm text-muted hover:text-text">← Fertigdecks</button>
      <div className="rounded-lg bg-surface p-4 font-mono">
        <div className="flex gap-3">
          <CardImage scryfallId={coverPrinting(p)} name={p.name} size="normal" className="h-auto w-28 shrink-0" />
          <div className="min-w-0 flex-1 text-xs">
            <h2 className="mb-1 text-base text-text">{p.name}</h2>
            <p className="text-muted">{preconTypeLabel(p.type)}</p>
            <p className="text-muted">{p.set.toUpperCase()}{p.date ? ` · ${dateFmt.format(new Date(p.date))}` : ''}</p>
            <p className="mt-1 text-muted">{plural(preconDeckSize(p), 'Karte', 'Karten')}{p.tokens.length ? ` + ${plural(p.tokens.reduce((s, c) => s + c.n, 0), 'Token', 'Tokens')}` : ''}</p>
            {coverage && coverage.have > 0 && (
              <p className="mt-1 text-text">Davon hast du schon {nf.format(coverage.have)}.</p>
            )}
          </div>
        </div>

        {done ? (
          <div className="mt-3 bg-bg p-3 text-xs">
            <p className="text-text">
              {plural(done.cards, 'Karte', 'Karten')}{done.tokens ? ` und ${plural(done.tokens, 'Token', 'Tokens')}` : ''} hinzugefügt
              {done.deckId != null ? ' · Deck angelegt' : ''}.
            </p>
            {done.extraCommanders > 0 && (
              <p className="mt-1 text-muted">Der zweite Commander liegt im Hauptdeck — Decks kennen bisher nur einen.</p>
            )}
            {done.unknown > 0 && (
              <p className="mt-1 text-muted">{plural(done.unknown, 'Karte kennt', 'Karten kennt')} der Katalog nicht — nicht gebucht.</p>
            )}
            {done.deckId != null && (
              <button onClick={() => openDeck(done.deckId!)} className="mt-2 rounded bg-accent px-3 py-1.5 text-sm text-on-accent">
                Deck öffnen
              </button>
            )}
          </div>
        ) : (
          <div className="mt-3 space-y-1 text-xs">
            <PixelCheckbox checked={createDeck} onChange={setCreateDeck}>
              Auch als Deck anlegen{p.group === 'commander' ? ' (mit Commander — dann läuft gleich der Deck-Check)' : ''}
            </PixelCheckbox>
            {p.tokens.length > 0 && (
              <PixelCheckbox checked={withTokens} onChange={setWithTokens}>Tokens mit dazu</PixelCheckbox>
            )}
            <div className="flex items-center gap-1 pt-1 text-muted">
              Anzahl
              {[1, 2].map((n) => (
                <button key={n} onClick={() => setCopies(n)} aria-pressed={copies === n}
                  className={`px-2 py-1 ${copies === n ? 'bg-fill text-paper' : 'bg-bg text-muted hover:text-text'}`}>{n}×</button>
              ))}
            </div>
            {booking && booking.unknown > 0 && (
              <p className="text-muted">{plural(booking.unknown, 'Karte kennt', 'Karten kennt')} der Katalog nicht — die wird nicht gebucht.</p>
            )}
            <button disabled={busy || !booking || total === 0} onClick={() => void add()}
              className="mt-2 rounded bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-40">
              Zur Sammlung hinzufügen{booking ? ` (${plural(total, 'Karte', 'Karten')})` : ''}
            </button>
            {error && <p className="text-danger">{error}</p>}
          </div>
        )}
      </div>

      {!details ? (
        <p className="px-1 font-mono text-sm text-muted">Lade Liste…</p>
      ) : (
        sections.map((s) => (
          <div key={s.title} className="rounded-lg bg-surface p-3 font-mono text-xs">
            <h3 className="mb-1 font-hud text-[9px] text-text">
              {s.title.toUpperCase()} ({s.cards.reduce((n, c) => n + c.n, 0)})
            </h3>
            <ul>
              {s.cards.map((c, i) => {
                const info = details.printings.get(c.p);
                const have = info && !info.token ? owned?.get(info.oracleId) ?? 0 : 0;
                return (
                  <li key={`${c.p}-${c.f}-${i}`} className="flex gap-2">
                    <span className="w-8 shrink-0 text-right text-muted">{c.n}×</span>
                    <span className={`min-w-0 flex-1 truncate ${info ? 'text-text' : 'text-muted'}`}>{name(c)}</span>
                    {c.f !== 'nonfoil' && <span className="text-accent">✦ {c.f}</span>}
                    {have > 0 && <span className="text-muted">hast {have}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
