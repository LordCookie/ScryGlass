"""Tests für die Kombo-Pipeline (Commander Spellbook → combos.ndjson, M17). Offline."""
import json
import os

import fetch_combos as fc

HERE = os.path.dirname(__file__)
SAMPLE = os.path.join(HERE, "tests", "sample_variants.json")


def load():
    with open(SAMPLE, encoding="utf-8") as f:
        return json.load(f)


def by_id(variants):
    return {v["id"]: v for v in variants}


def test_keep_only_public_combos_without_templates():
    kept = [v["id"] for v in load()["variants"] if fc.keep_variant(v)]
    assert kept == ["a-b", "c-d-e", "lifegain"]


def test_needed_cards_skip_library_zone():
    v = by_id(load()["variants"])
    assert fc.needed_cards(v["c-d-e"]) == 2  # die Karte in der Bibliothek zählt nicht


def test_stars():
    v = by_id(load()["variants"])
    assert fc.stars(v["a-b"]) == 4  # gewinnt, 2 Karten, 3 Mana
    assert fc.stars(v["c-d-e"]) == 3  # gewinnt, 2 nötige Karten, aber 7 Mana
    assert fc.stars(v["lifegain"]) == 1  # nur Trigger, 3 Karten


def test_results_standalone_first_without_helpers():
    v = by_id(load()["variants"])
    assert fc.results_of(v["a-b"]) == ["Win the game"]


def test_build_compact_rows_sorted_by_popularity(tmp_path):
    data = load()
    combos = fc.build(data["variants"], {"source": "Commander Spellbook"})
    head, rows = combos["head"], combos["rows"]
    assert head["meta"]["count"] == 3
    assert [r[0] for r in rows] == ["c-d-e", "a-b", "lifegain"]  # beliebte zuerst
    kiki = rows[0]
    assert [head["cards"][i] for i in kiki[1]] == ["o-kiki", "o-pester", "o-lib"]
    assert kiki[6] == 0b001  # Kiki-Jiki muss Commander sein
    assert kiki[3] == 7 and rows[2][3] == -1  # unbekanntes Mana = -1
    assert kiki[9] == 2  # nötige Karten ohne die in der Bibliothek
    assert [head["results"][i] for i in rows[1][4]] == ["Win the game"]


def test_main_writes_file_and_version_counts(tmp_path):
    (tmp_path / "version.json").write_text(json.dumps({"catalogVersion": "x", "counts": {"cards": 1}}), encoding="utf-8")
    assert fc.main(["--out", str(tmp_path), "--sample", SAMPLE]) == 0
    lines = (tmp_path / "combos.ndjson").read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[0])["meta"]["source"] == "Commander Spellbook"
    assert len(lines) == 4
    version = json.loads((tmp_path / "version.json").read_text(encoding="utf-8"))
    assert version["counts"] == {"cards": 1, "combos": 3}
    assert version["combos"]["version"] == "7.3.6"
