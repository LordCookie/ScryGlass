#!/usr/bin/env python3
"""Perceptual-Hash-Pipeline für den Scanner (Bild-Matching statt/ergänzend zu OCR).

Idee: OCR scheitert an Showcase-/Borderless-/Full-Art-Rahmen und an abfotografierten
Bildschirmen. Ein **dHash** über das Kartenbild identifiziert die Karte am ARTWORK,
nicht am Text — robust gegen stilisierte Schrift und (in Grenzen) Licht.

Für JEDE Druckausgabe (auch Alt-Art/Showcase — genau die sind der Gewinn) wird das
Scryfall-Bild geladen und als 256-Bit-**pHash** (DCT über die tiefen Frequenzen)
gespeichert. Die App hasht den Kamera-Ausschnitt gleich und sucht den nächsten
(Hamming-Distanz). pHash ist deutlich robuster gegen Render-/Kamera-Unterschiede
als dHash (tiefe Frequenzen = grobe Struktur statt Nachbarpixel).

Ausgabe: `hashes.ndjson` — eine Zeile je Printing: {"id","o","h"} (h = 64 Hex-Zeichen).

  python hash_images.py --printings dist/printings.ndjson --out dist/hashes.ndjson
  python hash_images.py --printings dist/printings.ndjson --out dist/hashes.ndjson --limit 50 --workers 8

Abbruchsicher/fortsetzbar: bereits gehashte scryfallIds in der Ausgabe werden
übersprungen. Nur Python-stdlib + Pillow + requests.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import json
import os
import sys
import threading
import time
from typing import Iterator, List, Optional, Tuple

# pHash (DCT): robuster gegen Render-/Kamera-Unterschiede als dHash, weil er die
# TIEFEN Frequenzen (grobe Bildstruktur) nutzt statt Nachbarpixel-Differenzen.
P_IMG = 32       # Graustufe auf P_IMG×P_IMG skalieren
P_HASH = 16      # obere P_HASH×P_HASH DCT-Koeffizienten → 256 Bit
IMG_SIZE = "small"
USER_AGENT = "ScryGlass/1.0 (unofficial MTG fan tool; +https://github.com/LordCookie/ScryGlass)"


def image_url(scryfall_id: str, size: str = IMG_SIZE) -> str:
    a, b = scryfall_id[0], scryfall_id[1]
    return f"https://cards.scryfall.io/{size}/front/{a}/{b}/{scryfall_id}.jpg"


# --- pHash (MUSS Bit für Bit zur TS-Seite passen: app/src/data/imageHash.ts) ----

def bits_to_hex(bits: List[int]) -> str:
    """Bits (MSB zuerst je Byte) → Hex-String."""
    out = bytearray()
    for k in range(0, len(bits), 8):
        byte = 0
        for j in range(8):
            byte = (byte << 1) | bits[k + j]
        out.append(byte)
    return out.hex()


_DCT_CACHE: dict = {}


def _dct_matrix(n: int):
    """Orthonormale DCT-II-Basismatrix C (n×n). MUSS zur TS-Seite passen:
    C[k][x] = alpha(k) · cos(pi·(2x+1)·k / (2n)), alpha(0)=sqrt(1/n), sonst sqrt(2/n)."""
    import numpy as np

    if n not in _DCT_CACHE:
        k = np.arange(n).reshape(-1, 1)
        x = np.arange(n).reshape(1, -1)
        c = np.cos(np.pi * (2 * x + 1) * k / (2 * n)) * np.sqrt(2.0 / n)
        c[0, :] *= np.sqrt(0.5)  # alpha(0) = sqrt(1/n)
        _DCT_CACHE[n] = c
    return _DCT_CACHE[n]


def phash_hex(image_bytes: bytes, img_size: int = P_IMG, hash_size: int = P_HASH) -> str:
    """pHash: Graustufe → img_size² → 2D-DCT → obere hash_size²-Koeffizienten →
    bit = Koeffizient > Median (row-major, MSB zuerst)."""
    import numpy as np
    from PIL import Image  # lazy

    with Image.open(io.BytesIO(image_bytes)) as im:
        im = im.convert("L").resize((img_size, img_size), Image.LANCZOS)
        x = np.asarray(im, dtype=np.float64)
    c = _dct_matrix(img_size)
    d = c @ x @ c.T
    low = d[:hash_size, :hash_size]
    med = float(np.median(low))
    bits = [1 if v > med else 0 for v in low.flatten().tolist()]
    return bits_to_hex(bits)


# --- IO ---------------------------------------------------------------------

def iter_printings(path: str) -> Iterator[Tuple[str, str]]:
    """(scryfallId, oracleId) aus printings.ndjson."""
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            p = json.loads(line)
            sid = p.get("scryfallId")
            oid = p.get("oracleId")
            if sid and oid:
                yield sid, oid


def load_done(out_path: str) -> set:
    done = set()
    if os.path.exists(out_path):
        with open(out_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    done.add(json.loads(line)["id"])
                except Exception:
                    pass
    return done


def download(url: str, timeout: float = 20.0) -> Optional[bytes]:
    import requests

    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
        if r.status_code == 200 and r.content:
            return r.content
    except Exception:
        return None
    return None


def run(printings: str, out_path: str, workers: int, limit: Optional[int], delay: float) -> int:
    todo: List[Tuple[str, str]] = []
    done = load_done(out_path)
    for sid, oid in iter_printings(printings):
        if sid in done:
            continue
        todo.append((sid, oid))
        if limit and len(todo) >= limit:
            break

    print(f"[hash] {len(done)} bereits vorhanden, {len(todo)} zu hashen", file=sys.stderr)
    lock = threading.Lock()
    count = [0]
    fail = [0]

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    out = open(out_path, "a", encoding="utf-8", newline="\n")

    def work(item: Tuple[str, str]) -> None:
        sid, oid = item
        if delay:
            time.sleep(delay)
        data = download(image_url(sid))
        if not data:
            with lock:
                fail[0] += 1
            return
        try:
            h = phash_hex(data)
        except Exception:
            with lock:
                fail[0] += 1
            return
        line = json.dumps({"id": sid, "o": oid, "h": h}, separators=(",", ":"))
        with lock:
            out.write(line + "\n")
            count[0] += 1
            if count[0] % 500 == 0:
                out.flush()
                print(f"[hash] {count[0]} gehasht ({fail[0]} Fehler)", file=sys.stderr)

    try:
        with cf.ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(work, todo))
    finally:
        out.flush()
        out.close()

    print(f"[hash] Fertig: {count[0]} neu gehasht, {fail[0]} Fehler → {out_path}", file=sys.stderr)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="ScryGlass Bild-Hash-Pipeline (dHash)")
    ap.add_argument("--printings", default="dist/printings.ndjson", help="printings.ndjson (aus fetch_scryfall)")
    ap.add_argument("--out", default="dist/hashes.ndjson")
    ap.add_argument("--workers", type=int, default=8, help="parallele Downloads (moderat halten)")
    ap.add_argument("--limit", type=int, default=None, help="nur die ersten N (für Tests)")
    ap.add_argument("--delay", type=float, default=0.0, help="Sekunden Pause je Request (Höflichkeit)")
    args = ap.parse_args(argv)
    return run(args.printings, args.out, args.workers, args.limit, args.delay)


if __name__ == "__main__":
    raise SystemExit(main())
