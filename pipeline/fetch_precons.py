#!/usr/bin/env python3
"""Fertigdecks (Precons) aus MTGJSON für ScryGlass (PLAN.md M19).

MTGJSON (https://mtgjson.com, MIT-Lizenz) veröffentlicht alle Decklisten als
`AllDeckFiles` — je Karte mit genauer Druckausgabe (Scryfall-ID), Anzahl und Foil. Die
App nennt die Quelle unter „Mehr". Hier entsteht daraus eine schlanke `precons.ndjson`:

  Zeile 1:  {"meta": {...}, "printings": [scryfallId, …]}
  danach:   [key, name, set, datum, gruppe, typ, commander, main, side, extra, tokens, unbekannt]

Jede Kartenliste ist `[[Druckindex, Anzahl, Ausführung], …]` mit Ausführung
0 = normal, 1 = foil, 2 = etched. `extra` sind Karten, die beiliegen, aber nicht zum
Deck gehören (Display-Commander, Planes, Schemes). Druck-IDs stehen nur einmal im Kopf.

Aufgenommen werden nur Decks, die man als Produkt kaufen kann (TYPE_GROUPS) — keine
MTGO-/Arena-Decks, Länderpacks oder Beispieldecks. Kennt der Katalog eine Karte nicht
(z. B. Turnier-Gedenkkarten), fällt sie weg und wird gezählt; fehlt mehr als ein Fünftel,
fällt das ganze Deck weg.

Aufruf:
  python fetch_precons.py --out dist
  python fetch_precons.py --out dist --sample tests/sample_decks      (Ordner mit JSONs)
  python fetch_precons.py --out dist --sample AllDeckFiles.tar.xz
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tarfile
from typing import Dict, Iterable, Iterator, List, Optional, Set

DECKS_URL = "https://mtgjson.com/api/v5/AllDeckFiles.tar.xz"
USER_AGENT = "ScryGlass/1.0 (unofficial MTG fan tool; +https://github.com/LordCookie/ScryGlass)"
REQUEST_TIMEOUT = 300
MAX_UNKNOWN_SHARE = 0.2

# MTGJSON-Decktyp → Gruppe in der App (Filter). Was hier fehlt, kommt nicht mit.
TYPE_GROUPS: Dict[str, str] = {
    "Commander Deck": "commander",
    "Brawl Deck": "commander",
    "Theme Deck": "starter",
    "Intro Pack": "starter",
    "Planeswalker Deck": "starter",
    "Welcome Deck": "starter",
    "Welcome Booster": "starter",
    "Starter Deck": "starter",
    "Starter Kit": "starter",
    "Spellslinger Starter Kit": "starter",
    "Enhanced Deck": "starter",
    "Advanced Deck": "starter",
    "Advanced Pack": "starter",
    "Duel Deck": "duel",
    "Halfdeck": "duel",
    "Clash Pack": "duel",
    "Jumpstart": "jumpstart",
    "Secret Lair Drop": "secretlair",
    "Dandan Deck": "secretlair",
    "Challenger Deck": "other",
    "Pioneer Challenger Deck": "other",
    "Event Deck": "other",
    "Modern Event Deck": "other",
    "Game Night Deck": "other",
    "Guild Kit": "other",
    "Box Set": "other",
    "Deck Builder's Toolkit": "other",
    "Planechase Deck": "other",
    "Archenemy Deck": "other",
    "Premium Deck": "other",
    "Booster Battle Pack Packet": "other",
    "San Diego Comic Con Promos": "other",
    "Addon": "other",
    "Enemy Deck": "other",
}

FINISH_NONFOIL, FINISH_FOIL, FINISH_ETCHED = 0, 1, 2


def finish_of(card: Dict) -> int:
    if card.get("isEtched"):
        return FINISH_ETCHED
    return FINISH_FOIL if card.get("isFoil") else FINISH_NONFOIL


def scryfall_id(card: Dict) -> Optional[str]:
    return (card.get("identifiers") or {}).get("scryfallId")


class Builder:
    """Sammelt Decks und die gemeinsame Druck-Tabelle."""

    def __init__(self, known: Optional[Set[str]] = None) -> None:
        self.known = known  # None = kein Katalog zur Hand, alles übernehmen
        self.printing_index: Dict[str, int] = {}
        self.rows: List[list] = []
        self.dropped_unknown = 0  # Decks, denen zu viel fehlt
        self.skipped_type = 0
        self.file_meta: Dict = {}  # Stand aus den Deck-Dateien selbst (date, version)

    def _idx(self, sid: str) -> int:
        if sid not in self.printing_index:
            self.printing_index[sid] = len(self.printing_index)
        return self.printing_index[sid]

    def _board(self, cards: Optional[Iterable[Dict]], tally: List[int]) -> List[List[int]]:
        """Kartenliste → [[Druckindex, Anzahl, Ausführung]]; gleiche Einträge zusammengelegt."""
        merged: Dict[tuple, int] = {}
        for c in cards or []:
            n = int(c.get("count") or 1)
            sid = scryfall_id(c)
            tally[0] += n
            if not sid or (self.known is not None and sid not in self.known):
                tally[1] += n
                continue
            key = (sid, finish_of(c))
            merged[key] = merged.get(key, 0) + n
        return [[self._idx(sid), n, f] for (sid, f), n in merged.items()]

    def add(self, key: str, deck: Dict, file_meta: Optional[Dict] = None) -> bool:
        if file_meta and not self.file_meta:
            self.file_meta = {k: file_meta[k] for k in ("date", "version") if k in file_meta}
        group = TYPE_GROUPS.get(deck.get("type", ""))
        if not group:
            self.skipped_type += 1
            return False
        # Erst prüfen, dann übernehmen — sonst landen Drucke verworfener Decks im Kopf.
        tally = [0, 0]
        snapshot = dict(self.printing_index)
        boards = [
            self._board(deck.get("commander"), tally),
            self._board(deck.get("mainBoard"), tally),
            self._board(deck.get("sideBoard"), tally),
            self._board(
                list(deck.get("displayCommander") or []) + list(deck.get("planes") or []) + list(deck.get("schemes") or []),
                tally,
            ),
        ]
        deck_cards, unknown = tally
        tok_tally = [0, 0]
        tokens = self._board(deck.get("tokens"), tok_tally)
        if deck_cards == 0 or unknown > MAX_UNKNOWN_SHARE * deck_cards:
            self.printing_index = snapshot
            self.dropped_unknown += 1
            return False
        self.rows.append([
            key,
            deck.get("name", key),
            (deck.get("code") or "").lower(),
            deck.get("releaseDate") or "",
            group,
            deck.get("type", ""),
            *boards,
            tokens,
            unknown,
        ])
        return True

    def result(self, meta: Dict) -> Dict:
        # Neueste zuerst, dann nach Name — so zeigt die App ohne Sortieren das Richtige.
        rows = sorted(self.rows, key=lambda r: r[1].lower())
        rows.sort(key=lambda r: r[3], reverse=True)  # stabil: gleiches Datum bleibt nach Name
        head = {"meta": {**self.file_meta, **{k: v for k, v in meta.items() if v}, "count": len(rows)},
                "printings": list(self.printing_index)}
        return {"head": head, "rows": rows}


def deck_key(name: str) -> str:
    """Dateiname ohne Endung, z. B. „CavalryCharge_MOC" — stabil über Läufe hinweg."""
    base = os.path.basename(name)
    return base[:-5] if base.endswith(".json") else base


def iter_tar(fileobj=None, path: Optional[str] = None) -> Iterator[tuple]:
    """(key, deck, meta) aus AllDeckFiles.tar.xz, gestreamt (das Archiv ist ~150 MB)."""
    with tarfile.open(name=path, fileobj=fileobj, mode="r|xz") as tar:
        for m in tar:
            if not m.isfile() or not m.name.endswith(".json"):
                continue
            f = tar.extractfile(m)
            if f is None:
                continue
            doc = json.load(f)
            yield deck_key(m.name), doc["data"], doc.get("meta")


def iter_dir(path: str) -> Iterator[tuple]:
    for name in sorted(os.listdir(path)):
        if name.endswith(".json"):
            with open(os.path.join(path, name), encoding="utf-8") as f:
                doc = json.load(f)
            yield deck_key(name), doc["data"], doc.get("meta")


def load_known(path: str) -> Optional[Set[str]]:
    """Scryfall-IDs aus printings.ndjson des Katalogs (gleicher Lauf); fehlt die Datei, None."""
    if not os.path.exists(path):
        return None
    known: Set[str] = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                known.add(json.loads(line)["scryfallId"])
    return known


def build(decks: Iterable[tuple], meta: Dict, known: Optional[Set[str]] = None) -> Dict:
    b = Builder(known)
    for key, deck, *rest in decks:
        b.add(key, deck, rest[0] if rest else None)
    out = b.result(meta)
    out["stats"] = {"skippedType": b.skipped_type, "droppedUnknown": b.dropped_unknown}
    return out


def write(precons: Dict, out_dir: str) -> int:
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "precons.ndjson"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(precons["head"], ensure_ascii=False, separators=(",", ":")) + "\n")
        for row in precons["rows"]:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    vpath = os.path.join(out_dir, "version.json")
    if os.path.exists(vpath):
        with open(vpath, encoding="utf-8") as f:
            version = json.load(f)
        version.setdefault("counts", {})["precons"] = len(precons["rows"])
        version["precons"] = precons["head"]["meta"]
        with open(vpath, "w", encoding="utf-8", newline="\n") as f:
            json.dump(version, f, ensure_ascii=False, indent=2)
            f.write("\n")
    return len(precons["rows"])


def mtgjson_meta(fallback_date: str = "") -> Dict:
    import requests  # lazy — Tests laufen offline

    try:
        r = requests.get("https://mtgjson.com/api/v5/Meta.json", headers={"User-Agent": USER_AGENT}, timeout=60)
        r.raise_for_status()
        return r.json().get("data", {})
    except Exception:  # noqa: BLE001 — nur Anzeige
        return {"date": fallback_date}


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="ScryGlass: Fertigdecks aus MTGJSON")
    ap.add_argument("--out", default="dist")
    ap.add_argument("--sample", help="Lokaler Ordner mit Deck-JSONs oder AllDeckFiles.tar.xz statt Download")
    ap.add_argument("--catalog", help="printings.ndjson zum Abgleich (Standard: <out>/printings.ndjson)")
    args = ap.parse_args(argv)

    known = load_known(args.catalog or os.path.join(args.out, "printings.ndjson"))
    if known is None:
        print("[precons] Kein Katalog zum Abgleich — alle Karten werden übernommen.", file=sys.stderr)

    meta = {"source": "MTGJSON", "url": "https://mtgjson.com"}
    if args.sample and os.path.isdir(args.sample):
        precons = build(iter_dir(args.sample), meta, known)
    elif args.sample:
        precons = build(iter_tar(path=args.sample), meta, known)
    else:
        import requests

        print("[precons] Lade MTGJSON AllDeckFiles …", file=sys.stderr)
        m = mtgjson_meta()
        meta.update({"version": m.get("version", ""), "date": m.get("date", "")})
        with requests.get(DECKS_URL, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT, stream=True) as r:
            r.raise_for_status()
            r.raw.decode_content = True
            precons = build(iter_tar(fileobj=r.raw), meta, known)
    n = write(precons, args.out)
    s = precons["stats"]
    print(
        f"[precons] {n} Fertigdecks → {args.out}/precons.ndjson "
        f"({len(precons['head']['printings'])} Drucke; {s['skippedType']} andere Typen, "
        f"{s['droppedUnknown']} mit zu vielen unbekannten Karten)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
