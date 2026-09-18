"""Unit-Tests für die Pipeline (PLAN.md M1). Laufen offline über die Sample-Fixture.

    cd pipeline && python -m pytest
"""
import json
import os

import fetch_scryfall as fs

HERE = os.path.dirname(__file__)
SAMPLE = os.path.join(HERE, "tests", "sample_bulk.jsonl")


# --- normalize_name ---------------------------------------------------------

def test_normalize_basic():
    assert fs.normalize_name("Lightning Bolt") == "lightning bolt"


def test_normalize_diacritics_and_ligatures():
    assert fs.normalize_name("Ætherize") == "aetherize"
    assert fs.normalize_name("Lim-Dûl's Vault") == "limduls vault"
    assert fs.normalize_name("Æther Vial") == "aether vial"
    assert fs.normalize_name("Jötun Grunt") == "jotun grunt"


def test_normalize_split_and_punctuation():
    assert fs.normalize_name("Fire // Ice") == "fire ice"
    assert fs.normalize_name("Nezumi Shortfang") == "nezumi shortfang"
    assert fs.normalize_name("Borrowing 100,000 Arrows") == "borrowing 100000 arrows"


def test_normalize_collapses_whitespace():
    assert fs.normalize_name("  Serra   Angel  ") == "serra angel"


# --- trigrams ---------------------------------------------------------------

def test_trigrams_window():
    assert fs.trigrams("bolt") == ["bol", "olt"]
    assert fs.trigrams("ab") == ["ab"]
    assert fs.trigrams("") == []


# --- legality_mask ----------------------------------------------------------

def test_legality_mask_bolt():
    leg = {
        "standard": "not_legal", "pioneer": "not_legal", "modern": "legal",
        "legacy": "legal", "vintage": "legal", "commander": "legal",
        "pauper": "legal", "brawl": "not_legal",
    }
    # modern|legacy|vintage|commander|pauper = 4+8+16+32+64
    assert fs.legality_mask(leg) == 124


def test_legality_mask_restricted_counts_as_legal():
    leg = {"vintage": "restricted", "modern": "banned", "legacy": "not_legal"}
    assert fs.legality_mask(leg) == (1 << 4)


def test_legality_mask_all():
    leg = {f: "legal" for f in fs.FORMATS}
    assert fs.legality_mask(leg) == 255


# --- max_copies -------------------------------------------------------------

def test_max_copies_basic_land():
    assert fs.max_copies("Basic Land — Forest", "({T}: Add {G}.)") == 99


def test_max_copies_any_number_marker():
    txt = "A deck can have any number of cards named Rat Colony."
    assert fs.max_copies("Creature — Rat", txt) == 99


def test_max_copies_default():
    assert fs.max_copies("Instant", "Deal 3 damage.") == 4


# --- keep_card --------------------------------------------------------------

def test_keep_card_filters():
    assert fs.keep_card({"lang": "en", "layout": "normal", "games": ["paper"]})
    assert not fs.keep_card({"lang": "fr", "layout": "normal"})
    assert not fs.keep_card({"lang": "en", "layout": "token"})
    assert not fs.keep_card({"lang": "en", "layout": "normal", "set_type": "memorabilia"})
    # Nur-Online-Karten (kein paper) raus:
    assert not fs.keep_card({"lang": "en", "layout": "normal", "games": ["mtgo", "arena"]})


# --- build_catalog über die Fixture -----------------------------------------

def load_catalog():
    with fs.open_maybe_gzip(SAMPLE) as fp:
        return fs.build_catalog(fs.iter_jsonl(fp))


def test_catalog_counts():
    cat = load_catalog()
    cards = list(cat.card_rows())
    printings = list(cat.printing_rows())
    names = list(cat.name_rows())
    # 7 Oracle-Karten (Token/Memorabilia/fr/Nur-Online gefiltert).
    assert len(cards) == 7
    # 8 Printings (dieselben Filter).
    assert len(printings) == 8
    assert len(names) == 8


def test_catalog_bilingual_names():
    cat = load_catalog()
    by_key = {(n["normName"], n["lang"]): n["oracleId"] for n in cat.name_rows()}
    assert by_key[("lightning bolt", "en")] == "ob-bolt"
    assert by_key[("blitzschlag", "de")] == "ob-bolt"


def test_catalog_card_fields():
    cat = load_catalog()
    by_id = {c["oracleId"]: c for c in cat.card_rows()}

    bolt = by_id["ob-bolt"]
    assert bolt["name"] == "Lightning Bolt"
    assert bolt["normName"] == "lightning bolt"
    assert bolt["legalities"] == 124
    assert bolt["maxCopies"] == 4
    assert bolt["colors"] == ["R"]

    forest = by_id["ob-forest"]
    assert forest["maxCopies"] == 99
    assert forest["legalities"] == 255

    rat = by_id["ob-rat"]
    assert rat["maxCopies"] == 99

    jace = by_id["ob-jace"]
    # modern|legacy|vintage(restricted)|commander = 4+8+16+32
    assert jace["legalities"] == 60


def test_catalog_split_and_dfc_faces():
    cat = load_catalog()
    by_id = {c["oracleId"]: c for c in cat.card_rows()}

    fire_ice = by_id["ob-fireice"]
    assert fire_ice["typeLine"] == "Instant // Instant"
    assert fire_ice["manaCost"] == "{1}{R} // {1}{U}"
    assert set(fire_ice["colors"]) == {"R", "U"}
    assert "Fire deals" in fire_ice["oracleText"]
    assert "Tap target" in fire_ice["oracleText"]

    delver = by_id["ob-delver"]
    assert delver["colors"] == ["U"]
    assert "beginning of your upkeep" in delver["oracleText"]
    assert "Flying" in delver["oracleText"]


def test_catalog_trigram_index():
    cat = load_catalog()
    tri = {t["trigram"]: set(t["oracleIds"]) for t in cat.trigram_rows()}
    # aus "blitzschlag"
    assert "bli" in tri and "ob-bolt" in tri["bli"]
    # aus "lightning bolt"
    assert "lig" in tri and "ob-bolt" in tri["lig"]
    # aus "forest"
    assert "for" in tri and "ob-forest" in tri["for"]


def test_english_printing_is_canonical():
    """Der Oracle-Record nimmt die englische Ausgabe, auch wenn die de zuerst käme."""
    de_first = [
        {"object": "card", "id": "d1", "oracle_id": "x", "name": "Counterspell",
         "printed_name": "Gegenzauber", "lang": "de", "set": "s", "collector_number": "1",
         "layout": "normal", "type_line": "Zauber", "oracle_text": "",
         "legalities": {}, "games": ["paper"]},
        {"object": "card", "id": "e1", "oracle_id": "x", "name": "Counterspell",
         "lang": "en", "set": "s", "collector_number": "2", "layout": "normal",
         "type_line": "Instant", "oracle_text": "Counter target spell.",
         "legalities": {"legacy": "legal"}, "games": ["paper"]},
    ]
    cat = fs.build_catalog(de_first)
    card = list(cat.card_rows())[0]
    assert card["typeLine"] == "Instant"  # englisch, nicht "Zauber"
    assert card["oracleText"] == "Counter target spell."


# --- write_catalog roundtrip ------------------------------------------------

def test_write_catalog_roundtrip(tmp_path):
    cat = load_catalog()
    version = fs.write_catalog(cat, str(tmp_path), bulk_date="2026-09-01")

    for fname in ("cards.ndjson", "printings.ndjson", "names.ndjson", "trigrams.ndjson"):
        p = tmp_path / fname
        assert p.exists()
        # Jede Zeile ist gültiges JSON (NDJSON, PLAN.md E2).
        for line in p.read_text(encoding="utf-8").splitlines():
            json.loads(line)

    v = json.loads((tmp_path / "version.json").read_text(encoding="utf-8"))
    assert v["counts"] == version["counts"]
    assert v["counts"]["cards"] == 7
    assert v["scryfallBulkDate"] == "2026-09-01"
    assert v["catalogVersion"]
