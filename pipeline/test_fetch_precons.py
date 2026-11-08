"""Tests für die Fertigdeck-Pipeline (MTGJSON → precons.ndjson, M19). Offline."""
import io
import json
import os
import tarfile

import fetch_precons as fp

HERE = os.path.dirname(__file__)
DECKS = os.path.join(HERE, "tests", "sample_decks")
PRINTINGS = os.path.join(HERE, "tests", "sample_printings.ndjson")


def built(known=True):
    return fp.build(fp.iter_dir(DECKS), {"source": "MTGJSON"}, fp.load_known(PRINTINGS) if known else None)


def by_key(result):
    return {r[0]: r for r in result["rows"]}


def resolve(result, board):
    """[[idx, n, f]] → [(scryfallId, n, f)] zum Vergleichen."""
    p = result["head"]["printings"]
    return sorted((p[i], n, f) for i, n, f in board)


def test_only_buyable_types():
    keys = set(by_key(built()))
    assert "Online_TST" not in keys  # MTGO-Decks kommen nicht mit
    assert built()["stats"]["skippedType"] == 1


def test_commander_deck_boards():
    res = built()
    row = by_key(res)["CavalryCharge_TST"]
    key, name, set_code, date, group, typ, cmd, main, side, extra, tokens, unknown = row
    assert (name, set_code, date, group, typ) == ("Cavalry Charge", "tst", "2026-04-21", "commander", "Commander Deck")
    assert resolve(res, cmd) == [("p-cmd", 1, fp.FINISH_FOIL)]
    # Gleiche Karte + Ausführung zusammengelegt (30 + 5 Plains), etched vor foil.
    assert resolve(res, main) == [("p-etch", 1, fp.FINISH_ETCHED), ("p-plains", 35, 0), ("p-sol", 1, 0)]
    assert side == []
    # Display-Commander und Planes liegen bei, gehören aber nicht ins Deck.
    assert resolve(res, extra) == [("p-disp", 1, fp.FINISH_FOIL), ("p-plane", 1, 0)]
    # Unbekannte Tokens fallen still weg und zählen nicht als fehlende Deckkarten.
    assert resolve(res, tokens) == [("p-tok", 2, 0)]
    assert unknown == 0


def test_unknown_cards_counted_and_decks_dropped():
    res = built()
    rows = by_key(res)
    assert rows["OldTheme_TST"][-1] == 1  # 1 von 7 Karten unbekannt → bleibt, gezählt
    assert "Memorial_TST" not in rows  # 9 von 10 unbekannt → fällt weg
    assert res["stats"]["droppedUnknown"] == 1
    # Drucke verworfener Decks landen nicht im Kopf.
    assert "p-gone" not in res["head"]["printings"]


def test_without_catalog_everything_stays():
    rows = by_key(built(known=False))
    assert "Memorial_TST" in rows and rows["Memorial_TST"][-1] == 0


def test_rows_newest_first():
    dates = [r[3] for r in built()["rows"]]
    assert dates == sorted(dates, reverse=True)


def test_tar_stream_matches_directory():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:xz") as tar:
        for name in sorted(os.listdir(DECKS)):
            tar.add(os.path.join(DECKS, name), arcname=f"AllDeckFiles/{name}")
    buf.seek(0)
    from_tar = fp.build(fp.iter_tar(fileobj=buf), {}, fp.load_known(PRINTINGS))
    assert [r[0] for r in from_tar["rows"]] == [r[0] for r in built()["rows"]]


def test_main_writes_file_and_version_counts(tmp_path):
    (tmp_path / "version.json").write_text(json.dumps({"catalogVersion": "x", "counts": {"cards": 1}}), encoding="utf-8")
    assert fp.main(["--out", str(tmp_path), "--sample", DECKS, "--catalog", PRINTINGS]) == 0
    lines = (tmp_path / "precons.ndjson").read_text(encoding="utf-8").splitlines()
    head = json.loads(lines[0])
    assert head["meta"]["source"] == "MTGJSON" and head["meta"]["count"] == 2
    assert len(lines) == 3
    version = json.loads((tmp_path / "version.json").read_text(encoding="utf-8"))
    assert version["counts"]["precons"] == 2 and version["precons"]["source"] == "MTGJSON"
