import type { Card, Lang } from '../domain/types';
import type { CollectorInfo } from '../domain/cardText';
import { fuseScan, type FuseConfig, type FuseResult } from '../domain/scanFuse';
import { matchTokenName, tokenOcrSignal, tokenSetCandidates, artScore } from '../domain/tokens';
import { nearestByHashMulti, nearestPrintingsOf, type HashMatch } from './imageHash';
import { findPrinting } from './printingLookup';
import { printingsOf } from './cards';
import { loadTokenCatalog } from './tokenCatalog';

/**
 * Scanner-Auswertung für Spielsteine/Embleme (Großes Token-Update, PLAN.md M14): Name,
 * Artwork (Bild-Hash im Token-Bereich) und Druckinfo gegen den Token-Teil des Katalogs.
 *
 * Anders als bei Karten zählt hier das ARTWORK: Token-Namen sind nicht eindeutig
 * („Soldier" gibt es dutzendfach), und gesammelt wird je Druckausgabe. Deshalb ist der
 * Name allein nie „sicher" für den Auto-Korb — erst Bildtreffer oder Druckinfo legen
 * die Ausgabe fest.
 */

export interface TokenArt {
  oracleId: string;
  card: Card;
  scryfallId: string;
  score: number;
  method: string;
  lang: Lang;
}

export interface TokenScanResult {
  fused: FuseResult;
  /** Artwork-Kandidaten, bester zuerst (leer = Token nicht gefunden) */
  arts: TokenArt[];
  /** Bildtreffer im Token-Bereich, fürs Protokoll */
  hash: HashMatch | null;
  /** gelesene Druckinfo im Token-Set, fürs Protokoll */
  printRead?: string;
}

/** So viele Artworks zur Auswahl (Treffer + Alternativen). */
export const TOKEN_ARTS = 4;

export interface TokenScanInput {
  titleText: string;
  /** Query-Hashes des Bildes (Varianten) */
  hashes?: readonly string[];
  /** schon im Token-Bereich gesuchter Bildtreffer (native Kamera); sonst aus `hashes` */
  tokenHash?: HashMatch | null;
  collector: CollectorInfo | null;
  cfg: FuseConfig;
}

/** `null`: der Katalog kennt (noch) keine Tokens — dann zählt der Scanner nur. */
export async function scanToken(inp: TokenScanInput): Promise<TokenScanResult | null> {
  const cat = await loadTokenCatalog();
  if (cat.oracleIds.size === 0) return null;

  const hits = inp.titleText ? matchTokenName(inp.titleText, cat.byName) : [];
  const hash = inp.tokenHash !== undefined ? inp.tokenHash : inp.hashes?.length ? nearestByHashMulti(inp.hashes, undefined, 'token') : null;

  // Druckinfo: aufgedruckt ist das Haupt-Set („BLB"), die Ausgabe liegt im Token-Set.
  const col = inp.collector;
  let print: { oracleId: string; scryfallId: string; lang: Lang; set: string } | undefined;
  if (col?.set && col.number) {
    for (const s of tokenSetCandidates(col.set)) {
      const p = await findPrinting(s, col.number, col.lang);
      if (p && cat.oracleIds.has(p.oracleId)) {
        print = p;
        break;
      }
    }
  }

  const fused0 = fuseScan(
    tokenOcrSignal(hits, hash?.oracleId),
    hash ? { oracleId: hash.oracleId, distance: hash.distance, margin: hash.margin } : null,
    inp.cfg,
    print ? { oracleId: print.oracleId } : null,
  );
  // Der Name allein legt das Artwork nicht fest → nie automatisch übernehmen.
  const fused: FuseResult = fused0.method === 'ocr' ? { ...fused0, confident: false } : fused0;

  const lang: Lang = print?.lang ?? 'en';
  const arts: TokenArt[] = [];
  const push = (oracleId: string, scryfallId: string, score: number, method: string) => {
    const card = cat.cards.get(oracleId);
    if (card && !arts.some((a) => a.scryfallId === scryfallId)) arts.push({ oracleId, card, scryfallId, score, method, lang });
  };

  // 1) Exakte Ausgabe: Druckinfo bzw. Bildtreffer.
  if (fused.method === 'druck' && print) push(print.oracleId, print.scryfallId, fused.score, 'druck');
  else if ((fused.method === 'bild' || fused.method === 'bild+ocr') && hash) push(hash.oracleId, hash.scryfallId, fused.score, fused.method);

  // 2) Weitere Artworks der in Frage kommenden Tokens, bildnächste zuerst.
  const oracles = new Set(hits.map((h) => h.oracleId));
  if (fused.oracleId) oracles.add(fused.oracleId);
  const ranked = inp.hashes?.length ? nearestPrintingsOf(inp.hashes, oracles, TOKEN_ARTS + 1) : [];
  for (const r of ranked) push(r.oracleId, r.scryfallId, artScore(r.distance), 'bild');
  // 3) Ohne Bild-Index: die Ausgaben der gelesenen Namen, unsicher.
  if (ranked.length === 0 && oracles.size > 0) {
    for (const p of await printingsOf([...oracles], TOKEN_ARTS)) push(p.oracleId, p.scryfallId, 0.5, 'ocr');
  }

  return {
    fused,
    arts: arts.slice(0, TOKEN_ARTS),
    hash,
    printRead: col ? [print?.set ?? col.set ?? '?', col.number ?? '?', col.lang ?? ''].join(' ').trim() : undefined,
  };
}
