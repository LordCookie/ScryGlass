import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Scheduler } from 'tesseract.js';
import jsQR from 'jsqr';
import { matchOcr } from '../data/matcher';
import { getCards, previewImageIds } from '../data/cards';
import { searchCards } from '../data/search';
import { phashFromCanvas, nearestByHashMulti, hashCount, hashIndicesFor, distanceToOracle, betterMatch, type HashMatch } from '../data/imageHash';
import { getScanDiag } from '../data/scanDiag';
import { snapCard, hashVariantRects, type Rect } from '../domain/cardSnap';
import { fuseScan, type FuseConfig, type FuseResult } from '../domain/scanFuse';
import {
  pickNameLine, cleanNameText, collectorText, parseCollectorText, looksLikeToken, textLooksLikeToken, type CollectorInfo,
} from '../domain/cardText';
import { setPickerOptions, type SetOption } from '../domain/nextSet';
import { getSetList } from '../data/nextSet';
import { findPrinting, setMembers, catalogSetCodes, type SetMembers } from '../data/printingLookup';
import { ScryCamera, hasNativeCamera, reticleOf, type NativeFrame, type CameraMode } from '../native/scryCamera';
import type { PluginListenerHandle } from '@capacitor/core';
import { NativeScanOverlay } from './NativeScanOverlay';
import {
  observeFrame, mayAutoAdd, afterAutoAdd, AUTO_BASKET_START, type AutoBasketState,
} from '../domain/autoBasket';
import { feedbackAdded, unlockAudio } from '../native/feedback';
import { useLiveQuery } from 'dexie-react-hooks';
import { addTokens, getTokenCount } from '../data/tokens';
import { normalizeName } from '../domain/nameMatch';
import { PixelIcon } from './PixelIcon';
import { laplacianVariance, normalizedPoint } from '../domain/focus';
import { pickBestRead, ocrEffectiveScore, type OcrRead } from '../domain/ocrQuality';
import {
  pushEntry, markAll, patchEntry, canUndo, HISTORY_STATE_LABEL, type HistoryEntry,
} from '../domain/scanHistory';
import { addOwned, addOwnedBatch, getMeta, setMeta, logScan, markScanRejected } from '../db/db';
import { CardImage } from './CardImage';
import type { Card, Finish, Lang, BasketEntry, Printing } from '../domain/types';
import { ManaCost, ColorPips } from './mana';
import {
  subscribe as subscribePeers,
  getPeers,
  getDeviceId,
  getDeviceName,
  type ScanTarget,
} from '../peer/peerStore';
import { pair, sendBasket, PeerError } from '../peer/peerClient';
import { parsePairingUrl, type BasketPayload } from '../peer/protocol';
import { PixelCheckbox } from './PixelCheckbox';

/**
 * Kartenscanner (PLAN.md § 6). OCR-Ansatz: Titelbalken oben lesen, Namen unscharf
 * gegen den Katalog matchen (§ 5). Alles lokal. Neu ggü. engram: der Katalog hat
 * 30k+ Karten (async Matcher über Dexie), MTG-Mana/-Farben, und ein **Scan-Ziel**
 * (§ 8): eigene Sammlung oder ein verbundener Peer.
 */

const CARD_ASPECT = 745 / 1040; // MTG-Kartenverhältnis
const THUMB_W = 24;
const THUMB_H = 34;
const FRAME_SAME = 6;

// Bild-Matching (Scanner v2): Schwellen für einen pHash-Treffer (0..256).
// Datenbasis aus echten Scans: KORREKTE Treffer lagen bei Distanz 26–52 mit Margin
// 26–50 (Abstand zur nächsten FREMDEN Karte); verschiedene Karten min ≈ 72.
// Der Margin ist das eigentliche Confidence-Signal → Auto-Übernahme daran festmachen.
const HASH_MAX_DIST = 60; // als Kandidat zeigen (klar unter dem False-Minimum ~72)
const HASH_MIN_MARGIN = 12; // muss klar besser als die nächste FREMDE Karte sein
const HASH_AUTO_DIST = 56; // Auto-Übernahme: Distanz-Obergrenze
const HASH_AUTO_MARGIN = 18; // Auto-Übernahme: klarer Abstand zur zweitbesten fremden Karte

// Kreuz-Bestätigung (Tier 1): Wenn OCR UND Bild dieselbe Karte liefern, darf das Bild
// lockerer sein (dist bis knapp unter das False-Minimum ~72, kleiner Margin) — ein
// unabhängiger Doppel-Fehler auf dieselbe Karte ist praktisch ausgeschlossen.
const FUSE_CFG: FuseConfig = {
  hashMaxDist: HASH_MAX_DIST,
  hashMinMargin: HASH_MIN_MARGIN,
  hashAutoDist: HASH_AUTO_DIST,
  hashAutoMargin: HASH_AUTO_MARGIN,
  hashConfirmDist: 70,
  hashConfirmMargin: 4,
  ocrConfident: 0.85,
  ocrConfirm: 0.6,
};
// Set-Modus: nur ~800 statt 155.000 Kandidaten → deutlich weniger Verwechsler, die
// Bild-Schwellen dürfen lockerer sein (Startwerte, per Scan-Protokoll nachtunen).
const FUSE_CFG_SET: FuseConfig = {
  ...FUSE_CFG,
  hashMaxDist: 70,
  hashMinMargin: 8,
  hashAutoDist: 64,
  hashAutoMargin: 12,
};
// Zeitlicher Konsens: so viele Frames hintereinander dieselbe Karte, bevor im Live-
// Modus automatisch übernommen wird (Kreuz-Bestätigung darf sofort).
const AUTO_CONSENSUS = 2;

// Schärfe-Gate (Autofokus, Tier 1): Laplace-Varianz unter diesem Wert = unscharf →
// Live-Frames überspringen. Startwert konservativ; per Scan-Protokoll nachtunen.
const SHARP_MIN = 30;

const isNativeApp =
  typeof window !== 'undefined' &&
  !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

function otsuThreshold(hist: number[], total: number): number {
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thr = t; }
  }
  return thr;
}

function binarizeOtsu(d: Uint8ClampedArray, total: number): void {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const thr = otsuThreshold(hist, total);
  for (let i = 0; i < d.length; i += 4) {
    const bw = d[i] >= thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = bw;
  }
}

/** Adaptive (lokale) Binarisierung nach Bradley — robust gegen Glanz/Foils (§ 6). */
function binarizeAdaptive(d: Uint8ClampedArray, w: number, h: number): void {
  const n = w * h;
  const gray = new Float64Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) gray[p] = d[i];
  const W = w + 1;
  const integ = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integ[(y + 1) * W + (x + 1)] = integ[y * W + (x + 1)] + rowSum;
    }
  }
  const S = Math.max(8, Math.floor(Math.min(w, h) / 3));
  const half = S >> 1;
  const T = 0.15;
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integ[(y2 + 1) * W + (x2 + 1)] - integ[y1 * W + (x2 + 1)] - integ[(y2 + 1) * W + x1] + integ[y1 * W + x1];
      const p = y * w + x, i = p * 4;
      const bw = gray[p] * count <= sum * (1 - T) ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = bw;
    }
  }
}

interface ScanMatch {
  oracleId: string;
  card: Card;
  scryfallId?: string;
  score: number;
  method: string;
  lang: Lang;
}

/** Eingabe der gemeinsamen Auswertung (Web- und nativer Kamerapfad). */
interface EvalInput {
  mode: 'live' | 'full';
  /** saubere Namenszeile (Titel) — zuerst exakt/Präfix abgleichen */
  titleText: string;
  /** gesamter gelesener Text — Fuzzy-Fallback */
  fullText: string;
  /** Sicherheit der Namenslesung 0..100 */
  ocrConf: number;
  hashMatch: HashMatch | null;
  sharpness: number;
  /** Druckinfo (Set/Nummer) — nur die native Kamera liest sie */
  collector: CollectorInfo | null;
  /** Query-Hashes des Bildes (für den Abstand zur bestätigten Karte im Protokoll) */
  hashes?: string[];
  /** Diagnose: ausgewerteter Ausschnitt (JPEG, Base64) */
  crop?: string;
  /** native Kamera: Abbildung Rahmen → Analysebild */
  cropMap?: string;
  /** native Kamera: Karte eingerastet statt Rahmen */
  cropSnapped?: boolean;
  /** Spielstein/Emblem erkannt — nicht im Katalog, also nichts zuordnen */
  isToken?: boolean;
}

interface BasketItem {
  oracleId: string;
  card: Card;
  scryfallId?: string;
  qty: number;
  finish: Finish;
  ocrRaw: string;
  confidence: number;
  lang: Lang;
}

/** Kurzlabel, wie ein Treffer zustande kam (Trefferliste, Verlauf). */
function methodLabel(method: string): string {
  if (method === 'bild+ocr') return 'Bild+Text';
  if (method === 'bild') return 'Bild';
  if (method === 'manuell') return 'manuell';
  if (method === 'druck') return 'Sammlernr.';
  return 'Text'; // exact | prefix | fuzzy aus dem Namensabgleich
}

const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function confidenceLabel(score: number): { label: string; cls: string } {
  if (score >= 0.85) return { label: 'sehr sicher', cls: 'text-ok' };
  if (score >= 0.6) return { label: 'wahrscheinlich', cls: 'text-accent' };
  return { label: 'unsicher', cls: 'text-danger' };
}

// Externer Peer-Store als React-Quelle.
function usePeers() {
  return useSyncExternalStore(subscribePeers, getPeers, getPeers);
}

export function ScannerPanel() {
  const peers = usePeers();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const schedulerRef = useRef<Scheduler | null>(null);
  const busyRef = useRef(false);

  const [workerReady, setWorkerReady] = useState(false);
  // Tesseract nur für die Browser-Kamera: in der App liest ML Kit, dann wird es erst
  // geladen, wenn doch die Browser-Kamera läuft (QR-Pairing, Rückfall).
  const [needOcr, setNeedOcr] = useState(() => !hasNativeCamera());
  const [camOn, setCamOn] = useState(false);
  const [camBoot, setCamBoot] = useState(false); // Pixel-„Power-on" beim Start
  const [camError, setCamError] = useState<string | null>(null);
  const [vdim, setVdim] = useState<{ w: number; h: number } | null>(null);

  const [boxScale, setBoxScale] = useState(0.82);
  const [zoomCaps, setZoomCaps] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [live, setLive] = useState(false);
  const [scanDelay] = useState(350);
  const [autoAdd, setAutoAdd] = useState(false);
  const [blurry, setBlurry] = useState(false); // Schärfe-Gate: aktuelles Bild unscharf
  const [focusFx, setFocusFx] = useState<{ x: number; y: number } | null>(null); // Tap-Feedback
  const [focusHint, setFocusHint] = useState<string | null>(null);
  const focusFxTimer = useRef<number>();

  const [scanning, setScanning] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [matches, setMatches] = useState<ScanMatch[]>([]);
  // Spielstein im Bild (nicht im Katalog) → Hinweis statt falscher Karte; Tokens werden
  // nur gezählt (data/tokens). Kennung je Token-Name für die Kartenwechsel-Logik.
  const [tokenSeen, setTokenSeen] = useState(false);
  const tokenIdRef = useRef('token:?');
  const tokenCount = useLiveQuery(() => getTokenCount(), []) ?? 0;
  const [finish, setFinish] = useState<Finish>('nonfoil');
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [added, setAdded] = useState(0);
  // Auto-Übernahme-Hinweis mit Rückgängig (entryId → Verlaufseintrag).
  const [autoToast, setAutoToast] = useState<{ name: string; entryId: number; token?: boolean } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]); // Scan-Verlauf (neueste zuerst)
  const historyIdRef = useRef(0);
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [sendMsg, setSendMsg] = useState<string | null>(null);

  // Scan-Ziel (§ 8): lokal oder ein Peer. Default „Meine Sammlung".
  const [target, setTarget] = useState<ScanTarget>({ kind: 'local' });
  const [pairing, setPairing] = useState(false);
  const [pairMsg, setPairMsg] = useState<string | null>(null);
  const [hashN, setHashN] = useState(0); // Karten im Bild-Hash-Index (Scanner v2)

  // Manueller Fallback (§ 6): Full-Art/textless/Secret-Lair haben keinen lesbaren
  // Titelbalken → Karte suchen statt Fehltreffer riskieren.
  const [manualQuery, setManualQuery] = useState('');
  const [manualResults, setManualResults] = useState<Card[]>([]);

  // Auto-Korb: Kartenwechsel-Erkennung (Stapel-Scan), siehe domain/autoBasket.ts.
  const autoBasketRef = useRef<AutoBasketState>(AUTO_BASKET_START);
  // Auto-Korb wird gemerkt (Vibration: Einstellung unter „Mehr", native/feedback.ts).
  const prefsTouchedRef = useRef(false);

  // Set-Modus: '' = alle Sets. Mitglieder + Hash-Teilmenge des gewählten Sets.
  const [scanSet, setScanSet] = useState('');
  const [setOptions, setSetOptions] = useState<SetOption[]>([]);
  const setDataRef = useRef<{ members: SetMembers; subset: Int32Array | null } | null>(null);
  const userChoseSetRef = useRef(false);

  // Native Kamera (ScryCamera-Plugin, nur Android-App): Overlay statt <video>.
  const [nativeOn, setNativeOn] = useState(false);
  const [nativeMode, setNativeMode] = useState<CameraMode>('card'); // 'qr' = Pairing
  const [qrHint, setQrHint] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState(0); // Rahmen blitzt bei jeder Übernahme (A6)
  const nativeOnRef = useRef(false);
  const nativeListenerRef = useRef<PluginListenerHandle | null>(null);
  const reticleElRef = useRef<HTMLDivElement>(null);
  // Frame-Handler über eine Ref, damit das einmal registrierte Event immer den
  // aktuellen Zustand (Auto, Ausführung, Set …) sieht.
  const onFrameRef = useRef<(f: NativeFrame) => void>(() => {});
  // Zeitlicher Konsens fürs Auto-Add: gleiche Karte über mehrere Frames zählen.
  const consensusRef = useRef<{ oracleId: string; count: number }>({ oracleId: '', count: 0 });
  // Letzter Scan (OCR + Bild-Hash) — Rohdaten fürs Fixture-Protokoll (§ 5).
  const lastScanRef = useRef<{
    at: number;
    ocrRaw: string;
    ocrBestOracle?: string;
    ocrScore?: number;
    ocrMethod?: string;
    hashOracle?: string;
    hashDist?: number;
    hashMargin?: number;
    sharpness?: number;
    ocrConf?: number;
    printRead?: string;
    hashes?: string[];
    crop?: string;
    cropMap?: string;
    cropSnapped?: boolean;
  } | null>(null);
  // Scanner-Diagnose (Mehr → Scanner-Protokoll): Ausschnitt live zeigen + mitspeichern.
  const diagRef = useRef(false);
  const [diag, setDiag] = useState(false);
  const [diagCrop, setDiagCrop] = useState<string | null>(null);
  const [diagSnapped, setDiagSnapped] = useState(false);
  const lastThumbRef = useRef<Uint8Array | null>(null);
  const thumbCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const autoToastTimer = useRef<number>();

  // OCR-Worker-Pool laden (dynamischer Import → eigener Chunk, schneller App-Start).
  useEffect(() => {
    if (!needOcr) return;
    let alive = true;
    void (async () => {
      const { createWorker, createScheduler, PSM } = await import('tesseract.js');
      if (!alive) return;
      const scheduler = createScheduler();
      schedulerRef.current = scheduler;
      const poolSize = Math.min(3, Math.max(1, navigator.hardwareConcurrency || 2));
      for (let i = 0; i < poolSize; i++) {
        try {
          const worker = await createWorker('eng');
          await worker.setParameters({
            // Titelbalken ist eine Zeile (§ 6, --psm 7). Whitelist: Buchstaben (beide
            // Schreibweisen, inkl. Umlaute für deutsche Karten), Ziffern (Sammlernummer),
            // Leerzeichen, ' , -.
            tessedit_pageseg_mode: PSM.SINGLE_LINE,
            tessedit_char_whitelist:
              "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÄÖÜäöüß0123456789 ,'-",
          });
          if (!alive) {
            await worker.terminate();
            return;
          }
          scheduler.addWorker(worker);
          if (i === 0) setWorkerReady(true);
        } catch {
          if (i === 0) break;
        }
      }
    })();
    return () => {
      alive = false;
      void schedulerRef.current?.terminate();
      schedulerRef.current = null;
    };
  }, [needOcr]);

  // Browser-Kamera beim Verlassen des Scanners stoppen.
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  // Gemerktes Ziel bei verlorener Verbindung zurücksetzen.
  useEffect(() => {
    if (target.kind === 'peer' && !peers.some((p) => p.url === target.url)) {
      setTarget({ kind: 'local' });
    }
  }, [peers, target]);

  // Bild-Hash-Index lädt im Hintergrund (App) — Status fürs UI mitziehen.
  useEffect(() => {
    setHashN(hashCount());
    const id = window.setInterval(() => setHashN(hashCount()), 2000);
    return () => window.clearInterval(id);
  }, []);

  // Manuelle Suche (Fallback) — debounced gegen den Katalog.
  useEffect(() => {
    let alive = true;
    if (manualQuery.trim()) void searchCards(manualQuery, 6).then((r) => { if (alive) setManualResults(r); });
    else setManualResults([]);
    return () => { alive = false; };
  }, [manualQuery]);

  // Set-Modus: zuletzt gewähltes Set sofort wiederherstellen; die Auswahl-Liste
  // (Katalog-Sets + gecachte Namen) kommt danach — sie zu bauen dauert einen Moment.
  useEffect(() => {
    void getMeta<string>('scanSet').then((last) => {
      // Kam die Nutzerwahl schneller (auch „Alle Sets"), gewinnt sie.
      if (last && !userChoseSetRef.current) setScanSet(last);
    });
    void Promise.all([catalogSetCodes(), getSetList()]).then(([codes, infos]) =>
      setSetOptions(setPickerOptions(codes, infos)),
    );
  }, []);

  // Auto-Korb wie zuletzt eingestellt (eine schnellere Nutzerwahl gewinnt).
  useEffect(() => {
    void getMeta<boolean>('scanAuto').then((a) => {
      if (!prefsTouchedRef.current && typeof a === 'boolean') setAutoAdd(a);
    });
    // Diagnose wird unter „Mehr" geschaltet (Scanner ist dann nicht gemountet).
    void getScanDiag().then((d) => {
      diagRef.current = d;
      setDiag(d);
    });
  }, []);

  function toggleAuto(on: boolean) {
    prefsTouchedRef.current = true;
    setAutoAdd(on);
    autoBasketRef.current = AUTO_BASKET_START; // frischer Start: die Karte im Bild darf sofort
    void setMeta('scanAuto', on);
  }


  /** Unscharfes Live-Bild: zählt als Kartenwechsel (Hand in Bewegung) und bricht den Konsens. */
  function noteBlurryFrame() {
    autoBasketRef.current = observeFrame(autoBasketRef.current, { blurry: true, hasCard: false });
    consensusRef.current = { oracleId: '', count: 0 };
  }

  /** Nur eine echte Auswahl des Nutzers wird gemerkt (nicht der Startzustand). */
  function chooseSet(code: string) {
    userChoseSetRef.current = true;
    setScanSet(code);
    void setMeta('scanSet', code);
  }

  // Set gewechselt → seine Ausgaben laden (Hash-Teilmenge baut sich lazy).
  useEffect(() => {
    setDataRef.current = null;
    consensusRef.current = { oracleId: '', count: 0 };
    if (!scanSet) return;
    let alive = true;
    void setMembers(scanSet).then((m) => {
      if (alive) setDataRef.current = { members: m, subset: null };
    });
    return () => { alive = false; };
  }, [scanSet]);

  // Native Kamera beim Verlassen des Scanners sicher beenden.
  useEffect(() => {
    nativeOnRef.current = nativeOn;
  }, [nativeOn]);
  useEffect(
    () => () => {
      if (!nativeOnRef.current) return;
      document.documentElement.classList.remove('scan-native');
      void nativeListenerRef.current?.remove();
      void ScryCamera.stop().catch(() => {});
    },
    [],
  );

  // Modus-Wechsel (QR ↔ Karte) ändert die Rahmenform → neu melden, sobald gezeichnet.
  useEffect(() => {
    if (!nativeOn) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => sendReticle()));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeMode, nativeOn]);

  // Fenstergröße/Drehung ändert die Rahmenlage → dem nativen Ausschnitt mitteilen.
  // Erst messen, wenn das (evtl. auf Querformat umgebaute) Overlay gezeichnet ist;
  // der ResizeObserver fängt zusätzlich jede Größenänderung des Rahmens selbst.
  useEffect(() => {
    if (!nativeOn) return;
    let id = 0;
    const h = () => {
      cancelAnimationFrame(id);
      id = requestAnimationFrame(() => { id = requestAnimationFrame(() => sendReticle()); });
    };
    window.addEventListener('resize', h);
    const el = reticleElRef.current;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(h) : null;
    if (el) ro?.observe(el);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', h);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeOn]);

  function cropRegion() {
    if (!vdim) return null;
    let sh = vdim.h * boxScale;
    let sw = sh * CARD_ASPECT;
    if (sw > vdim.w * 0.98) {
      sw = vdim.w * 0.98;
      sh = sw / CARD_ASPECT;
    }
    return { sx: (vdim.w - sw) / 2, sy: (vdim.h - sh) / 2, sw, sh };
  }

  function regionCanvas(
    sub: [number, number, number, number],
    targetW: number,
    // 'none' = nur Graustufe + Kontrast (Tesseracts LSTM liest das oft besser).
    binarize: 'otsu' | 'adaptive' | 'none' = 'adaptive',
  ): HTMLCanvasElement | null {
    const video = videoRef.current;
    const region = cropRegion();
    if (!video || !region) return null;
    const sx = region.sx + sub[0] * region.sw;
    const sy = region.sy + sub[1] * region.sh;
    const sw = sub[2] * region.sw;
    const sh = sub[3] * region.sh;
    const targetH = Math.max(1, Math.round((targetW * sh) / sw));
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);

    const img = ctx.getImageData(0, 0, targetW, targetH);
    const d = img.data;
    const n = d.length / 4;
    const hist = new Array<number>(256).fill(0);
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      d[i] = g;
      hist[g]++;
      sum += g;
    }
    const cut = n * 0.02;
    let acc = 0, lo = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cut) { lo = v; break; } }
    acc = 0; let hi = 255;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cut) { hi = v; break; } }
    const range = Math.max(1, hi - lo);
    // Alte Rahmen: helle Schrift auf dunklem Balken → invertieren (§ 6, Heuristik
    // über die mittlere Helligkeit des Crops).
    const invert = sum / n < 128;
    for (let i = 0; i < d.length; i += 4) {
      let v = ((d[i] - lo) / range) * 255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (invert) v = 255 - v;
      d[i] = v | 0;
    }
    if (binarize === 'adaptive') binarizeAdaptive(d, targetW, targetH);
    else if (binarize === 'otsu') binarizeOtsu(d, n);
    else for (let i = 0; i < d.length; i += 4) d[i + 1] = d[i + 2] = d[i]; // Graustufe fertig
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** Roher (unbearbeiteter) Karten-Ausschnitt fürs Bild-Hashing (Scanner v2).
   *  `inset` zieht den Rahmen an allen Seiten etwas enger (gegen lockeres Framing). */
  function rawCropCanvas(inset = 0): HTMLCanvasElement | null {
    const video = videoRef.current;
    const region = cropRegion();
    if (!video || !region) return null;
    const cw = 146;
    const ch = 204;
    const dx = region.sw * inset;
    const dy = region.sh * inset;
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, region.sx + dx, region.sy + dy, region.sw - 2 * dx, region.sh - 2 * dy, 0, 0, cw, ch);
    return c;
  }

  /** 180°-Drehung eines Ausschnitts (fängt kopfüber gehaltene Karten ab). */
  function rotate180(src: HTMLCanvasElement): HTMLCanvasElement | null {
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.translate(c.width, c.height);
    ctx.rotate(Math.PI);
    ctx.drawImage(src, 0, 0);
    return c;
  }

  /** Mehrere Query-Hashes eines Frames: Basis, enger, 180°-gedreht (Tier 1). */
  function frameHashes(): string[] {
    const base = rawCropCanvas(0);
    const tight = rawCropCanvas(0.05);
    const variants: HTMLCanvasElement[] = [];
    if (base) {
      variants.push(base);
      const rot = rotate180(base);
      if (rot) variants.push(rot);
    }
    if (tight) variants.push(tight);
    return variants.map((v) => phashFromCanvas(v)).filter((h): h is string => !!h);
  }

  /** Graustufen der Kartenregion (fürs Schärfemaß, Autofokus/Tier 1). */
  function regionGray(targetW = 128): { gray: Uint8Array; w: number; h: number } | null {
    const video = videoRef.current;
    const region = cropRegion();
    if (!video || !region) return null;
    const w = targetW;
    const h = Math.max(1, Math.round((targetW * region.sh) / region.sw));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      gray[j] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    }
    return { gray, w, h };
  }

  function frameThumb(): Uint8Array | null {
    const video = videoRef.current;
    const region = cropRegion();
    if (!video || !region) return null;
    let cv = thumbCanvasRef.current;
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = THUMB_W;
      cv.height = THUMB_H;
      thumbCanvasRef.current = cv;
    }
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, THUMB_W, THUMB_H);
    const d = ctx.getImageData(0, 0, THUMB_W, THUMB_H).data;
    const out = new Uint8Array(THUMB_W * THUMB_H);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      out[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }
    return out;
  }
  function thumbDiff(a: Uint8Array, b: Uint8Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  async function enrich(cands: { oracleId: string; score: number; method: string; lang: Lang }[]): Promise<ScanMatch[]> {
    const ids = cands.map((c) => c.oracleId);
    const [cards, imgs] = await Promise.all([getCards(ids), previewImageIds(ids)]);
    const out: ScanMatch[] = [];
    for (const c of cands) {
      const card = cards.get(c.oracleId);
      if (!card) continue;
      out.push({ oracleId: c.oracleId, card, scryfallId: imgs.get(c.oracleId), score: c.score, method: c.method, lang: c.lang });
    }
    return out;
  }

  /** Set-Modus-Daten; die Hash-Teilmenge entsteht, sobald der Bild-Index geladen ist. */
  function currentSetData(): { members: SetMembers; subset: Int32Array | null } | null {
    const d = setDataRef.current;
    if (d && !d.subset && hashCount() > 0) d.subset = hashIndicesFor(d.members.scryfallIds);
    return d;
  }

  /** Ausschnitt `r` eines Bildes im Hash-Format 146×204. */
  function regionToCard(img: CanvasImageSource, r: Rect): HTMLCanvasElement | null {
    const c = document.createElement('canvas');
    c.width = 146;
    c.height = 204;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, r.l, r.t, r.r - r.l, r.b - r.t, 0, 0, 146, 204);
    return c;
  }

  /**
   * Bild-Hashes für Ausschnitte eines Bildes (native Kamera), dazu die 180°-Drehung des
   * ersten. `base` = der erste Ausschnitt (fürs Diagnose-Bildchen).
   */
  function cardHashes(img: CanvasImageSource, rects: readonly Rect[]): { hashes: string[]; base: HTMLCanvasElement | null } {
    const canv = rects.map((r) => regionToCard(img, r));
    const base = canv[0];
    const all = [...canv];
    if (base) all.push(rotate180(base));
    const hashes = all.filter((c): c is HTMLCanvasElement => !!c).map((c) => phashFromCanvas(c)).filter((x) => !!x);
    return { hashes, base };
  }

  /** Graustufen (0..255) eines Bildes — fürs Einrasten der Karte. */
  function grayOf(img: HTMLImageElement): { gray: Uint8Array; w: number; h: number } | null {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx || w === 0 || h === 0) return null;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return { gray, w, h };
  }

  /** Diagnose-Bild fürs Protokoll: Ausschnitt mit Luft, Rahmen gelb, Einrast-Rechteck grün. */
  function annotate(img: HTMLImageElement, reticle: Rect, snapped: Rect | null): string | undefined {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffd400';
    ctx.strokeRect(reticle.l + 0.5, reticle.t + 0.5, reticle.r - reticle.l, reticle.b - reticle.t);
    if (snapped) {
      ctx.strokeStyle = '#3fbf8f';
      ctx.strokeRect(snapped.l + 0.5, snapped.t + 0.5, snapped.r - snapped.l, snapped.b - snapped.t);
    }
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  function decodeJpeg(b64: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Ausschnitt nicht lesbar'));
      img.src = `data:image/jpeg;base64,${b64}`;
    });
  }

  /** Top-Treffer für Bild- oder Druckinfo-Entscheidungen — mit exaktem Artwork. */
  async function topMatch(fused: FuseResult, hash: HashMatch | null, print: Printing | undefined): Promise<ScanMatch | null> {
    let oracleId: string | undefined;
    let scryfallId: string | undefined;
    if (fused.method === 'druck' && print) {
      oracleId = print.oracleId;
      scryfallId = print.scryfallId;
    } else if ((fused.method === 'bild' || fused.method === 'bild+ocr') && hash) {
      oracleId = hash.oracleId;
      scryfallId = hash.scryfallId;
    } else {
      return null;
    }
    const card = (await getCards([oracleId])).get(oracleId);
    if (!card) return null;
    if (!scryfallId) scryfallId = (await previewImageIds([oracleId])).get(oracleId);
    return { oracleId, card, scryfallId, score: fused.score, method: fused.method, lang: print?.lang ?? 'en' };
  }

  /**
   * Gemeinsame Auswertung für beide Kamerawege (Web: Tesseract, nativ: ML Kit):
   * Name abgleichen → Druckinfo nachschlagen → fusionieren → anzeigen → Konsens →
   * ggf. automatisch in den Korb.
   */
  async function evaluate(inp: EvalInput): Promise<void> {
    const setData = currentSetData();
    setOcrText(inp.titleText || inp.fullText);

    // 0) Spielstein/Emblem: steht nicht im Katalog — sonst fände der Abgleich den
    //    ähnlichsten echten Namen („Mouse" → „Mouse Trapper") und der Auto-Korb nähme ihn.
    if (inp.isToken) {
      const tokenId = `token:${normalizeName(inp.titleText) || '?'}`;
      tokenIdRef.current = tokenId;
      setTokenSeen(true);
      setMatches([]);
      consensusRef.current = { oracleId: '', count: 0 };
      // Ein liegender Token zählt wie eine Karte im Bild (sonst gälte jedes dritte Bild
      // als Wechsel und er würde immer wieder gezählt).
      autoBasketRef.current = observeFrame(autoBasketRef.current, { blurry: false, hasCard: true });
      if (autoAdd && target.kind === 'local' && mayAutoAdd(autoBasketRef.current, tokenId)) countToken(tokenId);
      return;
    }
    setTokenSeen(false);

    // 1) Name: saubere Titelzeile zuerst (exakt/Präfix), sonst Volltext (Fuzzy).
    //    OCR-Schwelle 0.62: schwammige Reads sollen keine falschen Namen erzeugen.
    let result = inp.titleText ? await matchOcr(inp.titleText, { topN: 5, threshold: 0.62 }) : null;
    if (!result?.best && inp.fullText) result = await matchOcr(inp.fullText, { topN: 5, threshold: 0.62 });
    let cands = result?.candidates ?? [];
    if (setData) cands = cands.filter((c) => setData.members.oracleIds.has(c.oracleId));
    const shown = await enrich(cands);

    // 2) Druckinfo → exakte Ausgabe. Im Set-Modus genügt die Nummer.
    const col = inp.collector;
    const printSet = setData?.members.code ?? col?.set;
    const print = printSet && col?.number ? await findPrinting(printSet, col.number, col.lang) : undefined;

    // 3) Fusion: Druckinfo/Kreuz-Bestätigung > starker Bildtreffer > sicheres OCR.
    const ocrBest = shown[0];
    const fused = fuseScan(
      // Unsichere Lesung → OCR allein nicht mehr auto-fähig, bestätigen geht noch.
      { oracleId: ocrBest?.oracleId, score: ocrEffectiveScore(ocrBest?.score ?? 0, inp.ocrConf), ambiguous: result?.ambiguous ?? false },
      inp.hashMatch ? { oracleId: inp.hashMatch.oracleId, distance: inp.hashMatch.distance, margin: inp.hashMatch.margin } : null,
      setData ? FUSE_CFG_SET : FUSE_CFG,
      print ? { oracleId: print.oracleId } : null,
    );

    // 4) Anzeige: fusionierter Bester oben.
    let finalMatches = shown;
    const top = await topMatch(fused, inp.hashMatch, print);
    if (top) {
      // Starker Alleingang des Bildes: nur ihn zeigen (kein OCR-Rauschen).
      finalMatches = fused.showAlone ? [top] : [top, ...shown.filter((m) => m.oracleId !== top.oracleId)];
    }
    setMatches(finalMatches);

    // Rohdaten des Scans fürs Fixture-Protokoll merken (ungefiltert).
    const text = inp.fullText || inp.titleText;
    lastScanRef.current = {
      at: Date.now(),
      ocrRaw: text,
      ocrBestOracle: shown[0]?.oracleId,
      ocrScore: shown[0]?.score,
      ocrMethod: shown[0]?.method,
      hashOracle: inp.hashMatch?.oracleId,
      hashDist: inp.hashMatch?.distance,
      hashMargin: inp.hashMatch?.margin,
      sharpness: inp.sharpness,
      ocrConf: inp.ocrConf,
      printRead: col ? [printSet ?? '?', col.number ?? '?', col.lang ?? ''].join(' ').trim() : undefined,
      hashes: inp.hashes,
      crop: inp.crop,
      cropMap: inp.cropMap,
      cropSnapped: inp.cropSnapped,
    };

    const best = finalMatches[0];
    // Zeitlicher Konsens: gleiche Karte über mehrere Frames zählen (Bestätigungen
    // dürfen sofort). Verhindert, dass ein Ausreißer-Frame eine falsche Karte auto-addet.
    if (fused.oracleId && fused.confident) {
      if (consensusRef.current.oracleId === fused.oracleId) consensusRef.current.count += 1;
      else consensusRef.current = { oracleId: fused.oracleId, count: 1 };
    } else {
      consensusRef.current = { oracleId: '', count: 0 };
    }
    const required = inp.mode === 'live' && !fused.agree ? AUTO_CONSENSUS : 1;
    const consensusOk = fused.confident && consensusRef.current.count >= required;
    // Auto-Korb (Stapel-Scan): Bild verbuchen; eine andere Karte darf sofort, dieselbe
    // erst nach einem echten Wechsel (Hand/Leere) — sonst würde die liegende Karte
    // bei jedem Bild erneut gezählt.
    autoBasketRef.current = observeFrame(autoBasketRef.current, { blurry: false, hasCard: !!best });
    if (autoAdd && best && consensusOk && mayAutoAdd(autoBasketRef.current, best.oracleId)) {
      const entryId = addToBasket(best, text, true); // setzt den Kartenwechsel-Zustand
      setAutoToast({ name: best.card.name, entryId });
      window.clearTimeout(autoToastTimer.current);
      // Länger sichtbar als früher, damit „Rückgängig" gut erreichbar ist.
      autoToastTimer.current = window.setTimeout(() => setAutoToast(null), 4000);
    }
  }

  /** Web-Kamera-Pfad (Browser/PWA, oder Fallback): <video> + Tesseract. */
  async function scan(mode: 'live' | 'full' = 'full') {
    const scheduler = schedulerRef.current;
    if (!scheduler || busyRef.current) return;
    if (mode === 'live') {
      const thumb = frameThumb();
      if (thumb) {
        const last = lastThumbRef.current;
        if (last && last.length === thumb.length && thumbDiff(thumb, last) < FRAME_SAME) return;
        lastThumbRef.current = thumb;
      }
    }
    // Schärfe-Gate (Autofokus/Tier 1): Laplace-Varianz messen. Unscharfe Live-Frames
    // überspringen (spart OCR/Hash und verhindert schlechte Treffer). Beim manuellen
    // „Scannen" trotzdem lesen (expliziter Wunsch), nur Hinweis zeigen.
    let sharpness = 0;
    const g = regionGray(128);
    if (g) sharpness = laplacianVariance(g.gray, g.w, g.h);
    setBlurry(sharpness > 0 && sharpness < SHARP_MIN);
    if (mode === 'live' && g && sharpness < SHARP_MIN) {
      noteBlurryFrame();
      return;
    }
    // Titel in zwei Varianten (Graustufe + adaptives Schwarzweiß) — die Lesung mit der
    // höheren Tesseract-Sicherheit gewinnt; Ganzkarte als Sicherheitsnetz.
    const TITLE: [number, number, number, number] = [0.04, 0.045, 0.92, 0.13];
    const bandGray = regionCanvas(TITLE, 900, 'none');
    const bandBin = regionCanvas(TITLE, 900, 'adaptive');
    const whole = regionCanvas([0, 0, 1, 1], 820, 'otsu');
    // Bild-Hash vom aktuellen Frame — matcht das ARTWORK (rettet Showcase-/Full-Art).
    let hashMatch: HashMatch | null = null;
    let hashes: string[] = [];
    if (hashCount() > 0) {
      // Mehrere Ausschnitt-Varianten + 180°-Drehung → besten Treffer nehmen (Tier 1).
      hashes = frameHashes();
      if (hashes.length) hashMatch = nearestByHashMulti(hashes, currentSetData()?.subset ?? undefined);
    }
    const crop = diagRef.current ? rawCropCanvas(0)?.toDataURL('image/jpeg', 0.85).split(',')[1] : undefined;
    if (!bandBin) return;
    busyRef.current = true;
    setScanning(true);
    try {
      const rec = (c: HTMLCanvasElement | null): Promise<OcrRead> =>
        c
          ? scheduler.addJob('recognize', c).then((r) => ({ text: r.data.text ?? '', confidence: r.data.confidence ?? 0 }))
          : Promise.resolve({ text: '', confidence: 0 });
      const [grayRead, binRead, wholeRead] = await Promise.all([rec(bandGray), rec(bandBin), rec(whole)]);
      const title = pickBestRead([grayRead, binRead]);
      // Sicherheit der Namenslesung; ohne Titel-Text zählt die Ganzkarten-Lesung.
      const ocrConf = title.text ? title.confidence : wholeRead.confidence;
      const fullText = `${title.text} ${wholeRead.text}`.replace(/\s+/g, ' ').trim();
      await evaluate({
        mode, titleText: title.text.replace(/\s+/g, ' ').trim(), fullText, ocrConf, hashMatch, sharpness, collector: null,
        hashes, crop, isToken: textLooksLikeToken(fullText),
      });
    } catch {
      /* einzelne Erkennung fehlgeschlagen — nächster Versuch */
    } finally {
      busyRef.current = false;
      setScanning(false);
    }
  }

  /** Nativer Kamera-Pfad: ein ausgewertetes Bild vom ScryCamera-Plugin (ML Kit). */
  async function onNativeFrame(f: NativeFrame) {
    if (f.qr) {
      void onNativeQr(f.qr);
      return;
    }
    if (f.blurry) {
      setBlurry(true);
      noteBlurryFrame();
      return;
    }
    setBlurry(false);
    if (busyRef.current) return;
    busyRef.current = true;
    setScanning(true);
    try {
      const lines = f.lines ?? [];
      const nameLine = pickNameLine(lines);
      const fullText = lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
      const collector = parseCollectorText(collectorText(lines));
      let hashMatch: HashMatch | null = null;
      let hashes: string[] = [];
      let cropSnapped: boolean | undefined;
      let diagImg: string | undefined; // fürs Protokoll (nur mit Diagnose)
      if (f.wide && f.wideInset) {
        // Karte im Ausschnitt mit Luft einrasten (§ 6.2, Schritt 3), dann hashen.
        const img = await decodeJpeg(f.wide);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const reticle: Rect = { l: f.wideInset.l * w, t: f.wideInset.t * h, r: f.wideInset.r * w, b: f.wideInset.b * h };
        const g = grayOf(img);
        const snap = g ? snapCard(g.gray, g.w, g.h, reticle) : { rect: reticle, snapped: false, score: 0 };
        cropSnapped = snap.snapped;
        if (hashCount() > 0) {
          const setData = currentSetData();
          const subset = setData?.subset ?? undefined;
          const cfg = setData ? FUSE_CFG_SET : FUSE_CFG;
          // Eingerastet: erst die eingerasteten Varianten; ist das schon auto-sicher, reicht
          // es. Sonst zusätzlich (als Netz) der Rahmen wie bisher — der größere Vorsprung
          // gewinnt. Nicht eingerastet: nur der Rahmen mit Versatz-Varianten.
          const snapV = snap.snapped ? cardHashes(img, hashVariantRects(snap.rect, true)) : null;
          const mSnap = snapV ? nearestByHashMulti(snapV.hashes, subset) : null;
          const strong = !!mSnap && mSnap.distance <= cfg.hashAutoDist && mSnap.margin >= cfg.hashAutoMargin;
          const retV = strong ? null : cardHashes(img, hashVariantRects(reticle, false).slice(0, snap.snapped ? 2 : undefined));
          const mRet = retV ? nearestByHashMulti(retV.hashes, subset) : null;
          hashMatch = betterMatch(mSnap, mRet);
          hashes = [...(snapV?.hashes ?? []), ...(retV?.hashes ?? [])];
          if (diagRef.current) {
            const used = snapV && hashMatch === mSnap ? snapV.base : retV?.base;
            const shown = used?.toDataURL('image/jpeg', 0.85).split(',')[1];
            if (shown) setDiagCrop(shown);
          }
        }
        if (diagRef.current) {
          setDiagSnapped(snap.snapped);
          diagImg = annotate(img, reticle, snap.snapped ? snap.rect : null);
        }
      } else if (f.crop) {
        // Ältere Plugin-Version ohne Einrast-Ausschnitt: der Rahmen selbst.
        const img = await decodeJpeg(f.crop);
        if (hashCount() > 0) {
          hashes = cardHashes(img, hashVariantRects({ l: 0, t: 0, r: img.naturalWidth, b: img.naturalHeight }, false)).hashes;
          if (hashes.length) hashMatch = nearestByHashMulti(hashes, currentSetData()?.subset ?? undefined);
        }
        if (diagRef.current) {
          setDiagCrop(f.crop);
          setDiagSnapped(false);
          diagImg = f.crop;
        }
      }
      // ML-Kit-Sicherheit 0..1 → 0..100; fehlt sie (0/undefined), nicht deckeln.
      const conf = nameLine?.conf;
      const ocrConf = nameLine ? (conf && conf > 0 ? conf * 100 : 100) : 0;
      await evaluate({
        mode: 'live', titleText: nameLine ? cleanNameText(nameLine.text) : '', fullText, ocrConf, hashMatch,
        sharpness: f.sharpness, collector, hashes, crop: diagImg, cropMap: f.mapping, cropSnapped,
        isToken: looksLikeToken(lines),
      });
    } catch {
      /* einzelnes Bild fehlgeschlagen — das nächste kommt gleich */
    } finally {
      busyRef.current = false;
      setScanning(false);
    }
  }
  onFrameRef.current = (f) => void onNativeFrame(f);

  // QR-Pairing (§ 8): QR-Inhalt → Pairing-URL → verbinden. Gemeinsam für Web- und native Kamera.
  async function connectFromQr(data: string): Promise<boolean> {
    const info = parsePairingUrl(data);
    if (!info) return false; // irgendein anderer QR-Code — ignorieren
    busyRef.current = true;
    setQrHint('Verbinde…');
    try {
      const { conn, hello } = await pair(info);
      setTarget({ kind: 'peer', ...conn });
      setPairing(false);
      setPairMsg(`Verbunden mit „${hello.deviceName}".`);
      setQrHint(null);
      feedbackAdded(); // spürbar: verbunden
      return true;
    } catch (e) {
      const msg = e instanceof PeerError ? e.message : 'Pairing fehlgeschlagen.';
      setPairMsg(msg);
      setQrHint(msg);
      return false;
    } finally {
      busyRef.current = false;
    }
  }

  // Web-Kamera: QR aus dem <video>-Bild lesen.
  async function scanQr() {
    const video = videoRef.current;
    if (!video || busyRef.current || !video.videoWidth) return;
    const cv = document.createElement('canvas');
    cv.width = video.videoWidth;
    cv.height = video.videoHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const code = jsQR(img.data, img.width, img.height);
    if (code) await connectFromQr(code.data);
  }

  // Native Kamera: QR aus dem quadratischen Ausschnitt lesen. Danach geht es direkt
  // im Karten-Modus weiter — Scan-Ziel ist dann das verbundene Gerät.
  async function onNativeQr(b64: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    let text: string | null = null;
    try {
      const img = await decodeJpeg(b64);
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, cv.width, cv.height);
        text = jsQR(d.data, d.width, d.height)?.data ?? null;
      }
    } catch {
      /* nächstes Bild */
    } finally {
      busyRef.current = false;
    }
    if (text && (await connectFromQr(text))) {
      setNativeMode('card');
      await ScryCamera.setMode({ mode: 'card' });
    }
  }

  useEffect(() => {
    if (!camOn) return;
    if (pairing) {
      const id = window.setInterval(() => void scanQr(), 400);
      return () => window.clearInterval(id);
    }
    if (live && workerReady) {
      const id = window.setInterval(() => void scan('live'), Math.max(150, scanDelay));
      return () => window.clearInterval(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camOn, pairing, live, workerReady, boxScale, vdim, autoAdd, scanDelay]);

  /** Scanner starten: in der App die native Kamera (CameraX + ML Kit), sonst die Web-Kamera. */
  function startScanner() {
    unlockAudio(); // Ton darf nur nach einer Nutzer-Geste starten — die ist genau hier
    if (hasNativeCamera()) void startNative();
    else void startWebCamera();
  }

  async function startNative(mode: CameraMode = 'card') {
    setCamError(null);
    setNativeMode(mode);
    document.documentElement.classList.add('scan-native');
    nativeOnRef.current = true;
    setNativeOn(true);
    try {
      // Overlay muss gerendert sein, bevor wir die Lage des Scan-Rahmens messen.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
      const el = reticleElRef.current;
      const rect = el ? reticleOf(el) : { left: 0.1, top: 0.2, width: 0.8, height: 0.55 };
      nativeListenerRef.current = await ScryCamera.addListener('frame', (f) => onFrameRef.current(f));
      const caps = await ScryCamera.start({ ...rect, mode });
      setTorchAvailable(caps.torch);
      setTorchOn(false);
    } catch (e) {
      await stopNative();
      setCamError(`${e instanceof Error ? e.message : 'Native Kamera nicht verfügbar'} — nutze die Browser-Kamera.`);
      void startWebCamera();
    }
  }

  async function stopNative() {
    document.documentElement.classList.remove('scan-native');
    nativeOnRef.current = false;
    setNativeOn(false);
    await nativeListenerRef.current?.remove();
    nativeListenerRef.current = null;
    try {
      await ScryCamera.stop();
    } catch {
      /* war schon aus */
    }
    setTorchAvailable(false);
    setTorchOn(false);
    autoBasketRef.current = AUTO_BASKET_START;
    consensusRef.current = { oracleId: '', count: 0 };
    setBlurry(false);
    setAutoToast(null);
  }

  /** Overlay schließen; im QR-Modus heißt das: Pairing abbrechen. */
  function closeNative() {
    if (nativeMode === 'qr') {
      setPairing(false);
      setPairMsg(null);
    }
    void stopNative();
  }

  /** Aktuelle Lage des Scan-Rahmens an den nativen Ausschnitt melden. */
  function sendReticle() {
    const el = reticleElRef.current;
    if (el && nativeOnRef.current) void ScryCamera.setReticle(reticleOf(el));
  }

  async function startWebCamera() {
    setNeedOcr(true);
    setCamError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() as unknown as {
        zoom?: { min: number; max: number; step?: number };
        torch?: boolean;
        focusMode?: string[];
      };
      if (caps?.zoom) {
        setZoomCaps({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step ?? 0.1 });
        const s = track.getSettings() as unknown as { zoom?: number };
        setZoom(s.zoom ?? caps.zoom.min);
      } else setZoomCaps(null);
      if (caps?.focusMode?.includes('continuous')) {
        void track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as unknown as MediaTrackConstraints);
      }
      // POI initial auf die Mitte (dort ist die Karte) — AF soll nicht den Hintergrund nehmen.
      void track
        .applyConstraints({ advanced: [{ pointsOfInterest: [{ x: 0.5, y: 0.5 }] }] } as unknown as MediaTrackConstraints)
        .catch(() => {});
      setTorchAvailable(!!caps?.torch);
      setTorchOn(false);
      setCamOn(true);
      // Pixel-Startanimation (Power-on) — kurz, rein dekorativ.
      setCamBoot(true);
      window.setTimeout(() => setCamBoot(false), 700);
    } catch (e) {
      setCamError(e instanceof Error ? e.message : 'Kamera nicht verfügbar.');
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamOn(false);
    setVdim(null);
    setTorchAvailable(false);
    setTorchOn(false);
    setPairing(false);
    lastThumbRef.current = null;
    autoBasketRef.current = AUTO_BASKET_START;
    consensusRef.current = { oracleId: '', count: 0 };
    setBlurry(false);
    setFocusFx(null);
    setFocusHint(null);
    setAutoToast(null);
  }

  function applyZoom(value: number) {
    setZoom(value);
    const track = streamRef.current?.getVideoTracks()[0];
    void track?.applyConstraints({ advanced: [{ zoom: value }] } as unknown as MediaTrackConstraints);
  }

  /** Tap-to-Focus (Autofokus/Tier 1): Fokuspunkt auf die getippte Stelle setzen.
   *  Kann das Gerät kein `pointsOfInterest`, wird wenigstens der AF neu angestoßen. */
  async function focusAt(clientX: number, clientY: number, rect: DOMRect) {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || pairing) return;
    const pt = normalizedPoint(clientX, clientY, rect);
    setFocusFx(pt);
    window.clearTimeout(focusFxTimer.current);
    focusFxTimer.current = window.setTimeout(() => setFocusFx(null), 900);
    const caps = track.getCapabilities?.() as unknown as { focusMode?: string[] };
    const continuous = caps?.focusMode?.includes('continuous');
    try {
      await track.applyConstraints({
        advanced: [{ ...(continuous ? { focusMode: 'continuous' } : {}), pointsOfInterest: [pt] }],
      } as unknown as MediaTrackConstraints);
    } catch {
      try {
        if (continuous) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as unknown as MediaTrackConstraints);
        }
      } catch {
        /* AF-Nudge nicht möglich — ignorieren */
      }
      setFocusHint('Tap-to-Focus wird vom Gerät nicht unterstützt.');
      window.setTimeout(() => setFocusHint(null), 2000);
    }
  }

  async function toggleTorch() {
    if (nativeOnRef.current) {
      const next = !torchOn;
      await ScryCamera.setTorch({ on: next });
      setTorchOn(next);
      return;
    }
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  }

  /** Legt eine Karte in den Korb, protokolliert sie und schreibt den Verlauf.
   *  Gibt die Verlaufs-id zurück (für Rückgängig). */
  function addToBasket(m: ScanMatch, ocrRaw: string, auto = false): number {
    const entryId = ++historyIdRef.current;
    // Egal ob automatisch oder per Knopf: dieselbe liegende Karte erst nach einem
    // Kartenwechsel wieder automatisch zählen (kein Doppel durch Knopf + Auto-Korb).
    autoBasketRef.current = afterAutoAdd(m.oracleId);
    // Fixture protokollieren (§ 5): der bestätigte Treffer ist die Ground Truth.
    const via = m.method.startsWith('bild') ? 'bild' : m.method === 'manuell' ? 'manuell' : 'ocr';
    const ls = lastScanRef.current;
    const recent = ls != null && Date.now() - ls.at < 120000;
    if (via !== 'manuell' || recent) {
      void logScan({
        at: Date.now(),
        ocrRaw: (recent ? ls!.ocrRaw : ocrRaw) || '',
        ocrBestOracle: recent ? ls!.ocrBestOracle : undefined,
        ocrScore: recent ? ls!.ocrScore : undefined,
        ocrMethod: recent ? ls!.ocrMethod : undefined,
        hashOracle: recent ? ls!.hashOracle : undefined,
        hashDist: recent ? ls!.hashDist : undefined,
        hashMargin: recent ? ls!.hashMargin : undefined,
        sharpness: recent ? ls!.sharpness : undefined,
        ocrConf: recent ? ls!.ocrConf : undefined,
        printRead: recent ? ls!.printRead : undefined,
        // Diagnose (§ 6.2): wie weit lag die RICHTIGE Karte im Bild-Abgleich entfernt?
        hashDistChosen: recent && ls!.hashes?.length ? distanceToOracle(ls!.hashes, m.oracleId)?.distance : undefined,
        cropMap: recent ? ls!.cropMap : undefined,
        cropSnapped: recent ? ls!.cropSnapped : undefined,
        crop: recent && diagRef.current ? ls!.crop : undefined,
        chosenOracle: m.oracleId,
        chosenName: m.card.name,
        via,
      }).then((logId) => {
        // Protokoll-id merken: beim Rückgängig wird der Eintrag als Fehltreffer markiert.
        if (logId != null) setHistory((h) => patchEntry(h, entryId, { logId }));
      });
    }
    setHistory((h) =>
      pushEntry(h, {
        id: entryId, oracleId: m.oracleId, card: m.card, scryfallId: m.scryfallId,
        finish, method: m.method, auto, at: Date.now(), state: 'basket',
      }),
    );
    setBasket((b) => {
      const i = b.findIndex((x) => x.oracleId === m.oracleId && x.finish === finish);
      if (i >= 0) return b.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x));
      return [
        ...b,
        {
          oracleId: m.oracleId,
          card: m.card,
          scryfallId: m.scryfallId,
          qty: 1,
          finish,
          ocrRaw,
          confidence: m.score,
          lang: m.lang,
        },
      ];
    });
    setAdded(0);
    setSendState('idle');
    // Spürbare Rückmeldung (native Vibration) + kurzer Ton — auch beim Antippen.
    feedbackAdded();
    setFlashKey((k) => k + 1);
    return entryId;
  }

  /** Rückgängig: aus dem Korb bzw. der eigenen Sammlung wieder abziehen und den
   *  Protokolleintrag als Fehltreffer markieren (wertvolles Tuning-Signal). */
  async function undoEntry(e: HistoryEntry) {
    if (!canUndo(e)) return;
    if (e.state === 'basket') basketAdjust(e.oracleId, e.finish, -1);
    else await addOwned(e.oracleId, e.finish, -1);
    setHistory((h) => patchEntry(h, e.id, { state: 'undone' }));
    if (e.logId != null) void markScanRejected(e.logId);
    setAutoToast((t) => (t?.entryId === e.id ? null : t));
  }
  async function addManual(card: Card) {
    const imgs = await previewImageIds([card.oracleId]);
    addToBasket(
      { oracleId: card.oracleId, card, scryfallId: imgs.get(card.oracleId), score: 1, method: 'manuell', lang: 'en' },
      `manuell: ${card.name}`,
    );
    setManualQuery('');
    setManualResults([]);
  }
  function basketAdjust(oracleId: string, fin: Finish, delta: number) {
    setBasket((b) =>
      b
        .map((x) => (x.oracleId === oracleId && x.finish === fin ? { ...x, qty: x.qty + delta } : x))
        .filter((x) => x.qty > 0),
    );
  }

  const basketTotal = basket.reduce((s, it) => s + it.qty, 0);

  /** target=local → in Sammlung; target=peer → senden (§ 8, zwei Aktionen, ein Korb). */
  async function commitLocal() {
    const items = basket;
    await addOwnedBatch(
      items.map((it) => ({ oracleId: it.oracleId, finish: it.finish, qty: it.qty, source: 'scan' as const })),
    );
    setBasket([]);
    setHistory((h) => markAll(h, 'basket', 'collection')); // Rückgängig geht weiter (aus der Sammlung)
    setAdded(items.reduce((s, it) => s + it.qty, 0));
  }

  async function commitPeer() {
    if (target.kind !== 'peer') return;
    setSendState('sending');
    setSendMsg(null);
    const [deviceId, deviceName] = await Promise.all([getDeviceId(), getDeviceName()]);
    const entries: BasketEntry[] = basket.map((it) => ({
      entryId: (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `${it.oracleId}-${Math.random()}`,
      oracleId: it.oracleId,
      lang: it.lang,
      finish: it.finish,
      qty: it.qty,
      ocrRaw: it.ocrRaw,
      confidence: it.confidence,
      scannedAt: Date.now(),
    }));
    // basketId stabil pro Sende-Versuch (aus meta), damit Retry idempotent bleibt.
    let basketId = await getMeta<string>('pendingBasketId');
    if (!basketId) {
      basketId = (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `b-${Date.now()}`;
      await setMeta('pendingBasketId', basketId);
    }
    const payload: BasketPayload = { basketId, deviceId, deviceName, createdAt: Date.now(), entries };
    try {
      const ack = await sendBasket(target, payload);
      // Sender löscht nichts vor ACK; erst jetzt Korb leeren (§ 8, Zuverlässigkeit).
      setBasket([]);
      setHistory((h) => markAll(h, 'basket', 'sent'));
      setSendState('sent');
      setSendMsg(`Gesendet an „${target.deviceName}" — ${ack.accepted} übernommen.`);
      await setMeta('pendingBasketId', '');
    } catch (e) {
      setSendState('error');
      setSendMsg(e instanceof PeerError ? e.message : 'Senden fehlgeschlagen — „Erneut senden".');
    }
  }

  const region = cropRegion();
  const boxWidthPct = region && vdim ? (region.sw / vdim.w) * 100 : 60;
  const best = matches[0]?.score;

  /** Set-Auswahl (im Scanner und im nativen Overlay). */
  const setSelect = (className: string) => (
    <select value={scanSet} onChange={(e) => chooseSet(e.target.value)} aria-label="Set" className={className}>
      <option value="">Alle Sets</option>
      {setOptions.map((o) => (
        <option key={o.code} value={o.code}>{o.label}</option>
      ))}
    </select>
  );

  function undoToast() {
    if (autoToast?.token) {
      void addTokens(-1);
      setAutoToast(null);
      return;
    }
    const e = autoToast ? history.find((x) => x.id === autoToast.entryId) : undefined;
    if (e) void undoEntry(e);
  }

  /** Spielstein zählen (nur eigene Sammlung) — mit Feedback und Rückgängig wie bei Karten. */
  function countToken(tokenId: string) {
    autoBasketRef.current = afterAutoAdd(tokenId); // derselbe Token erst nach einem Wechsel wieder
    void addTokens(1);
    feedbackAdded();
    setFlashKey((k) => k + 1);
    setAutoToast({ name: 'Token', entryId: -1, token: true });
    window.clearTimeout(autoToastTimer.current);
    autoToastTimer.current = window.setTimeout(() => setAutoToast(null), 4000);
  }

  const toastText = autoToast
    ? autoToast.token ? `Token gezählt (${tokenCount})` : `${autoToast.name} in den Korb`
    : null;

  return (
    <section className="space-y-4">
      <div className="rounded-lg bg-surface p-4">
        <h2 className="mb-1 font-mono text-lg">Scanner</h2>
        <p className="mb-2 text-xs text-muted">
          Karte in den Rahmen halten, <b>Name oben gut lesbar</b>. Die App liest den
          Titel per Texterkennung UND gleicht das Kartenbild ab. Alles lokal.
        </p>
        {hashN > 0 && (
          <p className="mb-3 font-mono text-[11px] text-ok">
            ✓ Bild-Abgleich aktiv ({hashN.toLocaleString('de-DE')} Karten) — findet auch
            Showcase-/Borderless-Rahmen.
          </p>
        )}

        {/* Scan-Ziel (§ 8) */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="font-mono text-xs text-muted">Scannen für:</label>
          <select
            value={target.kind === 'local' ? 'local' : target.url}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'local') return setTarget({ kind: 'local' });
              if (v === '__pair') {
                setPairing(true);
                setPairMsg('QR-Code des Empfängers in den Rahmen halten…');
                setQrHint(null);
                // In der App: native Kamera im QR-Modus; im Browser das <video>-Bild.
                unlockAudio();
                if (hasNativeCamera()) void startNative('qr');
                else if (!camOn) void startWebCamera();
                return;
              }
              const p = peers.find((x) => x.url === v);
              if (p) setTarget({ kind: 'peer', ...p });
            }}
            className="rounded border border-border bg-bg px-2 py-1 font-mono text-sm outline-none focus:border-accent"
          >
            <option value="local">Meine Sammlung</option>
            {peers.map((p) => (
              <option key={p.url} value={p.url}>
                → {p.deviceName}
              </option>
            ))}
            <option value="__pair">+ Gerät verbinden…</option>
          </select>
          <label className="ml-auto flex items-center gap-1 font-mono text-xs text-muted">
            Ausführung
            <select
              value={finish}
              onChange={(e) => setFinish(e.target.value as Finish)}
              className="rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent"
            >
              <option value="nonfoil">normal</option>
              <option value="foil">foil</option>
              <option value="etched">etched</option>
            </select>
          </label>
        </div>
        {/* Set-Modus: nur ein Set durchsuchen (Booster öffnen, Sortieren). */}
        <label className="mb-3 flex items-center gap-2 font-mono text-xs text-muted">
          <span className="shrink-0">Set:</span>
          {setSelect('min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-text outline-none focus:border-accent')}
        </label>
        {scanSet && (
          <p className="-mt-2 mb-3 font-mono text-[10px] text-muted">
            Sucht nur in {scanSet.toUpperCase()} — weniger Verwechslungen; die Sammlernummer reicht dann schon.
          </p>
        )}
        {target.kind === 'peer' && (
          <p className="mb-2 rounded bg-accent/10 px-2 py-1 font-mono text-xs text-accent">
            Ziel: Korb geht an „{target.deviceName}" — deine eigene Sammlung bleibt unberührt.
          </p>
        )}
        {pairMsg && <p className="mb-2 font-mono text-xs text-muted">{pairMsg}</p>}

        {/* Kamerabild der Browser-Kamera — nur sichtbar, solange sie läuft (der Knopf
            „Kamera starten" reicht; die App nutzt ohnehin das native Vollbild-Overlay).
            Das <video> bleibt im DOM, weil getUserMedia es beim Start braucht. */}
        <div className={`relative overflow-hidden rounded-md bg-black ${camOn ? '' : 'hidden'}`}>
          <video
            ref={videoRef}
            // leeres Poster statt des grauen WebView-„Play"-Platzhalters
            poster="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
            playsInline
            muted
            onLoadedMetadata={(e) => setVdim({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
            onClick={(e) => { if (camOn && !pairing) void focusAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()); }}
            className={`block h-auto w-full ${camOn && !pairing ? 'cursor-crosshair' : ''}`}
          />
          {/* Tap-to-Focus-Feedback: kurzes Quadrat an der getippten Stelle. */}
          {focusFx && (
            <span
              className="pointer-events-none absolute z-20 h-10 w-10 -translate-x-1/2 -translate-y-1/2 border-2 border-paper"
              style={{ left: `${focusFx.x * 100}%`, top: `${focusFx.y * 100}%` }}
            />
          )}
          {camOn && !pairing && (
            <div
              className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border-2 ${blurry ? 'border-warn/80' : 'border-fill/80'}`}
              style={{ height: `${boxScale * 100}%`, width: `${boxWidthPct}%` }}
            >
              {/* Titelbalken-Zone: Reticle-Ecken (DESIGN § 5 A2) — der Scanner liest hier. */}
              <div className="absolute inset-x-0 top-0 h-[13%]">
                <div className="dither absolute inset-0" />
                <span className="reticle-corner absolute left-0 top-0 h-3 w-3 border-l-2 border-t-2 border-paper" />
                <span className="reticle-corner absolute right-0 top-0 h-3 w-3 border-r-2 border-t-2 border-paper" />
                <span className="reticle-corner absolute bottom-0 left-0 h-3 w-3 border-b-2 border-l-2 border-paper" />
                <span className="reticle-corner absolute bottom-0 right-0 h-3 w-3 border-b-2 border-r-2 border-paper" />
              </div>
            </div>
          )}
          {camBoot && <div className="cam-boot" />}
        </div>

        {camOn && !pairing && (
          <div className="mt-3 space-y-2 font-mono text-xs text-muted">
            <label className="flex items-center gap-2">
              <span className="w-16 shrink-0">Rahmen</span>
              <input type="range" min={0.25} max={0.95} step={0.01} value={boxScale}
                onChange={(e) => setBoxScale(Number(e.target.value))} className="flex-1 accent-accent" />
              <span className="w-10 text-right">{Math.round(boxScale * 100)}%</span>
            </label>
            {zoomCaps && (
              <label className="flex items-center gap-2">
                <span className="w-16 shrink-0">Zoom</span>
                <input type="range" min={zoomCaps.min} max={zoomCaps.max} step={zoomCaps.step} value={zoom}
                  onChange={(e) => applyZoom(Number(e.target.value))} className="flex-1 accent-accent" />
                <span className="w-10 text-right">{zoom.toFixed(1)}×</span>
              </label>
            )}
            <PixelCheckbox checked={live} onChange={setLive}>
              <span>Live-Erkennung (Dauer-/Bulk-Scan)</span>
            </PixelCheckbox>
            <PixelCheckbox checked={autoAdd} onChange={toggleAuto}>
              <span>Auto-Korb: erkannte Karten einzeln in den Korb (Karte für Karte hinlegen)</span>
            </PixelCheckbox>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {!camOn ? (
            <button onClick={startScanner}
              className="rounded border border-border px-3 py-1.5 font-mono text-sm hover:border-accent">
              Kamera starten
            </button>
          ) : (
            <>
              {pairing ? (
                <button onClick={() => { setPairing(false); setPairMsg(null); }}
                  className="rounded border border-border px-3 py-1.5 font-mono text-sm text-muted hover:border-accent">
                  Pairing abbrechen
                </button>
              ) : (
                <button onClick={() => void scan('full')} disabled={!workerReady || scanning}
                  className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent disabled:opacity-40">
                  {scanning ? 'Lese…' : 'Scannen'}
                </button>
              )}
              {torchAvailable && !pairing && (
                <button onClick={() => void toggleTorch()} aria-pressed={torchOn}
                  className={`rounded border px-3 py-1.5 font-mono text-sm ${torchOn ? 'border-accent bg-accent text-on-accent' : 'border-border text-muted hover:border-accent'}`}>
                  <PixelIcon name="torch" className="mr-1.5" />{torchOn ? 'Licht an' : 'Licht aus'}
                </button>
              )}
              <button onClick={stopCamera}
                className="rounded border border-border px-3 py-1.5 font-mono text-sm text-muted hover:border-danger hover:text-danger">
                Kamera stoppen
              </button>
            </>
          )}
          {needOcr && !workerReady && <span className="self-center font-mono text-xs text-muted">Texterkennung lädt…</span>}
        </div>

        {autoToast && (
          <div className="mt-2 flex items-center gap-2 bg-ok/15 px-2 py-1 font-mono text-sm text-ok">
            <span className="min-w-0 flex-1 truncate">✓ {toastText}</span>
            <button
              onClick={undoToast}
              className="shrink-0 px-2 text-xs text-paper underline hover:text-danger"
            >
              Rückgängig
            </button>
          </div>
        )}
        {camOn && !pairing && blurry && !scanning && (
          <p className="mt-2 text-xs text-warn">Unscharf — Abstand ändern &amp; ruhig halten. Aufs Bild tippen stellt scharf.</p>
        )}
        {focusHint && <p className="mt-1 font-mono text-xs text-muted">{focusHint}</p>}
        {ocrText && <p className="mt-2 break-words font-mono text-[10px] text-muted">Gelesen: „{ocrText.slice(0, 120)}"</p>}
        {camOn && typeof best === 'number' && best < 0.6 && !scanning && (
          <p className="mt-1 text-xs text-danger">
            Name nicht sicher erkannt — näher ran/zoomen, gerade halten, bei Foils leicht kippen
            (Reflexe weg). Sonst „Erkannt"-Liste antippen oder Menge im Korb korrigieren.
          </p>
        )}
        {camError && (
          <p className="mt-2 text-sm text-danger">
            Kamera nicht verfügbar: {camError}.{' '}
            {isNativeApp
              ? 'Bitte Kamerazugriff erlauben (Android-Einstellungen → Apps → ScryGlass → Berechtigungen).'
              : 'Am Handy: HTTPS-Adresse öffnen (LAN=1) und Kamerazugriff erlauben.'}
          </p>
        )}

        {/* Manueller Fallback (§ 6): kein lesbarer Titelbalken (Full-Art/textless). */}
        <details className="mt-3">
          <summary className="cursor-pointer select-none font-mono text-xs text-muted">
            Nicht erkannt? Karte manuell suchen
          </summary>
          <input
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
            placeholder="Kartenname (DE oder EN)…"
            className="mt-2 w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          />
          {manualResults.length > 0 && (
            <ul className="mt-2 divide-y divide-white/5 overflow-hidden rounded-md border border-border">
              {manualResults.map((card) => (
                <li key={card.oracleId}>
                  <button
                    onClick={() => void addManual(card)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-sm hover:bg-white/10"
                  >
                    <ColorPips colors={card.colorIdentity} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{card.name}</span>
                      <span className="block truncate text-[10px] text-muted">{card.typeLine}</span>
                    </span>
                    <span className="shrink-0 text-xs text-accent">＋ Korb</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>

      {tokenSeen && matches.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg bg-warn/15 p-3 font-mono text-sm text-warn">
          <span className="min-w-0 flex-1">
            Spielstein (Token) erkannt — Tokens werden nur gezählt (bisher {tokenCount})
            {target.kind === 'peer' ? ', und nur für die eigene Sammlung.' : '.'}
          </span>
          {target.kind === 'local' && (
            <button onClick={() => countToken(tokenIdRef.current)} className="shrink-0 bg-accent px-3 py-1 text-on-accent">＋ Token</button>
          )}
        </div>
      )}

      {matches.length > 0 && (
        <div className="rounded-lg bg-surface p-4">
          <h3 className="mb-2 font-hud text-[10px] text-text">ERKANNT</h3>
          <ol className="space-y-2">
            {matches.map((m, i) => {
              const c = confidenceLabel(m.score);
              // Status-Rahmen (DESIGN § 5 A3/A4): sicher = ok, unsicher = warn.
              const borderColor =
                m.score >= 0.85 ? 'rgb(var(--c-ok))' : m.score < 0.6 ? 'rgb(var(--c-warn))' : 'rgb(var(--c-fill))';
              return (
                <li key={m.oracleId} className="frame font-mono" style={{ borderColor }}>
                  <div className="titlebar" style={{ background: i === 0 ? undefined : 'rgb(var(--c-elevated))' }}>
                    <span className="min-w-0 flex-1 truncate text-text">
                      {i > 0 && <span className="text-muted">{i + 1}. </span>}{m.card.name}
                    </span>
                    <ManaCost cost={m.card.manaCost} />
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 text-sm">
                    {/* Kartenbild zum schnellen Abgleich mit der Karte in der Hand (Top-Treffer größer). */}
                    <CardImage
                      scryfallId={m.scryfallId}
                      name={m.card.name}
                      size={i === 0 ? 'normal' : 'small'}
                      className={i === 0 ? 'h-24 w-[4.3rem] shrink-0' : 'h-14 w-10 shrink-0'}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <ColorPips colors={m.card.colorIdentity} />
                        <span className="text-[10px] text-muted">{methodLabel(m.method)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-muted">{m.card.typeLine}</span>
                    </span>
                    <span className={`font-hud text-[10px] ${c.cls}`}>{Math.round(m.score * 100)}%</span>
                    <button onClick={() => addToBasket(m, ocrText)}
                      className="shrink-0 bg-fill/20 px-2 py-1 text-xs text-accent hover:bg-fill/40">
                      ＋ Korb
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {(basket.length > 0 || added > 0 || sendMsg) && (
        <div className="rounded-lg bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-mono text-sm">Scan-Korb {target.kind === 'peer' && <span className="text-accent">→ {target.deviceName}</span>}</h3>
            {basketTotal > 0 && <span className="rounded-full bg-accent/20 px-2 py-0.5 font-mono text-xs text-accent">{basketTotal} Karten</span>}
          </div>

          {added > 0 && basket.length === 0 && (
            <p className="mb-2 text-sm text-ok">{added} Karte{added === 1 ? '' : 'n'} in die Sammlung übernommen ✓</p>
          )}
          {sendMsg && (
            <p className={`mb-2 text-sm ${sendState === 'error' ? 'text-danger' : 'text-ok'}`}>{sendMsg}</p>
          )}

          {basket.length > 0 && (
            <>
              <ul className="mb-3 space-y-1">
                {basket.map((it) => (
                  <li key={`${it.oracleId}-${it.finish}`} className="flex items-center gap-1.5 font-mono text-sm">
                    <ColorPips colors={it.card.colorIdentity} />
                    <button onClick={() => basketAdjust(it.oracleId, it.finish, -1)} aria-label="weniger" className="px-2 py-1 text-muted hover:text-paper">−</button>
                    <span className="w-9 text-center font-hud text-[10px] text-text">{it.qty}×</span>
                    <button onClick={() => basketAdjust(it.oracleId, it.finish, 1)} aria-label="mehr" className="px-2 py-1 text-muted hover:text-paper">+</button>
                    <span className="min-w-0 flex-1 truncate">{it.card.name}</span>
                    {it.finish !== 'nonfoil' && <span className="text-[10px] text-accent">✦ {it.finish}</span>}
                    {it.confidence < 0.7 && <span className="text-[10px] text-warn" title={`OCR: ${it.ocrRaw}`}>?</span>}
                    <button onClick={() => basketAdjust(it.oracleId, it.finish, -it.qty)} aria-label="entfernen" className="px-2 py-1 text-muted hover:text-danger">✕</button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                {target.kind === 'local' ? (
                  <button onClick={() => void commitLocal()} className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent">
                    In Sammlung übernehmen ({basketTotal})
                  </button>
                ) : (
                  <button onClick={() => void commitPeer()} disabled={sendState === 'sending'}
                    className="rounded bg-accent px-3 py-1.5 font-mono text-sm text-on-accent disabled:opacity-40">
                    {sendState === 'sending' ? 'Sende…' : sendState === 'error' ? 'Erneut senden' : `An „${target.deviceName}" senden`}
                  </button>
                )}
                <button onClick={() => { setBasket([]); setHistory((h) => markAll(h, 'basket', 'discarded')); }}
                  className="rounded border border-border px-3 py-1.5 font-mono text-sm text-muted hover:border-danger hover:text-danger">
                  Korb leeren
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Scan-Verlauf: letzte Übernahmen, Rückgängig solange im Korb/in der Sammlung. */}
      {history.length > 0 && (
        <div className="rounded-lg bg-surface p-4">
          <h3 className="mb-2 font-hud text-[10px] text-text">VERLAUF</h3>
          <ul className="space-y-1.5">
            {history.map((e) => (
              <li key={e.id}
                className={`flex items-center gap-2 font-mono text-sm ${e.state === 'undone' || e.state === 'discarded' ? 'opacity-50' : ''}`}>
                <CardImage scryfallId={e.scryfallId} name={e.card.name} className="h-10 w-7 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${e.state === 'undone' ? 'line-through' : ''}`}>{e.card.name}</span>
                  <span className="block truncate text-[10px] text-muted">
                    {timeFmt.format(e.at)} · {methodLabel(e.method)}{e.auto ? ' · auto' : ''}
                    {e.finish !== 'nonfoil' ? ` · ✦ ${e.finish}` : ''} · {HISTORY_STATE_LABEL[e.state]}
                  </span>
                </span>
                {canUndo(e) && (
                  <button onClick={() => void undoEntry(e)} aria-label="Rückgängig" title="Rückgängig"
                    className="shrink-0 bg-fill/20 px-2 py-1 text-xs text-accent hover:bg-fill/40">
                    ↶
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Native Kamera: Vollbild-Overlay über dem Kamerabild (Portal in <body>). */}
      {nativeOn && (
        <NativeScanOverlay
          reticleRef={reticleElRef}
          onTap={(x, y) => void ScryCamera.focus({ x, y })}
          onClose={closeNative}
          mode={nativeMode}
          flashKey={flashKey}
          qrHint={qrHint}
          notice={tokenSeen ? 'Spielstein (Token) erkannt' : null}
          token={tokenSeen ? { count: tokenCount, onAdd: target.kind === 'local' ? () => countToken(tokenIdRef.current) : undefined } : null}
          blurry={blurry}
          scanning={scanning}
          best={
            matches[0]
              ? {
                  name: matches[0].card.name,
                  typeLine: matches[0].card.typeLine,
                  scryfallId: matches[0].scryfallId,
                  score: matches[0].score,
                  method: methodLabel(matches[0].method),
                }
              : undefined
          }
          onAdd={() => { if (matches[0]) addToBasket(matches[0], ocrText); }}
          autoAdd={autoAdd}
          onToggleAuto={() => toggleAuto(!autoAdd)}
          torchAvailable={torchAvailable}
          torchOn={torchOn}
          onToggleTorch={() => void toggleTorch()}
          basketCount={basketTotal}
          toast={toastText}
          onUndoToast={undoToast}
          setPicker={setSelect('w-full rounded border border-border bg-bg px-2 py-1 text-xs text-text outline-none')}
          diagCrop={diag ? diagCrop : null}
          diagSnapped={diagSnapped}
        />
      )}
    </section>
  );
}
