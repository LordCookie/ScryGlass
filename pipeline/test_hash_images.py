"""Tests für die dHash-Pipeline. Die Bit-Logik MUSS zur TS-Seite passen
(app/src/data/imageHash.ts), sonst matcht kein Bild."""
import pytest

import hash_images as hi


def hamming_hex(a: str, b: str) -> int:
    ba, bb = bytes.fromhex(a), bytes.fromhex(b)
    return sum(bin(x ^ y).count("1") for x, y in zip(ba, bb))


def test_bits_to_hex():
    assert hi.bits_to_hex([1, 0, 0, 0, 0, 0, 0, 0]) == "80"
    assert hi.bits_to_hex([1, 1, 1, 1, 1, 1, 1, 1]) == "ff"
    assert hi.bits_to_hex([0] * 8) == "00"
    assert hi.bits_to_hex([1, 0, 1, 0, 1, 0, 1, 0]) == "aa"


def test_dhash_bits_ordering():
    # size=2 → 2×3-Matrix, 4 Bits, row-major (row*size+col).
    gray = [[10, 5, 20], [3, 9, 1]]
    # row0: 10>5 =1, 5>20 =0 ; row1: 3>9 =0, 9>1 =1
    assert hi.dhash_bits(gray, size=2) == [1, 0, 0, 1]


# --- perceptual-Eigenschaft an echten (synthetischen) Bildern ---------------
PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402
import io as _io  # noqa: E402


def img_bytes(im: "Image.Image") -> bytes:
    buf = _io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def test_dhash_identical_and_similar():
    # Ein „Kartenbild": horizontaler Verlauf mit ein paar Blöcken.
    base = Image.new("RGB", (146, 204))
    px = base.load()
    for y in range(204):
        for x in range(146):
            px[x, y] = ((x * 3) % 256, (y * 2) % 256, ((x + y) * 2) % 256)

    h1 = hi.dhash_hex(img_bytes(base))
    assert len(h1) == 64  # 256 Bit = 32 Byte = 64 Hex

    # Gleiches Bild → Distanz 0.
    assert hamming_hex(h1, hi.dhash_hex(img_bytes(base.copy()))) == 0

    # Leicht abgedunkelt (Licht) → kleine Distanz (dHash ist helligkeitsrobust).
    darker = Image.eval(base, lambda v: max(0, v - 40))
    assert hamming_hex(h1, hi.dhash_hex(img_bytes(darker))) <= 8


def test_dhash_different_images_far():
    a = Image.new("RGB", (146, 204), (10, 10, 10))
    b = Image.new("RGB", (146, 204), (240, 240, 240))
    # Konstante Bilder: dHash ist all-0 (keine Nachbardifferenz) → identisch.
    # Deshalb mit STRUKTUR testen: zwei verschiedene Muster müssen weit sein.
    pa, pb = a.load(), b.load()
    for y in range(204):
        for x in range(146):
            pa[x, y] = (255 if (x // 8) % 2 == 0 else 0,) * 3
            pb[x, y] = (255 if (y // 8) % 2 == 0 else 0,) * 3  # vertikal statt horizontal
    ha = hi.dhash_hex(img_bytes(a))
    hb = hi.dhash_hex(img_bytes(b))
    assert hamming_hex(ha, hb) > 40  # klar verschieden
