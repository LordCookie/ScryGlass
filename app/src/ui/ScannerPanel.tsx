import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Scheduler } from 'tesseract.js';
import jsQR from 'jsqr';
import { matchOcr } from '../data/matcher';
import { getCards, previewImageIds } from '../data/cards';
import { searchCards } from '../data/search';
import { dhashFromCanvas, nearestByHash, hashCount, type HashMatch } from '../data/imageHash';
import { addOwnedBatch, getMeta, setMeta } from '../db/db';
import type { Card, Finish, Lang, BasketEntry } from '../domain/types';
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

// Bild-Matching (Scanner v2): Schwellen für einen dHash-Treffer (0..256).
// Datenbasis: gleiches Bild (Referenz↔Kamera-Engine) ≈ 35 Bit; VERSCHIEDENE Karten
// min ≈ 64, p5 ≈ 86. Darum:
const HASH_MAX_DIST = 60; // als Kandidat zeigen (knapp unter dem False-Minimum)
const HASH_MIN_MARGIN = 10; // muss klar besser als der zweitbeste sein
const HASH_STRONG_DIST = 46; // erst darunter automatisch übernehmen

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

  const [scanning, setScanning] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [matches, setMatches] = useState<ScanMatch[]>([]);
  const [finish, setFinish] = useState<Finish>('nonfoil');
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [added, setAdded] = useState(0);
  const [autoToast, setAutoToast] = useState<string | null>(null);
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

  const lastAutoRef = useRef<string | null>(null);
  const lastThumbRef = useRef<Uint8Array | null>(null);
  const thumbCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const autoToastTimer = useRef<number>();

  // OCR-Worker-Pool laden (dynamischer Import → eigener Chunk, schneller App-Start).
  useEffect(() => {
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
            // Schreibweisen), Ziffern (Sammlernummer), Leerzeichen, ' , -.
            tessedit_pageseg_mode: PSM.SINGLE_LINE,
            tessedit_char_whitelist:
              "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ,'-",
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
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

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
    binarize: 'otsu' | 'adaptive' = 'adaptive',
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
    else binarizeOtsu(d, n);
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** Roher (unbearbeiteter) Karten-Ausschnitt fürs Bild-Hashing (Scanner v2). */
  function rawCropCanvas(): HTMLCanvasElement | null {
    const video = videoRef.current;
    const region = cropRegion();
    if (!video || !region) return null;
    const cw = 146;
    const ch = 204;
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, cw, ch);
    return c;
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
    // Titelbalken (oben ~12 %, § 6) + Ganzkarte als Sicherheitsnetz (auch live —
    // hilft bei Showcase-/Borderless-Rahmen, wo der Titel-Crop danebenliegt).
    const bandTop = regionCanvas([0.04, 0.045, 0.92, 0.13], 900, 'adaptive');
    const whole = regionCanvas([0, 0, 1, 1], 820, 'otsu');
    // Bild-Hash (Scanner v2) synchron vom aktuellen Frame — matcht das ARTWORK,
    // nicht den Text (rettet Showcase-/Borderless-/Full-Art-Rahmen).
    let hashMatch: HashMatch | null = null;
    if (hashCount() > 0) {
      const raw = rawCropCanvas();
      if (raw) {
        const qh = dhashFromCanvas(raw);
        if (qh) hashMatch = nearestByHash(qh);
      }
    }
    if (!bandTop) return;
    busyRef.current = true;
    setScanning(true);
    try {
      const rec = (c: HTMLCanvasElement | null) =>
        c ? scheduler.addJob('recognize', c).then((r) => r.data.text ?? '') : Promise.resolve('');
      const [topText, wholeText] = await Promise.all([rec(bandTop), rec(whole)]);
      const text = `${topText} ${wholeText}`.replace(/\s+/g, ' ').trim();
      setOcrText(text);
      const result = await matchOcr(text, { topN: 5, threshold: 0.55 });
      const shown = await enrich(result.candidates);

      // Bild-Treffer (falls eindeutig genug) an die Spitze — er ist bei
      // schwierigen Rahmen zuverlässiger als OCR.
      let finalMatches = shown;
      const hashHit =
        hashMatch && hashMatch.distance <= HASH_MAX_DIST && hashMatch.margin >= HASH_MIN_MARGIN
          ? hashMatch
          : null;
      if (hashHit) {
        const card = (await getCards([hashHit.oracleId])).get(hashHit.oracleId);
        if (card) {
          const imgs = await previewImageIds([hashHit.oracleId]);
          const hm: ScanMatch = {
            oracleId: hashHit.oracleId,
            card,
            scryfallId: hashHit.scryfallId ?? imgs.get(hashHit.oracleId),
            // Distanz → grobe Confidence (0 Bit ≈ 1.0, 60 Bit ≈ 0.5).
            score: Math.max(0.5, 1 - hashHit.distance / 128),
            method: 'bild',
            lang: 'en',
          };
          finalMatches = [hm, ...shown.filter((m) => m.oracleId !== hm.oracleId)];
        }
      }
      setMatches(finalMatches);

      const best = finalMatches[0];
      // Auto-Übernahme: sehr sicherer Bildtreffer ODER sehr sicherer OCR-Treffer.
      const strongHash = !!hashHit && hashHit.distance <= HASH_STRONG_DIST && best?.method === 'bild';
      const confident =
        !!best && (strongHash || (best.method !== 'bild' && best.score >= 0.85 && !result.ambiguous));
      if (autoAdd && best && confident) {
        if (lastAutoRef.current !== best.oracleId) {
          lastAutoRef.current = best.oracleId;
          addToBasket(best, text);
          setAutoToast(best.card.name);
          window.clearTimeout(autoToastTimer.current);
          autoToastTimer.current = window.setTimeout(() => setAutoToast(null), 1500);
        }
      } else if (!best) {
        lastAutoRef.current = null;
      }
    } catch {
      /* einzelne Erkennung fehlgeschlagen — nächster Versuch */
    } finally {
      busyRef.current = false;
      setScanning(false);
    }
  }

  // QR-Pairing: scannt den Bildschirm-QR des Empfängers (§ 8).
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
    if (!code) return;
    const info = parsePairingUrl(code.data);
    if (!info) return;
    busyRef.current = true;
    try {
      const { conn, hello } = await pair(info);
      setTarget({ kind: 'peer', ...conn });
      setPairing(false);
      setPairMsg(`Verbunden mit „${hello.deviceName}".`);
    } catch (e) {
      setPairMsg(e instanceof PeerError ? e.message : 'Pairing fehlgeschlagen.');
    } finally {
      busyRef.current = false;
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

  async function startCamera() {
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
    lastAutoRef.current = null;
    setAutoToast(null);
  }

  function applyZoom(value: number) {
    setZoom(value);
    const track = streamRef.current?.getVideoTracks()[0];
    void track?.applyConstraints({ advanced: [{ zoom: value }] } as unknown as MediaTrackConstraints);
  }

  async function toggleTorch() {
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

  function addToBasket(m: ScanMatch, ocrRaw: string) {
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
    if (typeof navigator.vibrate === 'function') navigator.vibrate(20);
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
                if (!camOn) void startCamera();
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
        {target.kind === 'peer' && (
          <p className="mb-2 rounded bg-accent/10 px-2 py-1 font-mono text-xs text-accent">
            Ziel: Korb geht an „{target.deviceName}" — deine eigene Sammlung bleibt unberührt.
          </p>
        )}
        {pairMsg && <p className="mb-2 font-mono text-xs text-muted">{pairMsg}</p>}

        <div className="relative overflow-hidden rounded-md bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            onLoadedMetadata={(e) => setVdim({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
            className="block h-auto w-full"
          />
          {camOn && !pairing && (
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border-2 border-fill/80"
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
          {!camOn && <div className="flex h-40 items-center justify-center text-sm text-muted">Kamera aus</div>}
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
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
              <span>Live-Erkennung (Dauer-/Bulk-Scan)</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={autoAdd} onChange={(e) => setAutoAdd(e.target.checked)} />
              <span>Sicheren Treffer automatisch in den Korb</span>
            </label>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {!camOn ? (
            <button onClick={() => void startCamera()}
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
                  {torchOn ? '🔦 an' : '🔦 aus'}
                </button>
              )}
              <button onClick={stopCamera}
                className="rounded border border-border px-3 py-1.5 font-mono text-sm text-muted hover:border-danger hover:text-danger">
                Kamera stoppen
              </button>
            </>
          )}
          {!workerReady && <span className="self-center font-mono text-xs text-muted">Texterkennung lädt…</span>}
        </div>

        {autoToast && (
          <p className="mt-2 rounded-md bg-ok/15 px-2 py-1 font-mono text-sm text-ok">✓ {autoToast} in den Korb</p>
        )}
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
                    <span className="min-w-0 flex-1 truncate">{card.name}</span>
                    <span className="text-xs text-accent">＋ Korb</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>

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
                    <ColorPips colors={m.card.colorIdentity} />
                    <span className="min-w-0 flex-1 truncate text-muted">{m.card.typeLine}</span>
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
                <button onClick={() => setBasket([])} className="rounded border border-border px-3 py-1.5 font-mono text-sm text-muted hover:border-danger hover:text-danger">
                  Korb leeren
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
