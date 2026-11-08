#!/usr/bin/env python3
"""Kombo-Daten aus Commander Spellbook für ScryGlass (PLAN.md M17).

Commander Spellbook (https://commanderspellbook.com) veröffentlicht alle Kombos als
Datei zum lokalen Lesen und bittet um Nennung mit Link — die App nennt die Quelle unter
„Mehr" und bei jeder Kombo. Hier entsteht daraus eine schlanke `combos.ndjson`:

  Zeile 1:  {"meta": {...}, "cards": [oracleId, …], "results": [Ergebnis, …]}
  danach:   [id, [Kartenindex, …], sterne, manawert, [Ergebnisindex, …], farben, commanderMaske,
             beliebtheit, mana, nötigeKarten]

Karten und Ergebnisse stehen nur einmal im Kopf, die Zeilen verweisen per Index darauf
(rund 5 statt 25 MB). Aufgenommen werden Kombos ohne Platzhalter-Voraussetzungen
(„ein Land, das beim Eintreten Leben gibt") mit höchstens vier Karten.

Die Sterne (1–4) sind ScryGlass-eigen, nicht die Bracket-Einstufung von Spellbook:
  ★★★★  gewinnt allein, 2 Karten, höchstens 4 Mana
  ★★★   gewinnt allein, 2 Karten — oder 3 Karten mit höchstens 6 Mana
  ★★    gewinnt allein (mehr Karten/Mana) oder 2 Karten mit Teil-Ergebnis
  ★     braucht noch etwas dazu
„Gewinnt allein" = mindestens ein eigenständiges Ergebnis (Spellbook-Status `S`, z. B.
endlos Mana, endlos Schaden, Spiel gewonnen).

Aufruf:
  python fetch_combos.py --out dist
  python fetch_combos.py --out dist --sample tests/sample_variants.json
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from typing import Dict, Iterable, List, Optional

VARIANTS_URL = "https://json.commanderspellbook.com/variants.json.gz"
USER_AGENT = "ScryGlass/1.0 (unofficial MTG fan tool; +https://github.com/LordCookie/ScryGlass)"
REQUEST_TIMEOUT = 120
MAX_CARDS = 4
MAX_RESULTS = 3
PUBLIC_STATUSES = frozenset({"OK", "E"})


def needed_cards(variant: Dict) -> int:
    """Karten, die man wirklich ziehen/spielen muss — wer in der Bibliothek liegen bleibt
    (Zone `L`), zählt nicht (so zählt auch Spellbook)."""
    return sum(u.get("quantity", 1) for u in variant["uses"] if "L" not in u.get("zoneLocations", []))


def stars(variant: Dict) -> int:
    status = {p["feature"].get("status") for p in variant.get("produces", [])}
    n = needed_cards(variant)
    mv = variant.get("manaValueNeeded")
    mv = 99 if mv is None else mv  # unbekannt = nicht schnell
    wins = "S" in status
    if wins and n <= 2 and mv <= 4:
        return 4
    if wins and (n <= 2 or (n <= 3 and mv <= 6)):
        return 3
    if wins or ("C" in status and n <= 2):
        return 2
    return 1


def results_of(variant: Dict) -> List[str]:
    """Sichtbare Ergebnisse: eigenständige zuerst, dann kontextabhängige; Hilfsergebnisse nicht."""
    out: List[str] = []
    for want in ("S", "C"):
        for p in variant.get("produces", []):
            name = p["feature"].get("name")
            if p["feature"].get("status") == want and name and name not in out:
                out.append(name)
    return out[:MAX_RESULTS]


def keep_variant(variant: Dict) -> bool:
    uses = variant.get("uses", [])
    return (
        variant.get("status") in PUBLIC_STATUSES
        and not variant.get("requires")
        and 2 <= len(uses) <= MAX_CARDS
        and all(u.get("card", {}).get("oracleId") for u in uses)
    )


def build(variants: Iterable[Dict], meta: Dict) -> Dict:
    """Schlanke Kombo-Liste: {"head": Kopfzeile, "rows": [...]}. Beliebte zuerst."""
    kept = sorted(
        (v for v in variants if keep_variant(v)),
        key=lambda v: (-(v.get("popularity") or 0), v["id"]),
    )
    card_index: Dict[str, int] = {}
    result_index: Dict[str, int] = {}

    def idx(table: Dict[str, int], key: str) -> int:
        if key not in table:
            table[key] = len(table)
        return table[key]

    rows = []
    for v in kept:
        cards = [idx(card_index, u["card"]["oracleId"]) for u in v["uses"]]
        cmd_mask = sum(1 << i for i, u in enumerate(v["uses"]) if u.get("mustBeCommander"))
        mv = v.get("manaValueNeeded")
        rows.append([
            v["id"],
            cards,
            stars(v),
            -1 if mv is None else mv,
            [idx(result_index, r) for r in results_of(v)],
            v.get("identity") or "C",
            cmd_mask,
            v.get("popularity") or 0,
            (v.get("manaNeeded") or "")[:40],
            needed_cards(v),
        ])
    head = {
        "meta": {**meta, "count": len(rows)},
        "cards": list(card_index),
        "results": list(result_index),
    }
    return {"head": head, "rows": rows}


def write(combos: Dict, out_dir: str) -> int:
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "combos.ndjson"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(combos["head"], ensure_ascii=False, separators=(",", ":")) + "\n")
        for row in combos["rows"]:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    # Anzahl in version.json eintragen (für den Fortschritt in der App), falls vorhanden.
    vpath = os.path.join(out_dir, "version.json")
    if os.path.exists(vpath):
        with open(vpath, encoding="utf-8") as f:
            version = json.load(f)
        version.setdefault("counts", {})["combos"] = len(combos["rows"])
        version["combos"] = combos["head"]["meta"]
        with open(vpath, "w", encoding="utf-8", newline="\n") as f:
            json.dump(version, f, ensure_ascii=False, indent=2)
            f.write("\n")
    return len(combos["rows"])


def download() -> Dict:
    import requests  # lazy — Tests laufen offline

    r = requests.get(VARIANTS_URL, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    return json.loads(gzip.decompress(r.content))


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="ScryGlass: Kombos aus Commander Spellbook")
    ap.add_argument("--out", default="dist")
    ap.add_argument("--sample", help="Lokale variants.json(.gz) statt Download")
    args = ap.parse_args(argv)

    if args.sample:
        opener = gzip.open if args.sample.endswith(".gz") else open
        with opener(args.sample, "rt", encoding="utf-8") as f:
            data = json.load(f)
    else:
        print("[combos] Lade Commander-Spellbook-Daten …", file=sys.stderr)
        data = download()
    meta = {
        "source": "Commander Spellbook",
        "url": "https://commanderspellbook.com",
        "version": data.get("version", ""),
        "timestamp": data.get("timestamp", ""),
    }
    n = write(build(data.get("variants", []), meta), args.out)
    print(f"[combos] {n} Kombos → {args.out}/combos.ndjson", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
