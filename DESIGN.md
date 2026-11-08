# DESIGN.md — Pixel-Designsystem

> Ergänzt `PLAN.md`. Gilt für die gesamte App.
> Grundidee: **Pixel-Art als Handwerk, nicht als Filter.** Alles wird auf einem
> festen Pixelraster gebaut, in einer festen Palette gezeichnet und in `steps()`
> animiert. Kein Blur, kein Radius, keine weichen Verläufe — nirgends.

---

## 1. Konzept

### Das Bewegungsvokabular

Die App hat **kein Maskottchen** und braucht keins. Das Material für Animationen
liefert der Gegenstand selbst: Karte, Stapel, Manasymbol, Foil-Glanz.

Daraus vier Primitive, die überall wiederverwendet werden — jede Animation der App
ist eine Kombination davon:

| Primitive | Frames | Bedeutung |
|---|---|---|
| **Flip** — Karte dreht sich um | 4 | Etwas wird aufgedeckt oder wechselt den Zustand |
| **Stapeln** — Karte fliegt auf einen Stapel | 6 | Etwas wurde hinzugefügt |
| **Foil-Sweep** — diagonales Dither-Band läuft über eine Fläche | 6 | Erfolg, fertig, bestätigt |
| **Tick** — Zähler springt in ganzen Schritten | — | Menge hat sich geändert |

Das ist die Disziplin dahinter: kein Screen bekommt eigene Spezial-Sprites. Wer eine
neue Animation braucht, setzt sie aus diesen vieren zusammen. Das hält die Asset-
Menge klein und die App zusammenhängend.

Falls später doch eine Figur dazukommt: sie setzt auf diesem Vokabular auf und
bekommt Zustände statt einer Dauerschleife. Aber sie ist kein offener Posten — die
App funktioniert vollständig ohne.

### Der Kartenrahmen als Layout-Primitive

Jede MTG-Karte hat dieselbe Struktur: Titelbalken oben (Name links, Manakosten
rechts), Typzeile, Textfeld. **Diese Struktur ist das Layout-Primitive der App.**

Eine Zeile in der Sammlung ist ein Mini-Kartenrahmen. Ein Scan-Treffer ist ein
Mini-Kartenrahmen. Ein Deck-Eintrag ist ein Mini-Kartenrahmen. Kein Deck aus
generischen Cards mit Radius und Schatten — die Form kommt aus dem Gegenstand.

Nebeneffekt: der Scanner liest den Titelbalken, und die App **zeigt** Titelbalken.
Die Interaktion erklärt sich selbst.

### Wo die Boldness hingeht

Ein lauter Moment, der Rest ruhig: **der Erstimport.** Der läuft eine Minute, ist
das Erste was man von der App sieht, und ist der einzige Ort, an dem Animation den
Bildschirm füllen darf. Sein Gegenstück im Browser (Big Screen, A10) darf das auch —
dort ist es ebenfalls das Erste, was man sieht.

Überall sonst gilt: Bewegung antwortet auf eine Handlung. Keine Screen-Transitions,
keine Hover-Effekte, keine Elemente die von allein einfliegen.

---

## 2. Farbe

Dark only. Kein Light-Mode — Pixel-Art in Violett funktioniert hell nicht, und die
App wird in schlecht beleuchteten Räumen benutzt (Küchentisch, Laden, abends).
Statt Light-Mode gibt es einen Regler für die HUD-Deckkraft über dem Kamerabild.

### Tokens

```css
:root {
  /* Basis (deine Palette) */
  --ink-900:    #250E47;   /* tiefster Hintergrund */
  --ink-800:    #382554;   /* Flächen, Listenzeilen */
  --ink-700:    #3A1570;   /* erhöhte Flächen, Sheets */
  --violet-600: #4C1D95;   /* Primär, Titelbalken */
  --violet-500: #6425C2;   /* gedrückt / aktiv */
  --violet-400: #792DEB;   /* Rahmen, Fokus, Fortschritt */
  --lilac-200:  #D0B0FF;   /* Primärtext, Highlights */
  --paper:      #F2E9FF;   /* max. Kontrast, nur über Kamerabild */

  /* Semantik (ergänzt — deine Palette hatte keine) */
  --ok:         #3FBF8F;   /* Treffer sicher */
  --warn:       #94901C;   /* unsicher, bitte prüfen */
  --warn-bg:    #3F3E21;   /* Fläche dazu */
  --bad:        #E8546B;   /* kein Treffer, Fehler */
}
```

Du hattest `#250E47` doppelt gelistet — den zweiten Platz habe ich mit `#382554` aus
deiner Komplementärliste belegt. Das ist genau die Zwischenstufe, die als
Flächenfarbe gefehlt hat.

Grün und Rot musste ich ergänzen. Ein Scanner lebt von „Treffer / unsicher /
daneben", und das darf nicht nur über Text laufen. `#94901C` ist als Warnfarbe
perfekt — es ist die echte Komplementärfarbe zu deinem Violett und beißt sich
deshalb sichtbar, ohne fremd zu wirken.

### Kontrast — gemessen, nicht geschätzt

| Kombination | Ratio | Verwendung |
|---|---|---|
| `--lilac-200` auf `--ink-900` | **9,2 : 1** | Primärtext. Der Standardfall. |
| `--lilac-200` auf `--violet-600` | **5,9 : 1** | Text im Titelbalken. |
| `--ok` auf `--ink-900` | **7,4 : 1** | Treffer-Status |
| `--warn` auf `--ink-900` | **5,1 : 1** | Warn-Status |
| `--bad` auf `--ink-900` | **4,8 : 1** | Fehler |
| `--violet-400` auf `--ink-900` | **2,8 : 1** | ⚠️ **niemals Text.** Nur Rahmen, Füllungen, Fortschrittsbalken. |

Die letzte Zeile ist die Falle. `#792DEB` sieht auf Dunkelviolett kräftig aus und ist
trotzdem unlesbar. Wenn irgendwo Text in dieser Farbe landet, ist es ein Bug.

---

## 3. Typografie

Zwei Schnitte, klar getrennte Rollen.

**Press Start 2P** — Zahlen, kurze Labels, HUD. Bitmap-Schrift nach Namco-Arcade-
Vorbild, funktioniert nur in Vielfachen von 8px. Sehr breit → **niemals für
deutsche Fließtexte**, sonst platzt jede Zeile. Zähler, Prozente, Set-Codes,
Button-Beschriftungen mit maximal zwei Wörtern.

**Pixelify Sans** — alles andere. Unterstützt Basic Latin, Latin-1 Supplement und
Latin Extended-A, also `ä ö ü ß` sicher. Vier Gewichte, vom Autor explizit für
kleine Größen gebaut.

### Skala (8px-Basis)

| Rolle | Schrift | Größe | Zeilenhöhe |
|---|---|---|---|
| Zähler / Display | Press Start 2P | 24 | 32 |
| HUD / Sektionslabel | Press Start 2P | 16 | 24 |
| Kartenname | Pixelify Sans SemiBold | 18 | 24 |
| Body | Pixelify Sans Regular | 16 | 26 |
| Meta (Set, Nummer, Anzahl) | Pixelify Sans Regular | 14 | 20 |

**Kartennamen brechen auf zwei Zeilen, sie werden nie abgeschnitten.** „Jace, der
Gedankenbildhauer" mit Ellipse ist wertlos. Zeilenlänge im Deckbau-Regeltext max.
60 Zeichen, Leading 1,6 — Pixelschrift braucht mehr Luft als eine normale Sans.

Ausrichtung: durchgehend linksbündig. Nur der Import-Screen ist zentriert.

---

## 4. Pixel-Regeln

Das hier ist der Unterschied zwischen „sieht pixelig aus" und „ist pixelig".

```css
:root { --px: 3; }        /* 1 Design-Pixel = 3 CSS-Pixel auf dem Handy */
```

Alles wird bei `--px: 1` gezeichnet und **ganzzahlig** skaliert. Abstände sind immer
Vielfache von `calc(var(--px) * 4)`.

- **`border-radius: 0`.** Überall. Ausnahmslos.
- **Rahmen:** `calc(var(--px) * 2)` harte Kante. Ecken als ausgestanzte Einzelpixel
  (`clip-path` mit 4 Kerben) — das ist der Effekt, der echt aussieht, nicht das
  Rechteck mit Border.
- **Schatten ohne Blur:** `box-shadow: var(--px) var(--px) 0 var(--ink-900)`.
  Buttons versetzen sich beim Druck um 1 Pixel und verlieren den Schatten.
- **Keine CSS-Verläufe.** Übergänge als **Dither** (2×2-Bayer-Muster, als
  `repeating-linear-gradient` mit harten Stops oder kachelndes PNG).
- **`image-rendering: pixelated`** auf allem Sprite-haften.
  Fallback für ältere WebViews: `-webkit-optimize-contrast`.
- **Touch-Targets mindestens 48px**, auch wenn das Raster 4px ist. Buttons sind
  48 oder 56 hoch, nie dazwischen.
- **Fokus:** `outline: calc(var(--px)*2) solid var(--lilac-200); outline-offset: var(--px);`

### Die Skalierungsfalle

Viele Android-Geräte haben ein `devicePixelRatio` wie 2,75 oder 3,5. Sprites werden
dann trotz `pixelated` matschig, weil ein Design-Pixel auf 2,75 Geräte-Pixel fällt.

Lösung: `--px` beim Start auf `Math.floor(devicePixelRatio)` setzen und die Breite in
ganzen CSS-Pixel-Vielfachen vergeben. Lieber 4px Rand am Bildschirmrand als
verschmierte Kanten.

---

## 5. Animation

**Nur `steps()`, nie `ease`.** Eine Pixel-Animation, die interpoliert, ist keine
Pixel-Animation. 8–12 fps, nicht mehr — Pixel-Art lebt von wenigen, klaren Frames.

Technik durchgehend: horizontaler Sprite-Streifen als PNG, `background-position` mit
`steps(n)` animiert. Kein Canvas, kein JS-Loop, keine Animation-Library.

```css
.stack-add {
  width: calc(24px * var(--px));
  height: calc(32px * var(--px));
  background: url(/sprites/stack-add.png) 0 0 / calc(24px * var(--px) * 6) 100%;
  image-rendering: pixelated;
  animation: stack-add 0.5s steps(6) 1;
}
@keyframes stack-add { to { background-position-x: calc(-24px * var(--px) * 6); } }
```

Der Grund für CSS statt JS ist nicht Bequemlichkeit: `transform` und
`background-position` laufen auf dem Compositor. **Die Animation läuft weiter,
während Tesseract den Main-Thread blockiert.** Eine JS-Animation würde genau dann
ruckeln, wenn es am meisten auffällt.

### Katalog

**A1 — Erstimport.** Der einzige große Moment. 30–60 Sekunden sind eine Ewigkeit,
also braucht das Struktur statt Endlosschleife:

- **Kartenstapel, der sich sortiert.** Ein unordentlicher Pixel-Haufen, aus dem
  Karten einzeln auf einen ordentlichen Stapel fliegen (Primitive *Stapeln*, 8 fps,
  Loop). Zeigt genau das, was gerade passiert.
- **Fünf Manasymbole als Phasenanzeige.** Der Import hat exakt fünf Phasen —
  Karten, Editionen, Namen (DE), Namen (EN), Index. Jede fertige Phase füllt ein
  Pip. Man sieht auf einen Blick, wie weit es ist, ohne die Prozentzahl zu lesen.
- **Fortschrittsbalken**, 8 Design-Pixel hoch, `--violet-400`, harte Kante. Darüber
  läuft alle paar Sekunden ein *Foil-Sweep* — das einzige Glanzelement der App.
- **Echte Zahl:** `12.480 / 31.200`.
- Bei 100 %: alle fünf Pips leuchten einmal auf, der Stapel setzt sich.

Copy: **„Katalog wird geladen. Das passiert nur einmal."** Keine Entschuldigung,
keine Fortschritts-Lüge.

**A2 — Reticle (idle).** Vier Pixelecken auf Höhe des Titelbalkens. 2 Frames, 1 fps,
1 Pixel Pulsieren. Mehr nicht — das Kamerabild ist der Star.

**A3 — Treffer.** Ecken schnappen auf `--ok`, *Foil-Sweep* über den Mini-Rahmen,
Kartenname tippt sich in 4 Steps ein. 200 ms. Kein Konfetti.

**A4 — Unsicher.** Ecken `--warn`, der Mini-Rahmen bekommt eine Dither-Füllung.
Signalisiert: kommt in den Korb, aber schau nochmal drauf.

**A5 — Daneben.** Ecken `--bad`, 3-Frame-Shake (±2 Design-Pixel), 150 ms.

**A6 — In den Korb.** *Stapeln* — Mini-Kartenrahmen fliegt zum Korb-Icon, Zähler
*tickt* hoch. Die wichtigste Bestätigung der App: passiert beim Bulk-Scannen
hunderte Male, also kurz und leise.

**A7 — Peer-Push.** Karten fliegen einzeln nach rechts über den Fortschritt
(*Stapeln*, gespiegelt). Auf der Empfängerseite wächst der Stapel.

**A8 — Leere Zustände.** **Keine Animation.** Ein leerer Kartenrahmen mit
gestrichelter Pixelkontur, dazu eine Einladung statt einer Zustandsbeschreibung:
„Noch nichts gescannt. Halt die Kamera auf den Kartennamen."

**A9 — Deck gültig.** Pixel-Stempel knallt einmal drauf, 3 Frames. Nur beim Wechsel
auf gültig, nicht bei jedem Re-Render.

### Big Screen (PLAN.md M18)

**A10 — Katalog kommt vom Handy.** Das Gegenstück zu A1 im Browser: Beim ersten
Anmelden (und bei jedem neuen Katalogstand) lädt der Browser den Katalog übers WLAN vom
Handy, 10–30 Sekunden. Der zweite Ort, an dem Animation den Bildschirm füllen darf. Keine
neuen Sprites — alles aus den vier Primitiven und dem Kartenrahmen:

- **Zwei große Kartenrahmen** nebeneinander, Titelbalken „Dein Handy" und „Dieser
  Browser". Links liegt ein unordentlicher Pixel-Haufen, rechts wächst ein ordentlicher
  Stapel.
- **Karten fliegen von links nach rechts** (*Stapeln*, wie A7) und drehen sich beim
  Landen um (*Flip*). Auf der Vorderseite steht ein **echter Kartenname aus dem laufenden
  Import** („Sol Ring", „Blitzschlag", „Rhystic Study"), deutsch wenn vorhanden. Höchstens
  drei Namen pro Sekunde, damit man sie lesen kann.
- **Das Tempo folgt dem echten Fortschritt**: eine fliegende Karte je ~1.000 importierte
  Zeilen, höchstens 8 fps. Hängt das WLAN, bleiben die Karten liegen — keine Bewegung,
  die etwas vorgaukelt.
- **Fünf Manasymbole als Phasen**, wie A1: Karten, Druckausgaben, Namen, Kombos, Sammlung &
  Decks. Jede fertige Phase füllt ein Pip.
- **Fortschrittsbalken** wie A1, darüber ab und zu ein *Foil-Sweep*. Echte Zahlen:
  `12.480 / 35.539 Karten · 6,1 / 16 MB`.
- Bei 100 %: alle fünf Pips leuchten einmal auf, der Stapel setzt sich, *Foil-Sweep*
  über den Stapel, dann ist die App da (ohne Übergang).
- Bricht die Verbindung ab: Der Flug stoppt, Pips und Zahlen bleiben stehen, darunter
  „Verbindung zum Handy unterbrochen — versuche es weiter…". Es geht mit der angefangenen
  Datei weiter, nicht von vorn.
- Der PC hat Platz: Sprites in ganzzahliger Vergrößerung (4× bis 6×, `image-rendering:
  pixelated`), nie verwaschen skaliert.

Copy: **„Der Katalog kommt von deinem Handy, nicht aus dem Internet. Das passiert nur
einmal je Katalogstand."**

Ist der Katalog schon aktuell, gibt es nur Phase 5 (Sammlung & Decks, meist unter einer
Sekunde): **keine** große Animation, nur ein kleiner *Stapeln*-Sprite mit „Verbinde mit
dem Handy…", und auch der erst nach 0,3 s.

**A11 — Neuer Scan vom Handy.** Unten rechts: Mini-Kartenrahmen fliegt herein (*Stapeln*,
von unten), Name tippt sich ein wie A3, Zähler „neu seit Anmeldung" *tickt*. Nach ein paar
Sekunden rutscht der Rahmen in den Zähler. Scan am Handy rückgängig gemacht: Strich durch
den Namen, kein Wackeln. Die Ausnahme von „nichts fliegt von allein ein": Die Handlung
passiert am Handy, die Animation zeigt sie hier.

### Performance-Regeln

- Während `body.is-scanning`: **nur A2–A6.** Alles Dekorative pausiert.
- Nur `transform` und `background-position` animieren. Nichts, was Layout auslöst.
- Sprite-Frames maximal 64×64 Design-Pixel, PNG-8 mit der Palette → wenige KB.
- `prefers-reduced-motion`: Sprites auf Frame 1 einfrieren. **Fortschrittsbalken,
  Pips und Zähler laufen weiter** — das ist Information, keine Deko.

---

## 6. Layout

### Scanner

```
┌──────────────────────────────────┐
│▓ SCANNEN            Ziel: ICH ▾ ▓│  violet-600, Ziel immer sichtbar
├──────────────────────────────────┤
│                                  │
│    ┌─┐                    ┌─┐    │  Reticle sitzt auf dem Titelbalken
│    └ ┘  K A M E R A B I L D └ ┘   │
│                                  │
│                                  │
├──────────────────────────────────┤
│ Gelesen: "Blitzschiag"           │  ehrlich, klein, lilac-200
│ ┌──────────────────────────────┐ │
│ │▓ Blitzschlag            {R} ▓│ │  Treffer als Mini-Kartenrahmen
│ │  Instant · DMU 123 · DE  0,72│ │
│ └──────────────────────────────┘ │
├──────────────────────────────────┤
│                        KORB  23  │  Primäraktion unten: Einhandbetrieb
└──────────────────────────────────┘
```

Das „Gelesen:"-Feld bleibt drin, wie bei engram. Es baut Vertrauen und ist beim
Tunen unbezahlbar.

### Sammlung

```
┌──────────────────────────────────┐
│▓ Blitzschlag                {R} ▓│
│  Instant · DMU 123 · DE      ×4  │
└──────────────────────────────────┘
┌──────────────────────────────────┐
│▓ Elbenfürst von Llanowar  {1}{G}▓│
│  Kreatur · DOM 168 · DE   ×2 ✦1  │  ✦ = Foil
└──────────────────────────────────┘
```

### Import

```
              ▓▓▓
            ▓▓▓▓▓▓        ← Stapel sortiert sich
          ▓▓▓▓▓▓▓▓▓

   ┌────────────────────────────┐
   │ KATALOG WIRD GELADEN       │
   │                            │
   │   ●   ●   ●   ○   ○        │  5 Pips = 5 Phasen
   │                            │
   │ ████████████░░░░░░░░░░░░░  │
   │ 12.480 / 31.200            │
   │ Namen (Deutsch)            │
   │                            │
   │ Das passiert nur einmal.   │
   └────────────────────────────┘
```

### Peer-Eingang

```
┌──────────────────────────────────┐
│▓ EINGANG                        ▓│
├──────────────────────────────────┤
│ Von Nik · 47 Karten · vor 2 Min  │
│ ┌──────────────────────────────┐ │
│ │▓ Blitzschiag → Blitzschlag  ▓│ │  ← 0,68, oben, warn-Rahmen
│ │  prüfen            [✓]  [✗]  │ │
│ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │
│ │▓ Elbenfürst von Llanowar    ▓│ │  ← 0,97, ok-Rahmen
│ └──────────────────────────────┘ │
│        [ 45 ÜBERNEHMEN ]         │
└──────────────────────────────────┘
```

Nach Confidence aufsteigend sortiert: das Verdächtige steht oben, der Rest wird
durchgewinkt.

---

## 7. Sprite-Pipeline

- **Aseprite** (oder LibreSprite, kostenlos). Export als horizontaler Streifen + JSON.
- Palette als `design/palette.gpl` aus den Tokens erzeugen und in Aseprite laden —
  so kann gar nichts außerhalb der 12 Farben gezeichnet werden.
- Ablage: `app/public/sprites/<name>.png`

| Datei | Frames | Primitive |
|---|---|---|
| `card-flip.png` | 4 | Flip |
| `stack-add.png` | 6 | Stapeln |
| `stack-sort.png` | 8 | Stapeln (Import-Loop) |
| `foil-sweep.png` | 6 | Foil-Sweep |
| `mana-pips.png` | 2 × 5 | leer / gefüllt, W U B R G |
| `reticle.png` | 2 | — |
| `stamp-legal.png` | 3 | — |
| `card-empty.png` | 1 | — (leere Zustände) |

**Sprites gehören ins Repo** (klein, selbst gezeichnet) — im Gegensatz zu den
Kartendaten.

---

## 8. Einordnung in die Meilensteine

| # | Was | parallel zu |
|---|---|---|
| D1 | Tokens, Pixel-Primitives (Rahmen, Button, Titelbalken), Schriften | M2 |
| D2 | Import-Screen: Stapel, Pips, Foil-Sweep | M3 |
| D3 | Scanner-HUD, Reticle, A2–A6 | M5 |
| D4 | Sammlungsliste als Kartenrahmen | M5 |
| D5 | Deck-Ansicht, Manakurve als Pixel-Balken, A9 | M7 |
| D6 | Peer-Screens, QR im Pixelrahmen, A7 | M8 |

**D1 und D2 zuerst**, noch vor dem Scanner. Der Import-Screen ist das Erste, was
deine Freundin von der App sieht, und er läuft eine Minute lang. Wenn der sitzt,
ist der Ton gesetzt.

---

## 9. Risiken

| Risiko | Umgang |
|---|---|
| Press Start 2P + deutsche Wörter = Überlauf | Nur Zahlen und Zwei-Wort-Labels. Mit „Sammlernummer" und „Übernehmen" gegentesten. |
| Lange Kartennamen in Pixelschrift | Zwei Zeilen statt Ellipse. Mit den längsten deutschen Namen testen. |
| Krumme `devicePixelRatio` → matschige Sprites | `--px` auf ganzzahligen Faktor festnageln (§4). |
| Pixel-Deko frisst Scanner-Performance | `body.is-scanning` pausiert alles außer A2–A6. Nur Compositor-Properties. |
| Regeltext im Deckbau in Pixelschrift anstrengend | Leading 1,6, max. 60 Zeichen. Wenn es trotzdem nervt: nur der Oracle-Text bekommt eine gewöhnliche Sans — dokumentierter Notausgang, nicht Plan A. |
| Animation wuchert über die App | Vier Primitive, sonst nichts. Jede neue Animation muss sich aus ihnen zusammensetzen lassen, sonst kommt sie nicht rein. |
