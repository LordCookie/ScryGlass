"""ScryGlass-Icon & Startbildschirm als Pixel-Art (DESIGN.md § 4/§ 7).

Motiv: Karte mit Lupe davor („Scry-Glass"), 32×32 Pixel, Palette aus DESIGN.md § 2.
Erzeugt aus EINER Sprite-Definition alle Android-Icons (adaptiv + klassisch + rund),
die Startbildschirme und die PWA-Icons — immer ganzzahlig skaliert (Nearest Neighbor),
damit die Pixel scharf bleiben.

Aufruf (aus dem Repo-Wurzelverzeichnis):  python design/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / 'app' / 'android' / 'app' / 'src' / 'main' / 'res'
PUBLIC = ROOT / 'app' / 'public'

INK900 = (0x25, 0x0E, 0x47, 255)
INK800 = (0x38, 0x25, 0x54, 255)
V600 = (0x4C, 0x1D, 0x95, 255)
V500 = (0x64, 0x25, 0xC2, 255)
V400 = (0x79, 0x2D, 0xEB, 255)
LILAC = (0xD0, 0xB0, 0xFF, 255)
PAPER = (0xF2, 0xE9, 0xFF, 255)
GLASS = (0x9A, 0x6B, 0xF5, 255)  # Linsenfläche
T = (0, 0, 0, 0)
N = 32


def sprite() -> Image.Image:
    px = [[T] * N for _ in range(N)]

    def rect(x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                px[y][x] = c

    # Karte: Rahmen violet-400, Körper violet-600, Pixel-Kerben statt runder Ecken
    cx0, cy0, cx1, cy1 = 2, 2, 17, 24
    rect(cx0, cy0, cx1, cy1, V400)
    rect(cx0 + 1, cy0 + 1, cx1 - 1, cy1 - 1, V600)
    for x, y in [(cx0, cy0), (cx1, cy0), (cx0, cy1), (cx1, cy1)]:
        px[y][x] = T
    rect(cx0 + 2, cy0 + 2, cx1 - 2, cy0 + 3, LILAC)  # Titelbalken
    rect(cx0 + 2, cy0 + 5, cx1 - 2, cy0 + 12, INK800)  # Bildfenster
    for i, h in enumerate([0, 1, 2, 3, 2, 1, 2, 3, 4, 3, 2, 1]):  # Berge
        for d in range(h):
            px[cy0 + 12 - d][cx0 + 2 + i] = V500
    px[cy0 + 7][cx1 - 4] = PAPER  # Stern
    for row in (cy0 + 15, cy0 + 17, cy0 + 19):  # Textzeilen
        rect(cx0 + 2, row, cx1 - 3 - (row % 3), row, V500)

    # Lupe: Rand lilac, Glas getönt, Glanzlicht, kräftiger Griff mit Schattenkante
    ox, oy, r_out, r_in = 20, 16, 7.5, 5.6
    for y in range(N):
        for x in range(N):
            d = ((x - ox) ** 2 + (y - oy) ** 2) ** 0.5
            if d <= r_in:
                px[y][x] = GLASS
            elif d <= r_out:
                px[y][x] = LILAC
    for x, y in [(17, 13), (18, 12), (19, 12), (17, 14)]:
        px[y][x] = PAPER
    for i in range(6):
        x, y = 25 + i, 21 + i
        for dx, dy, c in [(0, 0, LILAC), (1, 0, LILAC), (0, 1, LILAC), (1, 1, V500)]:
            px[y + dy][x + dx] = c

    im = Image.new('RGBA', (N, N))
    im.putdata([c for row in px for c in row])
    return im


def scaled(k: int) -> Image.Image:
    return sprite().resize((N * k, N * k), Image.NEAREST)


def centered(canvas: Image.Image, k: int) -> Image.Image:
    s = scaled(k)
    canvas.alpha_composite(s, ((canvas.width - s.width) // 2, (canvas.height - s.height) // 2))
    return canvas


# Dichte → (Faktor für 48dp-Icons, Pixel pro dp)
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def content_radius() -> float:
    """Abstand des äußersten sichtbaren Pixels von der Mitte (in Sprite-Pixeln)."""
    im = sprite()
    c = N / 2
    return max(
        ((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2) ** 0.5
        for y in range(N) for x in range(N) if im.getpixel((x, y))[3] > 0
    )


def android_icons() -> None:
    radius = content_radius()
    for name, dpi in DENSITIES.items():
        d = RES / f'mipmap-{name}'
        # Adaptiver Vordergrund: 108 dp. Jede Launcher-Maske (Kreis, Quadrat …) lässt die
        # innere 66-dp-Kreiszone stehen → das Motiv muss mit seinem äußersten Pixel dort
        # hineinpassen (ganzzahliger Faktor, sonst würden die Pixel ungleich breit).
        fg_size = round(108 * dpi)
        k = max(1, int(33 * dpi // radius))
        centered(Image.new('RGBA', (fg_size, fg_size), T), k).save(d / 'ic_launcher_foreground.png')
        # Klassisches Icon (Android < 8): violettes Quadrat mit Pixel-Kerben
        size = round(48 * dpi)
        sq = Image.new('RGBA', (size, size), T)
        draw = ImageDraw.Draw(sq)
        m = max(1, size // 16)
        draw.rectangle([m, m, size - m - 1, size - m - 1], fill=INK900)
        notch = max(1, size // 24)
        for cx, cy in [(m, m), (size - m - notch, m), (m, size - m - notch), (size - m - notch, size - m - notch)]:
            draw.rectangle([cx, cy, cx + notch - 1, cy + notch - 1], fill=T)
        k = max(1, int(size * 0.7 // N))
        centered(sq, k).save(d / 'ic_launcher.png')
        # Rundes Icon
        rd = Image.new('RGBA', (size, size), T)
        ImageDraw.Draw(rd).ellipse([m, m, size - m - 1, size - m - 1], fill=INK900)
        centered(rd, max(1, int(size * 0.6 // N))).save(d / 'ic_launcher_round.png')


def splashes() -> None:
    for p in sorted(RES.glob('drawable*/splash.png')):
        w, h = Image.open(p).size
        k = max(1, round(min(w, h) * 0.28 / N))
        centered(Image.new('RGBA', (w, h), INK900), k).convert('RGB').save(p)


def pwa_icons() -> None:
    out = PUBLIC / 'icons'
    out.mkdir(exist_ok=True)
    for size in (192, 512):
        # „maskable": vollflächiger Hintergrund, Motiv in der inneren Sicherheitszone
        centered(Image.new('RGBA', (size, size), INK900), max(1, int(size * 0.6 // N))).save(out / f'icon-{size}.png')
    centered(Image.new('RGBA', (32, 32), T), 1).save(out / 'favicon-32.png')


if __name__ == '__main__':
    android_icons()
    splashes()
    pwa_icons()
    print('Icons, Startbildschirme und PWA-Icons erzeugt.')
