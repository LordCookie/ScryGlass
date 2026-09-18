"""Tests für die pHash-Pipeline. Die Bit-Packung MUSS zur TS-Seite passen
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


# --- pHash an echten (synthetischen) Bildern --------------------------------
pytest.importorskip("PIL")
pytest.importorskip("numpy")
from PIL import Image  # noqa: E402
import io as _io  # noqa: E402


def img_bytes(im: "Image.Image") -> bytes:
    buf = _io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def structured(seed: int) -> "Image.Image":
    im = Image.new("RGB", (146, 204))
    px = im.load()
    for y in range(204):
        for x in range(146):
            v = (x * (3 + seed) + y * (2 + seed) + (x * y) % (17 + seed)) % 256
            px[x, y] = (v, (v * 2) % 256, (v + 90) % 256)
    return im


def test_phash_length_and_identical():
    base = structured(0)
    h1 = hi.phash_hex(img_bytes(base))
    assert len(h1) == 64  # 256 Bit
    assert hamming_hex(h1, hi.phash_hex(img_bytes(base.copy()))) == 0


def test_phash_brightness_robust():
    # pHash ist helligkeitsrobust (Verschiebung trifft v. a. den DC-Term).
    base = structured(1)
    darker = Image.eval(base, lambda v: max(0, v - 50))
    assert hamming_hex(hi.phash_hex(img_bytes(base)), hi.phash_hex(img_bytes(darker))) <= 6


def test_phash_different_far():
    a = hi.phash_hex(img_bytes(structured(2)))
    b = hi.phash_hex(img_bytes(structured(9)))
    assert hamming_hex(a, b) > 40


def test_dct_matrix_orthonormal():
    import numpy as np

    c = hi._dct_matrix(8)
    # Orthonormal: C · C^T = Identität.
    assert np.allclose(c @ c.T, np.eye(8), atol=1e-9)
