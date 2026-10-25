#!/usr/bin/env python3
"""ScryGlass-Datenpipeline (PLAN.md § 2, E1/E2, M1).

Zieht den Scryfall-Bulk `all_cards`, filtert und normalisiert ihn und schreibt einen
Slim-Katalog aus vier NDJSON-Files (~20 MB) plus `version.json`. Die App lädt nur den.

Kernentscheidungen:
  * E1 — Normalisierung (`normName`, Trigramme, `maxCopies`, Legalitäts-Bitmaske)
    passiert HIER, nicht auf dem Handy.
  * E2 — Ausgabe als NDJSON (eine Zeile = ein Record), damit die App zeilenweise
    streamen kann.

Nur Python-stdlib + `requests` (Letzteres nur für den echten Download; Tests laufen
über `--sample <datei>` komplett offline).

Aufruf:
  python fetch_scryfall.py --out dist
  python fetch_scryfall.py --out dist --sample tests/sample_bulk.jsonl
"""
from __future__ import annotations

import argparse
import datetime as _dt
import gzip
import io
import json
import os
import sys
import unicodedata
from typing import Dict, Iterable, Iterator, List, Optional, Tuple

BULK_INDEX_URL = "https://api.scryfall.com/bulk-data"
USER_AGENT = "ScryGlass/1.0 (unofficial MTG fan tool; +https://github.com/LordCookie/ScryGlass)"
# Scryfall-ToS (§ 12): freundlich bleiben, User-Agent setzen.
REQUEST_TIMEOUT = 60

# --- Konstanten für abgeleitete Felder --------------------------------------

# Reihenfolge = Bit-Position in der Legalitäts-Bitmaske (PLAN.md § 3).
FORMATS: Tuple[str, ...] = (
    "standard",   # 1<<0
    "pioneer",    # 1<<1
    "modern",     # 1<<2
    "legacy",     # 1<<3
    "vintage",    # 1<<4
    "commander",  # 1<<5
    "pauper",     # 1<<6
    "brawl",      # 1<<7
)

# Karten, die es beliebig oft geben darf, tragen diesen Satz im Oracle-Text.
ANY_NUMBER_MARKER = "a deck can have any number of cards named"

# Layouts, die keine „echten" Karten sind (PLAN.md § 2, Schritt 3).
DROP_LAYOUTS = frozenset({"art_series"})
# Spielsteine und Embleme kommen mit in den Katalog (Großes Token-Update, M14): die App
# erkennt sie am Layout, sammelt sie je Artwork und hält sie aus Deckbau und Suche raus.
# In den Namensindex kommen sie NICHT — sonst fände der Karten-Abgleich „Soldier" oder
# „Treasure" statt der echten Karte, und Token-Namen sind ohnehin nicht eindeutig.
TOKEN_LAYOUTS = frozenset({"token", "double_faced_token", "emblem"})
KEEP_LANGS = frozenset({"en", "de"})

# Sehr häufige Trigramme tragen kaum Signal; ihre Postings-Liste wird gekappt, damit
# der Fuzzy-Fallback-Index klein und schnell bleibt (PLAN.md § 5, Fuzzy-Fallback).
MAX_TRIGRAM_POSTINGS = 4000

# Ligaturen/Sonderzeichen, die NFKD nicht zerlegt (PLAN.md § 2, `normName`).
_LIGATURES = {
    "æ": "ae", "œ": "oe", "ø": "o", "ð": "d", "þ": "th", "ß": "ss", "đ": "d", "ł": "l",
}


def normalize_name(s: str) -> str:
    """Vergleichsform eines Kartennamens (PLAN.md § 2).

    lowercase → Diakritika strippen (ö→o, æ→ae) → Apostroph/Komma/Bindestrich/Punkt
    raus → übrige Nicht-Alphanumerik zu Leerzeichen → Whitespace kollabieren.

    MUSS Zeichen für Zeichen zur TS-Seite (`app/src/domain/nameMatch.ts`) passen —
    beide Seiten müssen identisch normalisieren, sonst greift der Exakt-Treffer nicht.
    """
    s = s.lower()
    out: List[str] = []
    for ch in s:
        if ch in _LIGATURES:
            out.append(_LIGATURES[ch])
        else:
            out.append(ch)
    s = "".join(out)
    # Diakritika entfernen (é→e, ö→o …).
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    # Apostrophe (auch typografische), Komma, Bindestrich, Punkt ersatzlos raus.
    for ch in ("'", "’", "‘", "`", ",", "-", "."):
        s = s.replace(ch, "")
    # Alles übrige, das nicht a-z0-9 ist, wird Trenner.
    s = "".join(c if c.isalnum() else " " for c in s)
    return " ".join(s.split())


def trigrams(norm: str) -> List[str]:
    """3er-Fenster über den normalisierten Namen (PLAN.md § 5)."""
    if len(norm) < 3:
        return [norm] if norm else []
    return [norm[i : i + 3] for i in range(len(norm) - 2)]


def legality_mask(legalities: Dict[str, str]) -> int:
    """Legalitäten in ein Byte packen (PLAN.md § 3).

    `legal` und `restricted` (Vintage-Restricted ist spielbar, nur auf 1 begrenzt)
    setzen das Bit; `banned`/`not_legal` nicht.
    """
    mask = 0
    for bit, fmt in enumerate(FORMATS):
        status = legalities.get(fmt)
        if status in ("legal", "restricted"):
            mask |= 1 << bit
    return mask


def is_basic_land(type_line: str) -> bool:
    return "basic" in type_line.lower() and "land" in type_line.lower()


def max_copies(type_line: str, oracle_text: str) -> int:
    """Erlaubte Anzahl pro Deck (PLAN.md § 2): 4, außer Basic Land oder
    „A deck can have any number of cards named …" → 99."""
    if is_basic_land(type_line):
        return 99
    if ANY_NUMBER_MARKER in (oracle_text or "").lower():
        return 99
    return 4


def _join_faces(card: Dict, key: str, sep: str) -> str:
    """Feld aus `card_faces` zusammensetzen, wenn das Top-Level-Feld fehlt
    (doppelseitige/Split-/Adventure-Karten, PLAN.md § 6 Layout-Sonderfälle)."""
    top = card.get(key)
    if top:
        return top
    faces = card.get("card_faces") or []
    parts = [f.get(key, "") for f in faces if f.get(key)]
    return sep.join(parts)


def _colors(card: Dict) -> List[str]:
    top = card.get("colors")
    if top is not None:
        return list(top)
    seen: List[str] = []
    for face in card.get("card_faces") or []:
        for c in face.get("colors", []) or []:
            if c not in seen:
                seen.append(c)
    return seen


def oracle_id_of(card: Dict) -> Optional[str]:
    """Oracle-ID der Karte — bei reversible_card steckt sie in der ersten Face.

    Doppelseitige Tokens tragen je Seite eine eigene Oracle-ID; die Kombination ist
    eine eigene „Karte" (sonst landete ein einseitiger Treasure-Token unter dem Namen
    „Treasure // Clue"), also beide IDs verbinden.
    """
    oid = card.get("oracle_id")
    if oid:
        return oid
    ids = [f["oracle_id"] for f in card.get("card_faces") or [] if f.get("oracle_id")]
    if card.get("layout") == "double_faced_token" and len(ids) > 1:
        return "+".join(ids)
    return ids[0] if ids else None


def is_token(card: Dict) -> bool:
    return card.get("layout") in TOKEN_LAYOUTS


def keep_card(card: Dict) -> bool:
    """Filter aus PLAN.md § 2, Schritt 3."""
    if card.get("lang") not in KEEP_LANGS:
        return False
    if card.get("set_type") == "memorabilia":
        return False
    if card.get("layout") in DROP_LAYOUTS:
        return False
    # Nur „paper"-Karten (kein reines Arena/MTGO), damit der Scanner nur Reales sieht.
    games = card.get("games") or []
    if games and "paper" not in games:
        return False
    return True


# --- Kern: Bulk verarbeiten -------------------------------------------------

class Catalog:
    """Sammelt die vier Output-Datensätze beim Streamen durch den Bulk."""

    def __init__(self) -> None:
        # oracle_id -> Oracle-Karten-Record (englische Ausgabe bevorzugt).
        self.cards: Dict[str, Dict] = {}
        # oracle_id -> ob die aktuell gespeicherte Karte englisch ist.
        self._card_is_en: Dict[str, bool] = {}
        self.printings: List[Dict] = []
        # (normName, lang) -> oracle_id  (Namensindex, dedupliziert)
        self._names: Dict[Tuple[str, str], str] = {}
        # trigram -> geordnete Menge oracle_ids
        self._trigrams: Dict[str, List[str]] = {}
        self._trigram_seen: Dict[str, set] = {}

    def add(self, card: Dict) -> None:
        oid = oracle_id_of(card)
        if not oid:
            return
        lang = card["lang"]
        is_en = lang == "en"

        # --- Printing (eine Zeile pro Scryfall-Karte) ---
        self.printings.append(
            {
                "scryfallId": card["id"],
                "oracleId": oid,
                "set": card.get("set", ""),
                # Sammlernummer ist ein String ("123a"), niemals Zahl (PLAN.md § 3).
                "collectorNumber": str(card.get("collector_number", "")),
                "lang": lang,
                "finishes": list(card.get("finishes", []) or []),
            }
        )

        # --- Oracle-Karte (englische Ausgabe ist kanonisch) ---
        if oid not in self.cards or (is_en and not self._card_is_en.get(oid)):
            type_line = card.get("type_line") or _join_faces(card, "type_line", " // ")
            oracle_text = _join_faces(card, "oracle_text", "\n//\n")
            name = card.get("name", "")
            self.cards[oid] = {
                "oracleId": oid,
                "name": name,
                "normName": normalize_name(name),
                "manaCost": card.get("mana_cost") or _join_faces(card, "mana_cost", " // "),
                "cmc": card.get("cmc", 0) or 0,
                "colors": _colors(card),
                "colorIdentity": list(card.get("color_identity", []) or []),
                "typeLine": type_line,
                "oracleText": oracle_text,
                "layout": card.get("layout", "normal"),
                "legalities": legality_mask(card.get("legalities", {}) or {}),
                "maxCopies": max_copies(type_line, oracle_text),
            }
            self._card_is_en[oid] = is_en

        # --- Namensindex (ohne Tokens, siehe TOKEN_LAYOUTS) ---
        if is_token(card):
            return
        # Englischer Oracle-Name (aus der en-Ausgabe) …
        if is_en:
            self._add_name(card.get("name", ""), oid, "en")
        # … und der gedruckte deutsche Name (falls vorhanden).
        printed = card.get("printed_name")
        if lang == "de" and printed:
            self._add_name(printed, oid, "de")

    def _add_name(self, raw: str, oid: str, lang: str) -> None:
        norm = normalize_name(raw)
        if not norm:
            return
        self._names.setdefault((norm, lang), oid)
        for tri in trigrams(norm):
            seen = self._trigram_seen.setdefault(tri, set())
            if oid in seen:
                continue
            postings = self._trigrams.setdefault(tri, [])
            if len(postings) >= MAX_TRIGRAM_POSTINGS:
                continue
            seen.add(oid)
            postings.append(oid)

    # --- Serialisierung ---

    def name_rows(self) -> Iterator[Dict]:
        for (norm, lang), oid in sorted(self._names.items()):
            yield {"normName": norm, "oracleId": oid, "lang": lang}

    def trigram_rows(self) -> Iterator[Dict]:
        for tri in sorted(self._trigrams):
            yield {"trigram": tri, "oracleIds": sorted(self._trigrams[tri])}

    def card_rows(self) -> Iterator[Dict]:
        for oid in sorted(self.cards):
            yield self.cards[oid]

    def printing_rows(self) -> Iterator[Dict]:
        return iter(sorted(self.printings, key=lambda p: p["scryfallId"]))


def build_catalog(records: Iterable[Dict]) -> Catalog:
    """Verarbeitet einen Strom von Scryfall-Karten zu einem `Catalog`."""
    cat = Catalog()
    for card in records:
        if keep_card(card):
            cat.add(card)
    return cat


# --- IO: Streaming-Reader ---------------------------------------------------

def iter_jsonl(fp: io.TextIOBase) -> Iterator[Dict]:
    """JSONL zeilenweise (eine Karte pro Zeile). Scryfalls JSONL hat KEINE
    umschließenden `[` `]`; leere Zeilen werden übersprungen."""
    for line in fp:
        line = line.strip().rstrip(",")
        if not line or line in ("[", "]"):
            continue
        yield json.loads(line)


def open_maybe_gzip(path: str) -> io.TextIOBase:
    """Öffnet eine .jsonl- oder .jsonl.gz-Datei als UTF-8-Textstrom (gestreamt)."""
    if path.endswith(".gz"):
        return io.TextIOWrapper(gzip.open(path, "rb"), encoding="utf-8")
    return open(path, "r", encoding="utf-8")


def download_bulk(dest_path: str) -> Tuple[str, str]:
    """Lädt den `all_cards`-Bulk als `.jsonl.gz` nach `dest_path`.

    Rückgabe: (gespeicherter Pfad, Scryfall-Bulk-Datum ISO). Import von `requests`
    passiert erst hier, damit die Tests ohne die Abhängigkeit laufen.
    """
    import requests  # lazy — nur für den echten Download nötig

    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    idx = requests.get(BULK_INDEX_URL, headers=headers, timeout=REQUEST_TIMEOUT)
    idx.raise_for_status()
    entries = idx.json().get("data", [])
    entry = next((e for e in entries if e.get("type") == "all_cards"), None)
    if entry is None:
        raise RuntimeError("Kein 'all_cards'-Eintrag in der Bulk-Index-Antwort.")

    # Seit 2026-07-20 gibt es nur noch JSONL (.jsonl.gz), PLAN.md § 2.
    uri = entry.get("jsonl_download_uri") or entry.get("download_uri")
    if not uri:
        raise RuntimeError("Bulk-Eintrag hat keine jsonl_download_uri.")
    bulk_date = (entry.get("updated_at") or "")[:10]

    with requests.get(uri, headers={"User-Agent": USER_AGENT}, stream=True,
                      timeout=REQUEST_TIMEOUT) as r:
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if chunk:
                    f.write(chunk)
    return dest_path, bulk_date


# --- IO: Writer -------------------------------------------------------------

def write_ndjson(path: str, rows: Iterable[Dict]) -> int:
    """Schreibt Records als NDJSON (eine kompakte JSON-Zeile je Record). Anzahl zurück."""
    n = 0
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")
            n += 1
    return n


def write_catalog(cat: Catalog, out_dir: str, bulk_date: str = "") -> Dict:
    """Schreibt die vier NDJSON-Files + version.json. Gibt `version.json` zurück."""
    os.makedirs(out_dir, exist_ok=True)
    counts = {
        "cards": write_ndjson(os.path.join(out_dir, "cards.ndjson"), cat.card_rows()),
        "printings": write_ndjson(os.path.join(out_dir, "printings.ndjson"), cat.printing_rows()),
        "names": write_ndjson(os.path.join(out_dir, "names.ndjson"), cat.name_rows()),
        "trigrams": write_ndjson(os.path.join(out_dir, "trigrams.ndjson"), cat.trigram_rows()),
    }
    now = _dt.datetime.now(_dt.timezone.utc)
    version = {
        # catalogVersion identifiziert den Katalog eindeutig; die App vergleicht ihn
        # gegen ihren lokalen Stand (PLAN.md § 4).
        "catalogVersion": now.strftime("%Y%m%d%H%M%S"),
        "builtAt": now.replace(microsecond=0).isoformat(),
        "scryfallBulkDate": bulk_date,
        "counts": counts,
    }
    with open(os.path.join(out_dir, "version.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(version, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return version


# --- CLI --------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="ScryGlass Scryfall-Katalog-Pipeline")
    ap.add_argument("--out", default="dist", help="Ausgabeverzeichnis (Default: dist)")
    ap.add_argument(
        "--sample",
        help="Lokale .jsonl/.jsonl.gz statt Download verarbeiten (für Tests/Dev)",
    )
    ap.add_argument(
        "--keep-download",
        help="Pfad, unter dem der heruntergeladene Bulk aufgehoben wird (Default: temporär)",
    )
    args = ap.parse_args(argv)

    if args.sample:
        print(f"[pipeline] Verarbeite lokale Datei: {args.sample}", file=sys.stderr)
        with open_maybe_gzip(args.sample) as fp:
            cat = build_catalog(iter_jsonl(fp))
        bulk_date = ""
    else:
        dest = args.keep_download or os.path.join(args.out, "_all_cards.jsonl.gz")
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        print("[pipeline] Lade Scryfall-Bulk-Index …", file=sys.stderr)
        path, bulk_date = download_bulk(dest)
        print(f"[pipeline] Verarbeite {path} (Bulk-Datum {bulk_date}) …", file=sys.stderr)
        with open_maybe_gzip(path) as fp:
            cat = build_catalog(iter_jsonl(fp))
        if not args.keep_download:
            try:
                os.remove(path)
            except OSError:
                pass

    version = write_catalog(cat, args.out, bulk_date)
    print(
        "[pipeline] Fertig: "
        + ", ".join(f"{k}={v}" for k, v in version["counts"].items())
        + f"  → {args.out}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
