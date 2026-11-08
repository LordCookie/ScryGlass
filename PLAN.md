# PLAN.md — ScryGlass (MTG Sammlungs- & Deckbau-App)

> **ScryGlass** — Stand **v0.3.0** (2026-11-08), Tester-Version für Android.
> Local-first, offline-fähig, nicht-kommerziell. Basiert auf dem wiederverwendbaren
> Kern von [engram](https://github.com/LordCookie/Engram) (Scanner, Sammlung, Dexie,
> Offline-Bilder, Capacitor), aber mit komplett neuer Datenschicht.
>
> Die Abschnitte 0–13 sind der ursprüngliche v1-Plan, fortgeschrieben auf den
> aktuellen Stand (Code-Kommentare verweisen auf die §-Nummern). Was nach v1 dazukam,
> steht in den Entscheidungen E5–E7, in § 6.1–6.3 und in den Meilensteinen M9–M14;
> die Release-Historie in § 14.

---

## 0. Scope

**In v1:**
- Vollständiger Kartenkatalog lokal (Deutsch + Englisch), Pull beim App-Start
- Scannen per Handykamera → Scan-Korb → Sammlung
- Sammlung: Bestand, Suche, Filter, Sortierung, Backup/Export
- Deckbau aus der eigenen Sammlung inkl. Formatvalidierung
- **Peer-Scanning:** mehrere Handys im selben WLAN scannen gemeinsam, ein Gerät
  sammelt ein und prüft vor der Übernahme

**Nach v1 dazugekommen** (Details § 6.1, § 10, § 14):
- Nativer Scanner (CameraX + ML Kit) mit Bilderkennung, Auto-Korb, Set-Modus
- Katalog-Suche als eigener Tab mit Filtern
- Richtpreise & Sammlungswert (zur Laufzeit, siehe E7)
- Pixel-Art-Design (DESIGN.md) mit Farbschemata, Countdown zum nächsten Set

**Explizit NICHT:**
- Cloud, Accounts, Login, Server-Backend
- Preise **im Katalog** oder Handel/Kauf-Links (Richtwerte zur Laufzeit sind ok, E7)
- Synergie-Engine, Solver, Playtest-Simulation (engram-Spezifika, hier unnötig)
- Monetarisierung jeder Art

---

## 1. Architekturentscheidungen

Diese vier Entscheidungen sind der Kern des Plans. Wer sie kennt, kann den Rest ableiten.

### E1 — Katalog wird vorverarbeitet, nicht roh ausgeliefert

Scryfalls Bulk-Files sind ~156 MB (Oracle) bzw. deutlich mehr (All Cards), mit ~80
Feldern pro Karte. Die App braucht davon ~12.

Die **Pipeline** (Python, läuft in einer GitHub Action) zieht den Bulk, filtert,
normalisiert und schreibt einen Slim-Katalog von **~20 MB**. Die App lädt nur den.

Normalisierung (`normName`, Trigramme, `maxCopies`) passiert **in der Pipeline**,
nicht auf dem Handy.

**Nicht komprimiert.** 20 MB sind für einen einmaligen Download völlig im Rahmen;
gzip auf Dateiebene spart hier weniger, als es an Komplexität kostet (HTTP-Transport-
Kompression greift ohnehin automatisch).

### E2 — Katalog als NDJSON, nicht als ein JSON-Array

Eine Zeile = eine Karte. Grund: die App kann den Response-Stream zeilenweise lesen
(`fetch` → `ReadableStream` → `TextDecoderStream`), Fortschritt anzeigen und in
Batches in Dexie schreiben. Ein 20-MB-`JSON.parse()` blockiert den Main-Thread und
hat einen unnötigen RAM-Peak.

### E3 — Namen im RAM, Karten in IndexedDB

Der Namensindex (~60k Einträge für DE+EN, reine Strings) ist ~2–3 MB im Speicher.
Der wird beim App-Start einmal aus Dexie geladen und bleibt liegen.

**Konsequenz: pro Kamera-Frame gibt es null IndexedDB-Zugriffe.** Die DB wird erst
angefasst, wenn ein Treffer feststeht. Das ist der Unterschied zwischen 151 Karten
(engram, In-Memory-Array) und 30k+ (hier) — ohne dass der Scanner langsamer wird.

### E4 — Peer-Scanning: Receiver ist HTTP-Server, Sender sind Clients

Keine WebRTC-Signalisierung, kein Broker, kein Cloud-Hop. Der Receiver startet einen
nativen HTTP-Server (NanoHTTPD via Capacitor-Plugin), die Sender pairen per QR-Code
und pushen ihre Körbe per HTTP POST.

Begründung: WebRTC im Android-WebView ist unangenehm (mDNS-verschleierte ICE-
Kandidaten, Signalisierung trotzdem nötig). Ein HTTP-Server ist in einer Stunde
debuggt und funktioniert garantiert ohne Internet.

### E5 — Scanner nativ, Entscheidung in TypeScript (seit v0.0.12)

Tesseract in der WebView war auf echten Handys zu langsam und zu unzuverlässig
(Tester: „erkennt oft nichts, zu langsam, unscharf"). Deshalb liefert ein eigenes
Kotlin-Plugin (`ScryCameraPlugin`: CameraX-Vorschau hinter der transparenten WebView,
ML-Kit-Texterkennung gebündelt und offline, ~4 Bilder/s, Schärfeprüfung nativ) pro
Bild nur **Textzeilen, Schärfe und einen kleinen Kartenausschnitt**. Abgleich, Fusion,
Korb und Verlauf bleiben in TypeScript (`domain/`, getestet) — dieselbe Logik wie im
Browser-Pfad. Kosten: APK +~11 MB (ML-Kit-Bibliotheken, nur ARM).

### E6 — Zwei Signale statt einem: Text + Bild (seit v0.0.1, Fusion seit v0.0.10)

OCR scheitert an Showcase/Borderless/Full-Art und stilisierter Schrift; ein Bild-Hash
scheitert an lockerem Framing. Beide zusammen sind robust: **Perceptual Hash (pHash,
256 Bit)** je Druckausgabe aus der Pipeline, die App hasht den Kamera-Ausschnitt
gleich. `domain/scanFuse.ts` fusioniert: stimmen Text und Bild überein, ist der
Treffer sofort sicher (Kreuz-Bestätigung); sonst gelten strengere Einzel-Schwellen.

### E7 — Preise zur Laufzeit, nicht im Katalog (seit v0.2.0)

Preise veralten binnen Stunden — deshalb bleiben sie aus dem Katalog (§ 2). Stattdessen
fragt die App Scryfall (`/cards/collection`, 75 je Anfrage) nur für die eigene
Sammlung bzw. die gerade angezeigte Karte ab und cacht die Werte 24 h in Dexie
(offline: letzter Stand). Anzeige als **Richtwert** (Cardmarket-Euro), keine
Kauf-Links, kein Handel.

---

## 2. Datenpipeline

`pipeline/fetch_scryfall.py` — Python stdlib + `requests`, sonst nichts.

### Ablauf

1. `GET https://api.scryfall.com/bulk-data` → Eintrag `type == "all_cards"`
2. Download über `jsonl_download_uri`
   **Achtung:** seit dem 20.07.2026 gibt es nur noch JSONL (`.jsonl.gz`). Die alten
   `download_uri`-JSON-Files sind abgeschaltet. Die Datei ist ein gzip-File auf der
   Platte, kein Transport-Encoding → `gzip.open()`, zeilenweise streamen, niemals
   komplett in den RAM.
3. Filtern: `lang in ("en", "de")`, `set_type != "memorabilia"`, keine Art-Series-Karten
   (`layout == "art_series"` raus). **Tokens und Embleme bleiben drin** (Großes
   Token-Update, M14): Karten + Druckausgaben + Bild-Hashes, aber NICHT im Namens-/
   Trigramm-Index (sonst fände der Karten-Abgleich „Soldier" statt der echten Karte;
   Token-Namen sind ohnehin nicht eindeutig). Doppelseitige Tokens bekommen die
   verbundene Oracle-ID beider Seiten (`a+b`). Die App erkennt Tokens am Layout.
4. Gruppieren nach `oracle_id`
5. Vier NDJSON-Files schreiben (siehe unten)
6. `version.json` mit Zeitstempel + Zeilenzahlen + Scryfall-Bulk-Datum

### Output

```
dist/                       geplant   real (2026-09-18)
  version.json      ~200 B              { catalogVersion, builtAt, scryfallBulkDate, counts }
  cards.ndjson      ~14 MB    15 MB     Oracle-Karten (eine Zeile pro oracle_id) — 34.139
  printings.ndjson   ~7 MB    28 MB     Druckausgaben — 155.822
  names.ndjson       ~3 MB     6 MB     Namensindex DE + EN — 64.327
  trigrams.ndjson    ~4 MB    34 MB     Fuzzy-Fallback-Index — 8.927 Trigramme
  hashes.ndjson        —      25 MB     pHash je Druckausgabe (hash_images.py, E6)
```

Real deutlich größer als geplant (v. a. Trigramm-Postings mit vollen UUID-oracleIds).
**Seit 0.2.7 lädt die App `trigrams.ndjson` nicht mehr:** der Namensindex baut die
Postings selbst aus den Namen (`NameIndex.trigramPostings`, ~0,3 s Desktop). Die Datei
bleibt im Katalog, solange 0.2.6 sie noch lädt.

### Bild-Hashes

`pipeline/hash_images.py` lädt für jede Druckausgabe das Scryfall-Bild (`small`),
rechnet einen 256-Bit-pHash (32×32 Graustufe → 2D-DCT → obere 16×16 Koeffizienten >
Median) und schreibt `hashes.ndjson` (`{id, o, h}`). Fortsetzbar (bereits gehashte IDs
werden übersprungen). Die TS-Seite (`data/imageHash.ts`) rechnet **bitgleich**
(gleiche DCT-Basis, Median, Bit-Reihenfolge). Gemessen: gleiches Bild Python↔Browser
≈ 14 Bit Abstand, verschiedene Karten ≥ ~72.

### Abgeleitete Felder (Pipeline, nicht App)

| Feld | Ableitung |
|---|---|
| `normName` | lowercase, Diakritika strippen (`ö→o`, `æ→ae`), `'`/`,`/`-` raus, Whitespace kollabieren |
| `maxCopies` | `4`, außer: Basic Land → `99`; Oracle-Text enthält „A deck can have any number of cards named" → `99` |
| `legalities` | Bitmaske über 8 Formate (siehe §3) |
| `trigrams` | 3er-Fenster über `normName`, invertierter Index `trigram → [oracleId]` |
| Bild-URL | **wird nicht gespeichert.** Zur Laufzeit aus `scryfallId` gebaut: `https://cards.scryfall.io/normal/front/{id[0]}/{id[1]}/{id}.jpg` |

### Nicht mit rein

- Preise (veralten binnen Stunden → zur Laufzeit, E7)
- Deutsche Regeltexte (verdoppelt den Textanteil; Namen reichen fürs Scannen,
  Oracle-Text auf Englisch reicht fürs Deckbauen). Nachrüstbar.
- `rulings`, `artist`, `flavor_text`, `frame_effects`, `related_uris`, …

### CI

`.github/workflows/catalog.yml` — wöchentlich (Mo 04:17 UTC) + `workflow_dispatch`.
Baut die vier NDJSON-Files, hängt sie an ein Release `catalog-YYYYMMDD` und an das
rollierende Release `catalog-latest`. `.github/workflows/hashes.yml` — monatlich:
ergänzt `hashes.ndjson` fortsetzbar und lädt es nach `catalog-latest`. **Generierte
Kartendaten gehören nicht ins Repo** (gitignored, wie bei engram).

---

## 3. Datenmodell (Dexie / IndexedDB)

```ts
db.version(1).stores({
  cards:      'oracleId, normName, cmc, *colorIdentity',
  printings:  'scryfallId, oracleId, set, [set+collectorNumber]',
  names:      '[normName+oracleId+lang], normName, oracleId, lang', // PK zusammengesetzt → Re-Import idempotent
  trigrams:   'trigram',
  owned:      '++id, oracleId, printingId, [oracleId+finish]',
  decks:      '++id, name, format, updatedAt',
  inbox:      'basketId, receivedAt, status',
  meta:       'key'
})
db.version(2).stores({ hashes: 'scryfallId, oracleId' })  // Bild-Hash-Index (E6)
db.version(3).stores({ scans:  '++id, at' })              // Scan-Protokoll (§ 5 Fixtures)
db.version(4).stores({ prices: 'key, at' })               // Preis-Cache (E7), key = printingId | oracle:<id>
```

`meta` hält außerdem Einstellungen: Farbschema (`theme`), Vibration (`scanVibrate`),
Auto-Korb, gewähltes Set im Scanner (`scanSet`), das nächste Set (Countdown).

### Records

```ts
type Card = {
  oracleId: string
  name: string            // englischer Oracle-Name (kanonisch)
  normName: string
  manaCost: string        // "{1}{U}{U}"
  cmc: number
  colors: string[]        // ["U"]
  colorIdentity: string[] // ["U"] — für Commander
  typeLine: string
  oracleText: string
  layout: string          // normal | transform | modal_dfc | split | adventure | ...
  legalities: number      // Bitmaske
  maxCopies: number       // 4 | 99
}

type Printing = {
  scryfallId: string
  oracleId: string
  set: string             // "dmu"
  collectorNumber: string // "123a" — String! nicht Number
  lang: 'en' | 'de'
  finishes: string[]      // ["nonfoil","foil","etched"]
}

type NameEntry = { normName: string; oracleId: string; lang: 'en' | 'de' }

type Owned = {
  id?: number
  oracleId: string
  printingId?: string     // optional — v1 zählt auf oracleId
  finish: 'nonfoil' | 'foil' | 'etched'
  qty: number
  addedAt: number
  source: 'scan' | 'manual' | 'peer'
  peerDevice?: string
}
```

### Legalities-Bitmaske

```
1<<0 standard   1<<1 pioneer   1<<2 modern    1<<3 legacy
1<<4 vintage    1<<5 commander 1<<6 pauper    1<<7 brawl
```

Ein Byte statt eines Objekts mit 20 Keys × 30k Karten.

### Warum `printingId` schon in v1 im Schema steht

v1 zählt auf Oracle-Ebene („sie besitzt 4× Blitzschlag"), weil das für „was habe ich"
reicht und die UI massiv vereinfacht. Aber das Feld ist da. **Stand heute:** gefüllt
wird es, wenn man im Kartendetail ein Artwork wählt (`setOwnedPrinting`) — Sammlung,
Detail und Deckbau zeigen dann dieses Artwork, und der Preis bezieht sich auf diese
Ausgabe. Den gescannten Druck automatisch zu merken war bewusst nicht gewünscht.
**Keine Migration nötig.**

---

## 4. Katalog-Sync

### Beim App-Start

```
1. meta.catalogVersion aus Dexie lesen
2. GET <release>/version.json  (Timeout 3s)
   ├─ Fehler/kein Netz → weiter mit lokalem Katalog, kein Fehlerdialog
   ├─ lokal fehlt      → Vollimport (Pflicht, mit Fortschritt)
   └─ remote neuer     → dezenter Hinweis "Update verfügbar", NICHT erzwingen
3. App startet
```

**Die App muss ohne Netz starten.** Im Kartenladen gibt es kein WLAN.

### Eingebetteter Katalog + Updates von GitHub (M15)

`CATALOG_BASE_URL` ist per Default `/catalog` — der Katalog aus `app/public/catalog/`
wandert beim Build **in die APK**. Der Erstimport läuft damit auch ohne Netz (~40 s),
die Bild-Hashes werden danach im Hintergrund importiert.

Seit das Repo öffentlich ist, lädt die App neuere Kataloge direkt aus dem Release
`catalog-latest` (wöchentlich von `catalog.yml` gebaut, Bild-Hashes direkt danach von
`hashes.yml`), gzip-komprimiert (110 → 45 MB). Release-Downloads erlauben keine
Browser-Anfragen (CORS) — in der App laufen GET-Anfragen aber über den nativen HTTP-Weg
von Capacitor (`CapacitorHttp`), der streamt. Nur **neuer** zählt (`isNewerCatalog`):
der eingebaute Katalog überschreibt nie einen jüngeren, schon geladenen.

### Import

- NDJSON-Stream zeilenweise, `bulkPut` in Chunks à **1500 Records** (`data/bulkImport.ts`)
- Zwischen den Chunks per `MessageChannel` der UI Luft geben — **nicht** per
  `setTimeout`: Timer drosselt der Browser bei ausgeblendeter Seite (Bildschirm aus)
  auf ≥ 1 s, bei Hunderten Chunks stand der Import damit fast still
- Fortschritt aus `counts` in `version.json`
- Import ist **abbruchsicher**: `meta.catalogVersion` wird erst nach dem letzten Chunk
  gesetzt. Abbruch mittendrin → beim nächsten Start wird neu importiert.
- Reihenfolge: `cards` → `printings` → `names` (Trigramme seit 0.2.7 im RAM, s. o.)
- Bildschirm bleibt an, solange importiert wird (`AppUpdater.keepScreenOn`)

### Update

Gleicher Weg, aber nur **Neues und Geändertes** wird geschrieben (Schreiben ist das
Teure, von Woche zu Woche ändert sich ein Bruchteil): Karten und Druckausgaben je Chunk
mit dem Bestand vergleichen, Namen und Bild-Hashes nur nach Schlüssel (ändern sich
nie). Gemessen (Browser, gleicher Katalog): Druckausgaben 23,3 s → 5,2 s, Bild-Hashes
15,5 s → 1,3 s, komplettes Update ~51 s → ~9 s. Parallel in mehrere Tabellen schreiben
bringt nichts (38 s statt 34 s), größere Chunks auch nicht.
`owned` und `decks` werden **nie** angefasst. Alte `oracleId`s, die verschwinden,
bleiben stehen (Scryfall merged gelegentlich Oracle-IDs — das ist selten genug, um es
zu ignorieren).

Das Update läuft als Hintergrund-Aufgabe (`data/job.ts`), nicht im Bildschirm: Tab
wechseln bricht nichts ab, ein zweiter Start schließt sich dem laufenden an, und eine
Leiste unter dem Kopf zeigt den Fortschritt in den anderen Tabs.

---

## 5. Namensabgleich

`domain/nameMatch.ts` — die Datei aus engram, aber die Suchstrategie ist neu.

### Ablauf pro OCR-Ergebnis

```
normalize(ocrText)
  → 1. Exakt-Treffer in Map<normName, oracleId[]>          O(1), trifft meistens
  → 2. Präfix-Treffer (OCR schneidet gern ab)              O(log n) über sortierte Keys
  → 3. Fuzzy-Fallback:
       Trigramme des OCR-Strings → Kandidaten aus dem Index
       → Top ~20 nach Trigramm-Overlap
       → Levenshtein (bestehende engram-Logik) auf diese 20
  → 4. Kein Treffer über Schwelle → manuelle Eingabe anbieten
```

Schritt 1+2 laufen gegen eine In-Memory-`Map`, die beim Start aus `names` gefüllt wird
(siehe E3). Schritt 3 ist der einzige, der Dexie anfasst — und nur bei Miss.

### Zweisprachigkeit

Der Index enthält DE- und EN-Namen nebeneinander, beide zeigen auf dieselbe
`oracleId`. Für den Matcher völlig transparent. Die Sprache wird beim Treffer
mitgeschrieben (`Owned.printingId` bzw. später fürs Anzeigen).

Kollisionen DE↔EN sind extrem selten, aber möglich → bei mehreren Treffern
disambiguiert Set + Sammlernummer, sonst Nachfrage.

### Tests

**Das ist der Teil, der wirklich getestet werden muss.** Vitest mit echten
OCR-Outputs als Fixtures: beim ersten realen Scannen 50–100 „Gelesen:"-Strings
sammeln (inkl. der falschen!) und als Testfälle festnageln. Bei engram war das der
größte Hebel; hier auch.

```
app/src/domain/__tests__/fixtures/ocr-samples.json
  [{ raw: "Blitzschiag", expect: "lightning bolt", lang: "de" }, ...]
```

**Quelle der Fixtures:** das Scan-Protokoll (Dexie `scans`). Jeder bestätigte Scan
speichert gelesenen Text, Bild-Treffer (Karte, Abstand, Vorsprung), Schärfe,
Text-Sicherheit, gelesene Druckinfo und die bestätigte Karte (bzw. „verworfen").
Export unter *Mehr → Scanner-Protokoll*; daraus werden Fixtures und Schwellen getunt.

---

## 6. Scanner

Übernommen aus engram: Kamera, kontinuierlicher Autofokus, Torch, Zoom, adaptive/Otsu-
Binarisierung, 2-von-3-Frame-Konsens, Scan-Korb, Bulk-Auto-Add.

Seit v0.0.12 ist das der **Browser-Pfad** (Dev-Preview/PWA). In der APK arbeitet der
native Scanner (E5, § 6.1). Die folgenden Anpassungen gelten für den Browser-Pfad.

### Anpassungen (Browser-Pfad, Tesseract)

- **Titelbalken-Crop:** MTG-Namen sitzen IMMER oben. Fester Zuschnitt auf die oberen
  ~8–12 % der erkannten Kartenfläche statt Vollbild-OCR. Deutlich schneller und
  genauer.
- **Zweiter Crop unten links** für Set-Code + Sammlernummer (moderne Rahmen ab 2015).
  Optional, nur zur Printing-Disambiguierung.
- **Tesseract-Parameter:** `--psm 7` (single line), `tessedit_char_whitelist` auf
  Buchstaben + `' , -` + deutsche Umlaute. Bringt bei einer Zeile deutlich mehr als
  der Vollbild-Default.
- **Alte Rahmen** (pre-8th Edition): weiße Schrift auf dunklem Balken → die
  Binarisierung muss invertieren können. Heuristik: mittlere Helligkeit des Crops.
- **Layout-Sonderfälle** über das `layout`-Feld:
  - `transform` / `modal_dfc` → Vorderseite scannen reicht, Rückseite ableiten
  - `split` / `adventure` → Name ist zusammengesetzt („Fire // Ice")
  - Full-Art-Länder, Secret Lair, textless → **kein lesbarer Titelbalken**.
    Sauberer Fallback auf manuelle Eingabe statt Fehltreffer.

### Confidence

Jeder Scan trägt `confidence` (Match-Score) und `ocrRaw` mit sich — bis in den
Peer-Korb hinein (siehe §8). Das ist die Grundlage für die Prüfansicht.

### 6.1 Stand v0.2.2 — nativer Scanner

**Pro Bild (Kotlin, `ScryCameraPlugin`):** Analysebild (4:3, ≤ 1920×1440, ~4/s) →
aufrecht drehen → Ausschnitt = Scan-Rahmen der Oberfläche → Schärfe (Laplace-Varianz,
`SHARP_MIN` 30; unscharf → nur Hinweis, keine Texterkennung) → ML Kit → Event `frame`
mit Textzeilen (Position relativ zur Karte), Schärfe und 146×204-JPEG des Ausschnitts.
Modus `qr` liefert stattdessen nur den Ausschnitt fürs Pairing (jsQR in JS).

**Pro Bild (TypeScript, `ScannerPanel` → `evaluate()`):**
- Namenszeile + Druckinfo („DMU • EN 123/281" → Set/Nummer, `domain/cardText.ts`)
  → Matcher (§ 5).
- Bild-Hash des Ausschnitts in drei Varianten (Basis, 5 % enger, 180° gedreht) →
  nächster Nachbar über ~156k Hashes (`nearestByHashMulti`), mit Vorsprung gegen die
  nächste **fremde** Karte (Reprints verdrängen sich nicht). Schwellen: Kandidat
  ≤ 60 / Vorsprung ≥ 12, Auto-Übernahme ≤ 56 / ≥ 18.
- Fusion (`domain/scanFuse.ts`, E6): Kreuz-Bestätigung Text = Bild → sofort sicher;
  Druckinfo zählt nur zusammen mit Name oder Bild.
- **Set-Modus:** Suche auf ein Set beschränkt (Hash-Teilmenge, lockerere Schwellen) —
  für Booster/Set-Stapel.
- **Auto-Korb** (`domain/autoBasket.ts`): eine andere Karte wird sofort übernommen;
  dieselbe Karte erneut erst, nachdem 3 Bilder in Folge unscharf/ohne Karte waren
  (= Karte gewechselt). Zeitlicher Konsens im Live-Modus.
- **Feedback** (`native/feedback.ts`): Ton (Web Audio, folgt der Android-Lautstärke)
  + Vibration (Capacitor Haptics, abschaltbar unter *Mehr*) beim Hinzufügen, leichtes
  Tippen bei Knöpfen.
- **Bedienung:** Tap-to-Focus, Licht, Pixel-Scan-Rahmen mit Zustandsfarben
  (DESIGN § 5), Querformat mit Seitenleiste (CameraX `targetRotation` folgt der
  Drehung), Verlauf mit Rückgängig (Korb oder Sammlung).

### 6.2 Nächster Schritt: Bilderkennung im nativen Pfad

**Befund (Scan-Protokoll 2026-09-23, 25 native Scans):** Endergebnis 24/25 richtig —
die Texterkennung trägt (20/21 richtig, wenn sie etwas fand). Der Bild-Hash traf nur
**10/25** (Abstände meist 74–94), mit der Browser-Kamera am 19.09. dagegen 23/23
(26–60). Dieselbe Karte hatte mal Abstand 40, mal 82 → nicht die Datenbank, sondern
der **Ausschnitt**. Der erkannte Text (gleicher Ausschnitt!) enthielt teils Reste der
vorherigen Karte oder eine Seitenüberschrift → der Ausschnitt sieht mehr als eine
Karte.

**Vermutete Ursachen:** (1) Abbildung Rahmen → Analysebild ist selbst gerechnet
(FILL_CENTER-Annahme) und stimmt nur, wenn Vorschau und Analyse denselben Bildwinkel
haben; (2) Karte füllt den Rahmen nicht passgenau (zu klein, versetzt, Stapel).

**Plan:**
1. **Messen** — Live-Vorschau des tatsächlich ausgewerteten Ausschnitts (abschaltbar);
   Protokoll um den Abstand zur *bestätigten* Karte erweitern (knapp verfehlt vs.
   völlig daneben) und optional das Ausschnitt-Bildchen (~6 KB, nur lokal bis zum
   Export). Testlauf: ~20 Karten einzeln / auf dem Stapel / vom Bildschirm.
2. **Exakte Abbildung** — CameraX `ViewPort` + `UseCaseGroup` (bzw.
   `CoordinateTransform`) statt eigener Rechnung: Vorschau und Analyse teilen
   garantiert denselben Ausschnitt.
3. **Karte einrasten** — Ausschnitt mit Luft (Rahmen + ~15 %), Kartenkanten nativ
   suchen (Kontrast des Kartenrands, Kantenprofile), exakt zuschneiden, dann hashen;
   in JS zusätzlich eine kleine Suche über leicht verschobene/skalierte Varianten
   (kleinster Abstand gewinnt, Vorsprung-Regel bleibt). Ohne neue Bibliothek.

Unverändert bleiben Hash-Datenbank (kein Neubau) und Texterkennung. Umsetzung als
M13.

**Umgesetzt in v0.2.3** (alle drei Schritte, auf Wunsch ohne Testlauf dazwischen):
- Diagnose-Schalter (*Mehr → Scanner-Protokoll*), Protokollfelder `hashDistChosen`,
  `cropMap`, `cropSnapped`, `crop` (Bildchen nur im Datei-Export).
- ScryCamera bindet Vorschau + Analyse per `UseCaseGroup` mit `PreviewView.viewPort`,
  schneidet auf `ImageProxy.cropRect` zu; Rebind bei Drehung (Licht/Zoom bleiben).
- Einrasten in JS (`domain/cardSnap.ts`, getestet): Kotlin schickt den Ausschnitt mit
  12 % Luft (256 px). Kantenprofile → Kandidaten je Seite → Rechteck im Kartenformat;
  außerhalb einer echten Kante muss es ruhig sein (innere Linien fallen raus). Varianten:
  eingerastet Ecken (Stapel) + zwei Rand-Varianten (dunkler Tisch: Innenrand), sonst
  Versatz; der Rahmen-Weg läuft als Netz mit, der größere Vorsprung gewinnt.
- Hash-Suche zweistufig (64-Bit-Vorfilter, 32-Bit-Popcount, Margin bis 48).
- Probe mit echten Scryfall-Bildern + echtem Index (12 Karten × 8 Lagen): alt 65/96
  richtig (52 auto-sicher), neu 96/96 richtig und auto-sicher, 0 falsche Auto-Treffer.
  Kosten ~60–75 ms je Bild am Desktop (vorher ~21 ms) — auf dem Handy beobachten;
  notfalls Suche in einen Web Worker. Echte Handyfotos stehen noch aus.

### 6.3 Später

- Artwork-Hash als zweiter Bild-Kanal (nur die Illustration; braucht Pipeline-Neubau).
- Perspektivische Entzerrung (Karten-Viereck → 745×1040) für schräg gehaltene Karten.
- Neuronales Bild-Embedding (z. B. DINOv2, offline) — vorher Machbarkeitsprobe mit
  30–50 echten Handyfotos gegen pHash.

---

## 7. Deckbau

Bewusst klein gehalten. Kein Synergie-Solver.

### Validierung

Scryfall liefert Legalität und Farbidentität fertig — die Validierung ist reines
Zählen:

- Deckgröße: 60 (Constructed) / 100 (Commander), Sideboard ≤ 15
- max. `maxCopies` pro `oracleId`
- alle Karten legal im gewählten Format (Bitmaske-AND)
- **Commander zusätzlich:** Singleton, Commander ist legendär,
  `colorIdentity` jeder Karte ⊆ `colorIdentity` des Commanders

### Features v1

- Deckliste aus der Sammlung bauen (Suche zeigt Bestand an)
- Live-Validierung mit konkreten Fehlermeldungen
- Manakurve, Farbverteilung, Landanteil, Typ-Verteilung
- **„Fehlt mir"-Liste**: Karten im Deck, die sie nicht besitzt, mit Fehlmenge
- Import/Export als Deck-Text (Moxfield-Format: `4 Lightning Bolt`)

### Formate

Start mit **Commander** — deckt vermutlich den Großteil ab und ist der aufwendigste
Validator. Der Rest ist danach fast geschenkt. **Stand:** alle acht Formate der
Legalitäts-Bitmaske (§ 3) sind wählbar.

### Stand v0.2.3

- **Deck-Wert** (Statistik) und Kosten der fehlenden Karten („Fehlt mir"); gewählte
  Ausgabe bzw. Standardausgabe, nicht-foil, Standardländer zählen nicht (E7).
- Commander-Bereich mit Bild und **verfügbaren Farben** = Farbidentität + immer
  Farblos (`availableColors`) — farblose Karten passen in jedes Deck.
- Deckliste als Raster oder Liste, Artwork aus der Sammlung (gewählte Ausgabe).
- Hinzufügen gibt Ton + Vibration wie im Scanner, Entfernen ein kurzes Tippen.

---

## 8. Peer-Scanning

### Rollen — eine App, eine Codebase, kein Extra-Build

Es gibt **keinen Sender-Modus und keinen Receiver-Modus als App-Zustand**. Peer ist
eine Zusatzfunktion, die man aufmacht und wieder zumacht. Jedes Gerät hat immer seine
eigene Sammlung und kann immer scannen — auch während es empfängt.

Konkret heißt das:

- **Kein Build-Flag, keine zweite APK, kein Onboarding-Screen mit Rollenwahl.**
  Das Kotlin-Plugin ist in jeder Installation drin, der Server läuft nur, wenn jemand
  ihn startet.
- **Empfangen** ist ein Schalter unter *Mehr → Gemeinsam scannen*: „Empfang starten"
  → QR erscheint, Server läuft, Eingang füllt sich. Aus = Server aus. Ohne aktive
  Session kostet die Funktion nichts.
- **Senden** ist kein Modus, sondern ein **Ziel am Scanner**.

### Das Scan-Ziel (der Punkt, der sonst schiefgeht)

Der Scanner bekommt oben eine Zielauswahl:

```
Scannen für:  [ Meine Sammlung ▾ ]     ← Default
              [ Meine Sammlung     ]
              [ → Yaras Sammlung   ]   ← aktive Peer-Verbindung
              [ + Gerät verbinden  ]
```

Warum das wichtig ist: der Helfer hat **selbst** eine Sammlung in derselben App. Wenn
„Sender" ein globaler Modus wäre, wäre nach dem Bulk-Abend unklar, wo die 300 Karten
gelandet sind. Mit dem Ziel-Selektor ist es explizit — und ein Korb mit Ziel „Peer"
fasst `owned` auf dem Sendergerät **nie** an.

Der Korb trägt das Ziel mit sich:

```ts
type Basket = {
  basketId: string
  target: { kind: 'local' } | { kind: 'peer', deviceName: string, url: string }
  entries: BasketEntry[]
  status: 'open' | 'sent' | 'acked'
}
```

`target: local` → „In Sammlung übernehmen" schreibt nach `owned`.
`target: peer` → „Senden" macht den POST. Zwei Buttons, eine Korb-Logik.

### Beide Rollen gleichzeitig

Der Receiver kann währenddessen selbst weiterscannen — der HTTP-Server läuft nativ
im Hintergrund, die Scanner-UI merkt davon nichts. Eingehende Körbe landen im
`inbox`-Badge, nicht in einem Dialog, der den laufenden Scan unterbricht.

Rollen sind auch nicht fest: wer heute empfängt, kann morgen bei jemand anderem
helfen. Es gibt keinen Zustand, der das verhindert oder der irgendwo persistiert
werden müsste.

### Pairing

1. Receiver startet Server auf Port `8765`, zeigt QR-Code:
   `mtgscan://192.168.x.y:8765?t=<6-stelliger-Token>&n=<Gerätename>`
2. Sender scannt den QR — in der APK über die native Kamera (Modus `qr`, jsQR in
   JS), im Browser über die Web-Kamera
3. Sender ruft `GET /hello` → Handshake, Protokoll- und Katalog-Version vergleichen

Token ist kein Krypto — nur damit nicht irgendein Handy im selben WLAN Müll pusht.
Wechselt pro Session, Receiver zeigt ihn an.

### Protokoll

```
GET  /hello
     → 200 { deviceName, catalogVersion, protocolVersion, cardCount }

GET  /catalog/:file            (cards|printings|names|trigrams|version)
     → 200 NDJSON-Stream
     Der Receiver serviert seinen eigenen Katalog an frisch installierte Helfer.
     → kein Internet nötig, kein dreifacher GitHub-Download.

POST /basket                   Header: X-Session-Token
     Body: { basketId, deviceId, deviceName, createdAt, entries: [...] }
     → 200 { accepted: <n>, basketId }
     → 401 falscher Token
     → 409 basketId bereits vorhanden (idempotent, kein Fehler für den Sender)

GET  /basket/:basketId/status
     → 200 { status: 'received' | 'reviewed' | 'accepted', accepted, rejected }
```

### Korb-Eintrag

```ts
type BasketEntry = {
  entryId: string          // UUID, für Dedup
  oracleId: string
  printingId?: string
  lang: 'en' | 'de'
  finish: 'nonfoil' | 'foil' | 'etched'
  qty: number
  ocrRaw: string           // was die OCR wirklich gelesen hat
  confidence: number       // 0..1
  scannedAt: number
}
```

`ocrRaw` + `confidence` sind der Punkt: der Receiver sieht in der Prüfansicht nicht
nur „Blitzschlag ×1", sondern auch, dass die OCR „Blitzschiag" gelesen hat und der
Match bei 0.72 lag. **Eingang nach Confidence aufsteigend sortieren** → das
Verdächtige steht oben, der Rest wird durchgewinkt.

### Zuverlässigkeit

- **Sender löscht nichts beim Senden.** Korb wird als `gesendet` markiert, erst nach
  ACK als `bestätigt`. WLAN-Aussetzer → Retry-Button. Nichts geht verloren.
- **Receiver dedupliziert** nach `basketId` und `entryId`. Doppeltes Senden
  verdoppelt keinen Bestand.
- **Eingang ist getrennt von der Sammlung** (Dexie-Table `inbox`). Korb ansehen →
  Einträge einzeln korrigieren/verwerfen → „Übernehmen" schreibt nach `owned`.
  Erst dann.
- **Notausgang:** Korb als JSON exportieren und per beliebigem Weg rüberschicken
  (Export-Code existiert schon). Falls der Server zickt, ist niemand blockiert.

### Native-Plugin (Kotlin)

`app/android/app/src/main/java/.../PeerServerPlugin.kt`

```kotlin
@CapacitorPlugin(name = "PeerServer")
class PeerServerPlugin : Plugin() {
    private var server: PeerHttpServer? = null

    @PluginMethod fun start(call: PluginCall) {
        val token = call.getString("token")!!
        server = PeerHttpServer(8765, token) { basketJson ->
            notifyListeners("basketReceived", JSObject().put("data", basketJson))
        }.also { it.start() }
        call.resolve(JSObject().put("url", "http://${localIp()}:8765"))
    }

    @PluginMethod fun stop(call: PluginCall) { server?.stop(); call.resolve() }
    @PluginMethod fun localIp(call: PluginCall) { /* WifiManager / NetworkInterface */ }
}

// PeerHttpServer : NanoHTTPD(port)
//   serve(session):
//     GET  /hello              → JSON
//     GET  /catalog/:file      → chunked NDJSON aus dem WebView-Storage
//     POST /basket             → Token prüfen, Body an den Callback
//     GET  /basket/:id/status  → Status aus einer In-Memory-Map
```

Grobe Größenordnung: ~150 Zeilen Kotlin plus die TS-Bridge.

### Android-Fallstricke

| Problem | Lösung |
|---|---|
| Capacitor serviert unter `https://localhost`, Request auf `http://192.168.…` = Mixed Content + CORS | **`CapacitorHttp` benutzen** — der Request geht nativ raus, umgeht beides |
| Cleartext-HTTP ist ab Android 9 default aus | `network_security_config.xml`, Cleartext nur für private IP-Bereiche |
| Bildschirm aus → Server stirbt | `@capacitor-community/keep-awake` während der Session. Billiger als ein Foreground Service. |
| Port belegt | Fallback 8765 → 8766 → 8767, Port steht im QR |

### Später (nicht v1)

- Auto-Discovery über Android `NsdManager` (`_mtgscan._tcp`) statt QR
- Mehr als 3 gleichzeitige Sender → Batching / Backpressure

---

## 9. Was aus engram übernommen wird

### Kopieren + anpassen

- App-Shell: Vite 5, React 18, TS strict, Tailwind, `vite-plugin-pwa`, Capacitor
- Struktur `app/src/{domain,data,db,ui}`
- `ui/ScannerPanel.tsx` — Kamera, Autofokus, Torch, Zoom, Binarisierung, Konsens,
  Scan-Korb
- `domain/nameMatch.ts` — Levenshtein-Kern bleibt, Suchstrategie neu (§5)
- `db/db.ts` — Dexie-Setup, neues Schema
- `domain/collectionIo.ts` — JSON-Export/Import
- `data/cardImages.ts` — Workbox-Runtime-Cache, cache-first + Timeout
- `app/android/` — Capacitor-Projekt, CAMERA-Permission, JDK 17 + `gradlew assembleDebug`
- CI-Setup, `CLAUDE.md`-Konventionen

### Nicht mitnehmen

`rules/`, `domain/solver`, `domain/synergy`, `sim/`, Deckeditor (MTG braucht einen
eigenen), Playtest, Starter-Decks, Combos, Ingest/Co-Play, FastAPI-Service.

### Kein gemeinsamer Core

Erstmal **kopieren + anpassen**. Ein extrahierter `collection-scanner-core` wäre
eine verfrühte Abstraktion — die beiden Apps driften an genau den Stellen
auseinander, die man abstrahieren würde.

---

## 10. Meilensteine

### M1 — Pipeline
- [x] `pipeline/fetch_scryfall.py`: Bulk-Index abfragen, `all_cards` per `jsonl_download_uri` ziehen
- [x] Streaming-Parse (gzip + zeilenweise), Filter `lang in (en,de)` (Tokens seit M14 drin)
- [x] Ableitungen: `normName`, `maxCopies`, `legalities`-Bitmaske, Trigramme
- [x] Vier NDJSON-Files + `version.json` nach `dist/`
- [x] `.github/workflows/catalog.yml`: wöchentlich, Release-Asset, Daten gitignored

### M2 — Repo & Shell
- [x] Repo anlegen, MIT-Lizenz, README mit Disclaimer (§12)
- [x] App-Shell aus engram, TCG-Module weglassen
- [x] Dexie-Schema (§3), Capacitor-Projekt, erster leerer Build läuft

### M3 — Katalog-Sync
- [x] Start-Check gegen `version.json`, Timeout 3s, stiller Offline-Fallback
- [x] NDJSON-Streaming-Import, `bulkPut` in 1500er-Chunks, Fortschrittsanzeige
- [x] Abbruchsicher: `meta.catalogVersion` erst am Ende
- [x] Update-Pfad (`bulkPut`, `owned`/`decks` unangetastet)

### M4 — Matcher
- [x] In-Memory-Namensindex beim Start aus `names` aufbauen
- [x] Exakt → Präfix → Trigramm+Levenshtein-Fallback
- [x] DE/EN parallel, Kollisions-Handling
- [x] Vitest mit echten OCR-Fixtures

### M5 — Scanner & Sammlung
- [x] Titelbalken-Crop, `--psm 7`, Whitelist, Invertierungs-Heuristik
- [x] Layout-Sonderfälle + manueller Fallback
- [x] Scan-Korb → Sammlung
- [x] Sammlungsansicht: Bestand, Suche, Filter, Sortierung
- [x] JSON-Backup + ManaBox/Moxfield-kompatibler CSV-Export

### M6 — Erste nutzbare APK
- [x] `npm run cap:sync` + `gradlew assembleDebug` (JDK 17!) — v0.0.1, 2026-09-18
- [x] Auf echtem Gerät gegen echten Bulk testen — Tester seit v0.0.x
- [x] **Ab hier kann sie scannen.**

### M7 — Deckbau
- [x] Deck-Editor mit Bestandsanzeige aus der Sammlung
- [x] Commander-Validierung (Singleton, Farbidentität, Legalität)
- [x] Constructed-Formate
- [x] Manakurve, Farbverteilung, Landanteil
- [x] „Fehlt mir"-Liste
- [x] Deck-Text Import/Export

### M8 — Peer-Scanning
- [x] Kotlin-Plugin: NanoHTTPD, `/hello`, `/catalog/:file`, `/basket`, `/basket/:id/status`
- [x] `network_security_config.xml`, KeepAwake, Port-Fallback
- [x] QR-Pairing (Anzeige + `jsQR`-Scan)
- [x] **Scan-Ziel im Scanner** (`local` / `peer`), Default „Meine Sammlung"
- [x] **Korb mit `target`** — ein Korb-Modell, zwei Aktionen (übernehmen / senden)
- [x] Empfang als Ein-/Ausschalter unter *Mehr*, kein globaler App-Modus
- [x] Sender: Korb-Push per `CapacitorHttp`, Retry, „gesendet/bestätigt"-Status
- [x] Receiver: `inbox`-Table, Prüfansicht nach Confidence sortiert, Übernahme nach `owned`
- [ ] Empfangen während eigenem Scannen testen (Badge statt Dialog) — _offen (Geräte-Test)_
- [ ] Test mit 3 Geräten und einem echten Bulk-Stapel — _offen (Geräte-Test)_

**Reihenfolge:** M8 kann vor M7, wenn der Bulk-Berg akut ist. Aber **nicht vor M5** —
sonst debuggt man Netzwerk und OCR gleichzeitig.

### M9 — Scanner v2: Bilderkennung (v0.0.1–0.0.11)
- [x] `pipeline/hash_images.py` (pHash, fortsetzbar) + `hashes.yml`
- [x] Hash-Index in Dexie/RAM, nächster Nachbar mit Vorsprung gegen fremde Karten
- [x] Fusion Text + Bild mit Kreuz-Bestätigung, zeitlicher Konsens, Multi-Crop + 180°
- [x] Schärfe-Gate + Tap-to-Focus, Scan-Verlauf mit Rückgängig, Scan-Protokoll

### M10 — Nativer Scanner (v0.0.12–0.0.13)
- [x] `ScryCameraPlugin` (CameraX + ML Kit, gebündelt), Overlay über der Kamera
- [x] Druckinfo lesen, Set-Modus
- [x] Auto-Korb mit Kartenwechsel-Erkennung, Ton + Vibration

### M11 — Erste Tester-Version (v0.1.0)
- [x] Vibration als Einstellung unter *Mehr*, Pixel-Icons statt Emojis

### M12 — Komfort & Design (v0.2.0–0.2.2)
- [x] Pixel-Design (DESIGN.md), Farbschemata Violett / Abendrot / Schwarz-Gold
- [x] Pixel-App-Icon + Startbildschirm, animierter Pixel-Scan-Rahmen
- [x] QR-Pairing über die native Kamera; *Gemeinsam scannen* unter *Mehr*
- [x] Richtpreise & Sammlungswert (E7), Sortierung nach Wert
- [x] Such-Tab: Katalog mit Mehrfarben-, Typ-, Manawert-, Format-, Regeltext- und
      Kreaturentyp-Filter
- [x] Commander: verfügbare Farben inkl. Farblos; Deck-Feedback
- [x] Scanner im Querformat; Pixel-Checkbox; Pixel-Icons in der Navigation

### M13 — Bilderkennung im nativen Pfad robuster (v0.2.3, § 6.2)
- [x] Schritt 1: Ausschnitt-Vorschau + erweitertes Scan-Protokoll
- [x] Schritt 2: exakte Abbildung per CameraX `ViewPort`
- [x] Schritt 3: Karte einrasten (Kanten suchen) + Varianten-Suche in JS
- [ ] Testlauf mit echten Handyfotos (Diagnose an) auswerten, Schwellen nachziehen

### M14 — Backlog
- [x] Katalog-Updates ohne neue APK (öffentliches Repo, § 4) → M15
- [x] Android-Zurück-Taste abfangen (`@capacitor/app`, v0.2.3)
- [x] Set-Fortschritt in der Statistik, Deck-Wert, Farbschema Halloween (v0.2.3)
- [x] Katalog verkleinern: Trigramme baut die App selbst (0.2.7) — der Rest ist
      kleiner als gedacht, siehe § 4
- [ ] Scanner § 6.3 (Artwork-Hash, Entzerrung, Embedding)
- [ ] Peer: Auto-Discovery (`NsdManager`), Geräte-Tests aus M8
- [ ] Sprite-Animationen aus DESIGN § 7 (Flip, Stapeln, Stempel)
- [x] Tokens erkennen statt falsch zuordnen + Gesamtzahl zählen (v0.2.4)
- [x] **Großes Token-Update:** Tokens einzeln mit Artwork (v0.2.5) — Katalog 25.10. mit 1.003 Tokens/Emblemen und 3.173 Artworks
      (alle gehasht). Bild-Index getrennt (Karten vorn, Tokens dahinter); Scanner prüft
      Spielsteine gegen den Token-Teil: Name (nicht eindeutig) + Artwork per Bild-Hash +
      Druckinfo im Token-Set (`BLB 4` → `tblb`); Name allein ist nie auto-sicher, im
      Overlay wechselt Antippen das Artwork. Bestand je Artwork (`db.addOwned` erkennt
      Tokens am Layout, db v5), Sammlung mit Umschalter Karten/Tokens, Detail wählt das
      Artwork. Ohne Artwork gezählte Tokens (meta `tokenCount`) bleiben. Suche, Deckbau,
      Set-Fortschritt und Set-Auswahl ohne Tokens. Test mit 22 echten Token-Bildern:
      Token 22/22, exakte Ausgabe 18/22 (die übrigen 4: gleiches Artwork aus anderem Set).
- [x] Abfragen über viele Schlüssel ohne Dexie-`anyOf` (`whereAnyOf`, v0.2.5): Sammlung
      7,2 s → 0,14 s, Set-Fortschritt 15,6 s → 2,2 s (400 verstreute Karten, Browser)

### M15 — Updates aus der App (nach v0.2.5, Repo öffentlich)
- [x] **Signatur:** Release-Builds (`assembleRelease`) mit dem bisherigen Debug-Schlüssel,
      jetzt außerhalb des Repos mit eigenem Passwort (`android/keystore.properties`, nur
      lokal). Gleiches Zertifikat (SHA-256 `0f0a12…d99c`) → installierte Apps updaten ohne
      Deinstallieren. Schlüssel + Passwort verloren = keine Updates mehr möglich.
- [x] **App-Update unter „Mehr":** GitHub-API → höchstes `vX.Y.Z` mit APK (NICHT
      `releases/latest` — das zeigte auf ein Katalog-Release) → automatische Sicherung →
      APK nativ in den Cache laden → Plugin `AppUpdater` prüft SHA-256 (`<apk>.sha256` im
      Release), Paket, höhere versionCode und Signatur → Android-Installer. Einmalig
      „Unbekannte Apps installieren" erlauben (`REQUEST_INSTALL_PACKAGES`).
- [x] **Automatische Sicherung** vor jedem Update in den App-Speicher (letzte drei),
      unter Backup wiederherstellen oder teilen; Wiederherstellen sichert vorher selbst.
- [x] **Katalog von GitHub** unter „Mehr → Katalog" (gzip, Mobilfunk-Hinweis), danach
      Bild-Hashes; `hashes.yml` läuft jetzt nach jedem Katalog-Bau.
- [x] **Hinweis:** höchstens einmal am Tag nachsehen, Punkt am „Mehr"-Tab; nach einem
      Update einmal „Was ist neu" mit den Patch Notes.
- [x] Katalog-Archiv-Releases mit `--latest=false` (verdrängen die App nicht mehr).
- [x] **Katalog-Update schneller und robuster** (nach 0.2.6, Tester-Feedback „bricht ab,
      wenn man aus Mehr rausgeht, sehr langsam"): Hintergrund-Aufgabe statt Bildschirm-
      Zustand, nur Neues/Geändertes schreiben, Trigramme im RAM (Download 45 → 27 MB),
      keine gedrosselten Timer, Bildschirm bleibt an. Das App-Update läuft genauso.
- [x] **Erst-Test 0.2.6 → 0.2.7 gescheitert** („Download abgebrochen"): Auf Android
      legt `Filesystem.downloadFile` den Zielordner `cache/update/` nicht an (`recursive`
      wird in @capacitor/filesystem 6.0.4 ignoriert), die App löscht ihn aber vorher —
      jeder Download lief in ENOENT. Fix: Ordner per `mkdir` anlegen; Fehlermeldung nennt
      den nativen Grund, dazu ein Link zur Release-Seite. 0.2.6/0.2.7 können sich deshalb
      nicht selbst aktualisieren — einmal von Hand auf die Version mit Fix.
- [x] Erst-Test am Handy: 0.2.8 von Hand, 0.2.9 aus der App (Play Protect warnte „könnte schädlich
      sein" — Updater bleibt trotzdem, Entscheid 2026-11-08).
- [ ] Optional: Releases von GitHub Actions bauen lassen (Schlüssel als Secret).

### M16 — Umstieg von ManaBox & Datensicherheit (v0.2.9)
- [x] **Sammlungs-CSV importieren** (`domain/collectionCsv`, `data/collectionImport`):
      Spalten über die Kopfzeile (ManaBox, Moxfield, Deckbox, eigener Export; Komma oder
      Semikolon), Auflösung Scryfall-ID → Set + Nummer → Name (EN/DE). Vorschau mit nicht
      gefundenen Zeilen; ManaBox-Decks und -Listen nur auf Wunsch. Hinzufügen oder ersetzen,
      vorher automatische Sicherung.
- [ ] Echte ManaBox-Datei als Fixture (Kopfzeile bisher nach Doku/Erfahrung).
- [x] **Sicherung außerhalb der App:** „In Dokumente sichern" → `Dokumente/ScryGlass/`,
      übersteht das Deinstallieren. Automatische Sicherungen ab Android 11 zusätzlich nach
      `Dokumente/ScryGlass/Automatisch` (ohne Nachfrage; Android ≤ 10 nur per Knopf).
- [x] Erinnerung: ab 30 Bestandszeilen und 30 Tagen ohne Sicherung außerhalb der App
      ein Punkt am „Mehr"-Tab.
- [ ] Sprache und Zustand je Exemplar (Wert), Listen (Tauschordner, Wunschliste) → später (0.3.x).

### M17 — Deck-Check
Regelbasiert und erklärbar statt eines trainierten Modells (keine freien Trainingsdaten,
eine Zahl ohne Begründung hilft niemandem). `domain/deckCheck.ts`, Reiter „Deck-Check":
- [x] Bracket-Untergrenze (offizielle Commander-Brackets, Stand Okt. 2025 — Tutoren zählen
      nicht mehr): Game Changer (≤ 3 → 3, mehr → 4), Massen-Landzerstörung → 4, mehrere
      Zusatzzüge → 4, Zwei-Karten-Kombo → mindestens 3. Jeweils mit den Karten. 1 vs. 2 und
      4 vs. 5 hängen von der Absicht ab — sagt die Oberfläche auch so.
- [x] Game Changer aus Scryfall (`game_changer` → Katalog-Feld `gameChanger`). Alte Kataloge
      haben es nicht; die App merkt das und sagt es, statt still „1–2" zu melden.
- [ ] Erster Katalog mit `gameChanger`, `roles` und `combos.ndjson` (nach dem Push der
      Pipeline, nächster CI-Lauf).
- [x] Kombos: Auswahl von 41 bekannten Zwei-Karten-Paaren — bleibt als Ersatz für alte Kataloge.
- [x] **Alle Kombos aus Commander Spellbook** (`pipeline/fetch_combos.py`): deren Datei ist zum
      lokalen Lesen veröffentlicht, Bitte: Nennung mit Link (Mehr → Über, Suche, Deck-Check).
      104.854 Kombos ohne Platzhalter, ≤ 4 Karten; kompakt (Kopf mit 7.210 Karten + 509
      Ergebnissen, Zeilen per Index) 7 MB / 1,8 MB gz. In der App EIN Datensatz in `meta`
      (Typed Arrays, `domain/combos`), geladen erst bei Bedarf (~2 s am Rechner).
- [x] **Eigene Sterne** statt Spellbooks Bracket-Tags: ★★★★ gewinnt allein, 2 Karten, ≤ 4 Mana ·
      ★★★ gewinnt allein, 2 Karten oder 3 mit ≤ 6 Mana · ★★ gewinnt mit mehr Aufwand · ★ braucht
      noch etwas. Als Pixel-Sterne (PixelIcon `star`/`starEmpty`). Bracket: ★★★★ → 4, ★★★ → 3.
- [x] Kombos sind ein Zusatz, kein Hauptmerkmal: Suche (Zeile „Karten | Kombos" unter dem
      Suchfeld; ohne Suchtext „aus deiner Sammlung" / „1 Karte fehlt"), Σ-Statistik (Kachel
      am Ende), Deck-Check (im Deck + „fehlt nur X — du besitzt sie"). Nicht im Kartendetail.
- [x] Manabasis: Länderzahl nach Frank Karsten (Ø Manawert, günstige Rampe/Kartenziehen),
      Farbquellen gegen den Anteil der Farbsymbole.
- [x] Rollen (Commander): **aus den Scryfall-Tags** (Bulk `oracle_tags`, Katalogfeld `roles`):
      Rampe ohne Rituale, Kartenvorteil ohne Looten, Removal inkl. Counterspells, Sweeper,
      Massen-Landzerstörung, Zusatzzüge, Tutoren — wie Commander Spellbook. Alte Kataloge:
      grob am Regeltext. Richtwerte 10/10/8/2.

### M18 — Big-Screen-Modus (Konzept, Ziel 0.3.15 — noch nichts gebaut)

Die App im Browser am PC/Tablet, das Handy bleibt Server und **einzige Wahrheit** für
Sammlung und Decks. Am Handy läuft alles normal weiter, auch der Scanner — was dort
gescannt wird, erscheint sofort im Browser.

**Ablauf für den Nutzer**
1. *Mehr → Big Screen*: einmal ein Passwort festlegen, dann „Einschalten".
2. Das Handy zeigt `http://192.168.178.23:8780` (+ QR für Tablets) und die verbundenen
   Browser. Solange Big Screen läuft, ist der **Wachmodus** an (siehe „Handy bleibt
   benutzbar"): Bildschirm bleibt an, nach 2 min ohne Berührung dunkles Ruhebild.
3. Im Browser die Adresse öffnen → Anmeldeseite → Passwort → Ladeanimation (beim ersten
   Mal mit dem Katalog vom Handy) → die App, nur breiter. **Lesen und Schreiben**, auch
   Decks anlegen und bauen.
4. Im Browser beendet „Verbindung trennen" die Anmeldung dieses Browsers. „Ausschalten" am
   Handy beendet Server und alle Sitzungen. Von selbst geht er aus, wenn 30 min lang kein
   Browser angemeldet ist.

**Aufbau**

```
 Browser (PC, mehrere Tabs)                Handy (eine App)
 ─────────────────────────                ─────────────────────────────────────────
 gleiche Web-App (vom Handy geladen) ──►   Kotlin: BigScreenServer (NanoHTTPD, Port 8780)
   Katalog: Kopie vom Handy (IndexedDB)      • /            → App-Dateien aus den APK-Assets
   Sammlung/Decks: Kopie (Replik)            • /catalog/*   → Katalog-Dateien des Handys
                                             • /api/*       → an JS weitergereicht (Brücke)
   liest lokal (useLiveQuery wie gehabt)     • /api/events  → WebSocket: Änderungen live
   schreibt per POST /api/write ─────────►  JS (WebView): src/bigscreen/server.ts
   ◄──── WebSocket: {seq, table, puts,       • führt dieselben db.ts-Funktionen aus
         deletes} für jede Änderung          • Dexie-Middleware meldet jede Änderung an
                                               owned/decks/Token-Zähler → alle Browser
```

Entscheidungen und Gründe:
- **Gleiche Web-App, kein zweiter Build.** Das Handy liefert die App-Dateien aus den
  APK-Assets aus, Browser und Handy haben also immer dieselbe Version. Die App erkennt den
  Modus an `/bigscreen.json` und schaltet auf „Fernbetrieb".
- **Lesen lokal, Schreiben übers Handy.** Der Browser hält eine Kopie von `owned`,
  `decks` und Token-Zähler in seiner eigenen IndexedDB. Alle Ansichten lesen weiter mit
  `useLiveQuery`, ohne Umbau. Geschrieben wird nur über die Funktionen in `db.ts`
  (`addOwned`, `addOwnedBatch`, `setOwnedPrinting`, `replaceOwned`, `saveDeck`,
  `deleteDeck`, Import, Token-Zähler). Im Fernbetrieb schicken sie einen POST ans Handy.
  Das Handy führt dieselbe Funktion aus und meldet die Änderung an alle zurück — auch an
  den Tab, der sie ausgelöst hat. Eine Schreibquelle, keine Konflikte.
- **Decks werden in kleinen Schritten geschrieben, nicht als Ganzes.** Heute speichert
  `saveDeck` das komplette Deck. Bearbeiten Handy und Browser (oder zwei Tabs) dasselbe
  Deck, würde das spätere Speichern das frühere überschreiben. Deshalb gehen
  Deck-Änderungen als einzelne Schritte ans Handy: Karte ±1, Anzahl setzen, ins
  Sideboard, Commander, Name, Format, Deck anlegen/löschen. Das Handy wendet sie auf den
  aktuellen Stand an. Die Logik steckt als `applyDeckOp(deck, op)` in `domain/` (rein,
  getestet), und das Handy nutzt sie selbst auch, es gibt also nur einen Weg. Ist das Deck
  am Handy inzwischen gelöscht, sagt der Browser „Deck wurde am Handy gelöscht".
  Die Sammlung braucht das nicht: `addOwned` und Co. sind schon heute Einzelschritte.
- **Jeder Schreibvorgang wartet auf das Handy** (im WLAN ~20–50 ms). Dauert es länger als
  0,3 s, erscheint ein kleiner Stapel-Sprite als „speichert…". Scheitert es, bleibt die
  Ansicht beim alten Stand und eine Meldung sagt warum; nichts geht still verloren.
- **Änderungen per Dexie-Middleware statt von Hand.** Am Handy fängt eine DBCore-Middleware
  jede Änderung an den drei Tabellen ab, auch aus Scanner, Backup und Import, und schickt
  sie mit fortlaufender Nummer. Verpasst ein Tab eine Nummer (Funkloch, Schlaf), holt er
  sich einen frischen Schnappschuss (`GET /api/snapshot`, ~100–700 KB).
- **Der Katalog kommt vom Handy, nicht aus dem Internet (local first).** Der Browser bekommt
  übers WLAN genau den Katalogstand des Handys und legt ihn in seine IndexedDB. Neu geladen
  wird nur, wenn das Handy einen neueren Stand hat (Version steht in `/bigscreen.json`).
  - Der Haken: Am Handy steckt der Katalog in der IndexedDB der WebView, und die kann der
    native Server nicht lesen. Ihn Zeile für Zeile über die JS-Brücke zu schieben wäre zu
    langsam (160.000 Druckausgaben).
  - Deshalb **hebt das Handy die Katalog-Dateien auf**: Beim Katalog-Update werden die
    geladenen `.ndjson.gz` erst unter `files/katalog/<version>/` gespeichert und dann von
    dort eingespielt. Der vorige Stand wird gelöscht. Gebraucht werden cards, printings,
    names und combos, zusammen ≈ 16 MB. Die Bild-Hashes braucht nur der Scanner am Handy.
  - Hat das Handy noch nie ein Katalog-Update geladen, liefert der Server den eingebauten
    Katalog aus den APK-Assets.
  - Der Server gibt die Dateien direkt aus, ohne JS-Brücke und mit Größenangabe für den
    Fortschrittsbalken. Im WLAN dauert das erste Laden etwa 10–30 s. Der Browser entpackt
    mit `DecompressionStream`; dass das auch ohne HTTPS geht, beim Bau prüfen.
  - Bricht das Laden ab, wird nur die angefangene Datei neu geladen, nicht alles.
  - **Die Wartezeit bekommt eine eigene Ladeanimation** (DESIGN.md A10): Pixel-Karten
    fliegen vom Handy auf den Bildschirm, darin echte Kartennamen aus dem laufenden
    Import, vier Phasen-Pips, ehrliche Zahlen.
- **Kotlin ↔ JS-Brücke für die API.** Die Daten liegen in der IndexedDB der WebView, die
  Kotlin nicht lesen kann. Der Server reicht `/api/*` als Ereignis an JS
  (`notifyListeners("request", {id, …})`), JS antwortet mit `respond({id, status, body})`.
  Wartet Kotlin länger als 15 s, kommt 503 „Handy antwortet nicht".
- **WebSocket statt Server-Sent Events.** Browser erlauben nur 6 HTTP-Verbindungen je
  Adresse. Mit SSE wäre bei 6 Tabs alles blockiert, WebSockets zählen da nicht mit
  (`org.nanohttpd:nanohttpd-websocket`, gleiche Bibliothek wie der Peer-Server).
- **Mehrere Tabs.** Jeder Tab hat seinen eigenen WebSocket. Änderungen werden über die
  ID eingespielt, doppeltes Einspielen schadet also nicht. Höchstens 8 Sitzungen gleichzeitig.
- **Eigener Port 8780** (Peer-Server 8765). Fest, damit Lesezeichen funktionieren; ist er
  belegt, 8781–8785. Beide Server können gleichzeitig laufen.

**Was im Browser geht — Lesen und Schreiben**
- Sammlung (Raster/Liste/Σ), Suche inkl. Kombos, Deck-Check, Exporte als Download.
- Bearbeiten: im Kartendetail Anzahl, Druck/Artwork und Foil ändern, Karten löschen.
- **Decks anlegen, bauen, umbenennen, löschen**: Karten aus Suche und Sammlung ins Deck,
  Sideboard, Commander, Format. Text-Import/-Export für Decks.
- **CSV-Import vom PC** (ManaBox/Moxfield), mit der gleichen Vorschau wie am Handy. Vor dem
  Ersetzen legt das Handy wie gewohnt eine automatische Sicherung an.
- **Unten rechts, immer sichtbar: neue Scans vom Handy** (Animation: DESIGN.md A11).
  - Jede Karte, die am Handy gescannt wird, erscheint dort einige Sekunden: Pixel-Vorschau,
    Name, Anzahl, Foil. Kommen mehrere schnell hintereinander, stapeln sie sich.
  - Darunter bleibt ein Zähler „12 neu seit Anmeldung" stehen. Antippen öffnet die Liste
    „Zuletzt gescannt" für diese Sitzung.
  - Macht man am Handy einen Scan rückgängig, wird er auch hier durchgestrichen.
  - Quelle ist das Scan-Protokoll (`scans`, ScannerPanel `addToBasket`): Jeder Treffer, der
    in den Scan-Korb geht, landet dort ohnehin, mit Karte und Weg (Bild/OCR); Rückgängig setzt
    `rejected`. Angezeigt wird also schon beim Scannen. Erst beim „In Sammlung übernehmen"
    ändert sich die Sammlung im Browser; dann wechselt der Zähler von „im Korb" zu
    „übernommen". Eigene Änderungen im Browser erscheinen hier nicht.
  - Übernommene Körbe aus „Gemeinsam scannen" erscheinen als ein Eintrag („23 Karten von
    Yaras Handy").
- **Verbindungsanzeige und „Verbindung trennen".**
  - In der Navigation zeigt ein Pixel-Punkt den Zustand: „Handy verbunden" / „Handy schläft
    — App öffnen" / „getrennt". Ist der Handy-Akku unter 15 % und hängt nicht am Kabel,
    steht das daneben.
  - Antippen öffnet ein kleines Feld: Handy-Name, Adresse, angemeldet seit, „Abmeldung nach
    1 h ohne Eingabe" und der Knopf **„Verbindung trennen"**.
  - Trennen meldet diesen Browser am Handy ab (Sitzung gelöscht, WebSocket zu). Alle Tabs
    dieses Browsers zeigen danach die Anmeldeseite, sie teilen sich das Cookie.
  - Die Kopie von Sammlung und Decks wird dabei aus diesem Browser gelöscht. Der Katalog
    bleibt (öffentliche Daten, spart das nächste Laden); ein Häkchen „Auch den Katalog
    löschen" ist für fremde PCs gedacht.
  - Unterschied zum Ablauf ohne Eingabe: Da bleibt die Kopie hinter der Anmeldeseite
    liegen, damit es nach dem Anmelden an derselben Stelle weitergeht. Trennen räumt auf.
  - Läuft beim Trennen noch ein Schreibvorgang, wird erst darauf gewartet.
  - Am Handy verschwindet der Browser aus der Liste. War es der letzte, läuft die
    30-min-Frist bis zum Auto-Aus.
- Nur am Handy (im Browser ausgeblendet): Scanner, App-/Katalog-Update, Sicherungen und
  Wiederherstellen, Gemeinsam scannen, Big-Screen-Einstellungen. Das Farbschema gilt je Browser.

**Sicherheit** (nur fürs eigene WLAN gedacht — Hinweis beim Einschalten)
- Passwort ≥ 6 Zeichen. Gespeichert wird nur ein abgeleiteter Schlüssel (PBKDF2-SHA256,
  Salt, ~200.000 Runden), nie das Passwort.
- Anmeldung mit Challenge-Response: Das Handy schickt Salt und Einmalwert, der Browser
  antwortet mit HMAC(Schlüssel, Einmalwert). Das Passwort geht nie im Klartext durchs WLAN,
  und eine mitgeschnittene Anmeldung lässt sich nicht wiederholen.
- **Falle:** Über `http://192.168…` ist `crypto.subtle` gesperrt (gibt es nur bei HTTPS oder
  localhost). PBKDF2/HMAC deshalb als kleine JS-Bibliothek (z. B. `@noble/hashes`, MIT).
  `crypto.getRandomValues` geht. Ebenfalls gesperrt: Kamera (kein Browser-Scanner),
  Service Worker (PWA-Registrierung im Fernbetrieb abschalten), `navigator.clipboard`
  (Fallback gibt es schon).
- Sitzung: zufälliges 256-Bit-Token als Cookie (`HttpOnly`, `SameSite=Strict`), nur im
  Speicher des Handys. Am Handy sichtbar, einzeln oder alle abmeldbar.
- **Wie lange eine Anmeldung ohne Eingabe gilt, stellt man selbst ein** (Big-Screen-Optionen
  am Handy): 15 min · 1 h (Standard) · 4 h · 1 Tag · 1 Woche · bis Big Screen aus.
  - Als Eingabe zählt, was der Mensch im Browser tut: Klick, Taste, Scrollen. Der Browser
    meldet das höchstens einmal pro Minute. Die WebSocket-Verbindung im Hintergrund zählt
    nicht — ein vergessener offener Tab läuft also trotzdem ab.
  - Läuft eine Anmeldung ab, legt sich die Anmeldeseite über die App, und die Daten sind
    nicht mehr zu sehen. Nach dem Anmelden geht es an derselben Stelle weiter.
  - Eine geänderte Einstellung gilt sofort für alle Sitzungen.
- Bremse gegen Raten: nach 5 Fehlversuchen 1 min Sperre, danach doppelt so lang.
- Bleibt ehrlich: Ohne HTTPS kann jemand im selben WLAN das Sitzungs-Cookie mitlesen. Ein
  selbst signiertes Zertifikat würde jeden Browser warnen lassen, deshalb kein HTTPS in v1.

**Handy bleibt benutzbar**
- Der Server läuft nativ in eigenen Threads. Die Kamera ist eine Ansicht hinter der
  WebView in derselben Activity (ScryCameraPlugin), die JS-Brücke antwortet also auch
  während des Scannens.
- Big Screen läuft, solange die App im Vordergrund ist. Dafür gibt es den **Wachmodus**,
  der mit Big Screen an- und ausgeht:
  - Der Bildschirm bleibt an (KeepAwake, wie bei „Gemeinsam scannen"). Dazu ein WLAN-Lock
    mit niedriger Latenz, damit Android das WLAN nicht in den Stromsparmodus schickt.
  - Nach 2 min ohne Berührung (und nicht im Scanner) kommt ein **Ruhebild**: schwarz, nur
    „Big Screen läuft · 2 Browser · 192.168.178.23:8780" in Pixel-Schrift. Die Helligkeit
    wird nur für das App-Fenster auf das Minimum gesetzt, die Systemeinstellung bleibt
    unberührt. Das Bild rückt jede Minute ein paar Pixel weiter, damit sich auf
    OLED-Bildschirmen nichts einbrennt.
  - Eine Berührung holt die normale Helligkeit und die vorige Ansicht zurück. Scannen geht
    jederzeit; neue Scans erscheinen sofort im Browser.
  - Ohne Ladekabel zeigt das Handy „Ladekabel empfohlen". Unter 15 % Akku sieht man das
    auch im Browser.
- Sperrt man das Handy trotzdem (Power-Taste) oder wechselt die App, drosselt Android die
  WebView, und Anfragen laufen ins 503. Der Browser zeigt dann „Handy schläft — App
  öffnen" und verbindet sich von selbst neu, sobald die App wieder vorn ist. Ein
  Hintergrund-Dienst (Foreground Service) bleibt eine spätere Option, falls das stört.

**Bekannte Haken**
- Ändert sich die IP des Handys (DHCP), ist es für den Browser eine neue Adresse mit leerer
  IndexedDB, und der Katalog wird neu vom Handy geladen (im WLAN schnell). Gegenmittel
  später: `scryglass.local` per mDNS (Android NSD); Windows und macOS lösen `.local` meist auf.
- Kartenbilder und Preise kommen im Browser wie am Handy von Scryfall. Ohne Internet am
  PC fehlen also Bilder und Preise; alles andere geht. Später möglich: Das Handy reicht
  Bilder aus seinem eigenen Cache durch.
- Am Handy kostet das Aufheben der Katalog-Dateien ≈ 16 MB Speicher.

**Umsetzung in Schritten** (jeder Schritt einzeln testbar)
- [ ] 1. Server + Auslieferung: BigScreenServer (Assets, SPA-Fallback, `/bigscreen.json`),
      Schalter unter Mehr, IP/QR, Auto-Aus ohne Anmeldung. Katalog-Dateien beim
      Katalog-Update am Handy aufheben und unter `/catalog/*` ausliefern. Wachmodus mit
      Ruhebild, WLAN-Lock, Akku-Hinweis.
- [ ] 2. Anmeldung: Passwort festlegen, Challenge-Response, Sitzungen, Sperre, einstellbare
      Dauer ohne Eingabe, „Verbindung trennen" — Logik in `domain/` mit Tests.
- [ ] 3. Lesen: Katalog vom Handy in den Browser mit Ladeanimation (A10), Schnappschuss +
      WebSocket-Änderungen, Fernbetrieb-Flag (Scanner/Updates ausblenden),
      Verbindungsanzeige, neue Scans unten rechts.
- [ ] 4. Schreiben: Schreib-Gateway in `db.ts` (lokal oder POST), Deck-Schritte
      (`applyDeckOp` in `domain/` mit Tests, Handy nutzt sie auch), Fehler sichtbar
      machen, CSV-Import vom PC.
- [ ] 5. Breites Layout: Navigation links, Kartenraster mit mehr Spalten, Deck-Editor
      zweispaltig (Liste | Statistik/Check), Kartendetail als Seitenleiste.
- [ ] 6. Test am Gerät: zwei Browser + drei Tabs, gleichzeitig am Handy scannen, dasselbe
      Deck am Handy und im Browser bearbeiten, IP-Wechsel, Ruhebild, App in den
      Hintergrund und zurück, Trennen mit offenen Tabs.

**Entschieden (2026-11-08)**
- Katalog kommt vom Handy übers WLAN, nicht von GitHub; die Wartezeit bekommt eine
  eigene Ladeanimation.
- Lesen **und** Schreiben schon in 0.3.15, inklusive Decks anlegen und bauen.
- Die App muss am Handy offen bleiben; dafür Wachmodus mit Ruhebild. Im Browser gibt es
  „Verbindung trennen".

**Offen (Entscheidung User)**
- Breites Layout gleich mit in 0.3.15 oder als eigener Schritt danach?

---

## 11. Risiken

| Risiko | Umgang |
|---|---|
| OCR über alte/Showcase/Borderless/Foil-Rahmen | Entschärft durch ML Kit (E5) + Bild-Hash (E6). Rest: Fixtures aus dem Scan-Protokoll, Schwellen tunen. Foils → Licht aus probieren. |
| Bild-Hash im nativen Pfad empfindlich gegen den Ausschnitt | Befund & Plan in § 6.2 (M13). Bis dahin trägt die Texterkennung. |
| Erster Import dauert gefühlt ewig | Fortschritt mit Zeilenzahlen, App bleibt bedienbar. Real ~108 MB roh (§ 2), Import ≈ 40 s. Einmalig, Katalog steckt in der APK. |
| Katalog-Update nur per neuer APK | Solange das Repo privat ist (§ 4). Neue APK je Set bzw. M14. |
| Doppelseitige Karten / Split / Adventure | `layout`-Feld ist die Wahrheit. Früh mit echten Karten testen. |
| DE/EN-Namenskollisionen | Selten, aber existent. Bei Mehrdeutigkeit nachfragen statt raten. |
| Scryfall ändert das Bulk-Format wieder | Ist 2026 schon passiert (JSON → JSONL). Pipeline-Code so klein halten, dass ein Umbau ein Abend ist. |
| Peer-Server im Gäste-WLAN (Client-Isolation) | Häufiger als gedacht. Hotspot vom Receiver aufmachen als dokumentierter Workaround. |

---

## 12. Rechtliches

- **Scryfall-ToS:** Attribution im About-Screen, Rate-Limit ~50–100 ms/Request.
  Bulk-Data ist der ausdrücklich gewünschte Weg. `User-Agent` setzen.
- **WotC Fan Content Policy:** deckt nicht-kommerzielle Fan-Tools. **Keine
  Monetarisierung** — keine Ads, kein IAP, kein Spendenbutton, kein Store-Verkauf.
- **Keine Kartenbilder redistribuieren.** Nur Scryfall-URLs zur Laufzeit, lokal
  gecacht, und **nur für Karten, die tatsächlich angezeigt werden** (Sammlung, Suche,
  Deck, Detail). Nicht 30k Bilder prefetchen. Der Hash-Index enthält nur
  256-Bit-Fingerabdrücke, keine Bilder.
- **Preise & Set-Termine** live über die Scryfall-API (Rate-Limit, `User-Agent`),
  als Richtwerte ohne Kauf-Links (E7).
- **Generierte Kartendaten nicht ins Repo** (gitignored, wie bei engram). Der
  Katalog entsteht in der CI und lebt im Release.
- Source-Code MIT. Disclaimer im README: unofficial fan project, nicht affiliiert
  mit Wizards of the Coast oder Scryfall.

---

## 13. Offene Fragen

- [x] Welche Formate außer Commander? — alle acht der Bitmaske (§ 7)
- [x] Foils/Editionen getrennt zählen? — Bestand auf Oracle-Ebene je Ausführung
      (normal/foil/etched); Ausgabe optional über die Artwork-Wahl (§ 3)
- [ ] Wie viele Helfer-Handys realistisch? (bei >3 lohnt Backpressure)
- [x] Repo-Name / App-Name — **ScryGlass**

---

## 14. Release-Historie

Tags `vX.Y.Z`, Release-Notes auf Deutsch, nur das neueste Release trägt die APK
(Releases `catalog-*` sind CI-Daten und bleiben unangetastet). Schema: `0.1.x`
Fixes/Kleinkram, `0.2.x` neue Funktionen, `1.0.0` öffentlich; `versionCode` zählt hoch.

| Version | Datum | Inhalt |
|---|---|---|
| 0.0.1–0.0.2 | 2026-09-18/19 | Erste APK mit eingebettetem Katalog, Bild-Abgleich per pHash |
| 0.0.3 | 2026-09-19 | Fix leerer Kartenname, Scan-Protokoll (Fixtures) |
| 0.0.4–0.0.6 | 2026-09-19 | Commander prominent (Bild + Farben), Deck-Raster, Export/Teilen, Artwork im Detail durchblättern |
| 0.0.7–0.0.8 | 2026-09-19 | Scanner-Feintuning aus echten Scans, gewähltes Artwork in Sammlung und Deckbau |
| 0.0.9 | 2026-09-19 | Countdown „Next Set in N days" |
| 0.0.10 | 2026-09-19 | Scanner Tier 1: Fusion mit Kreuz-Bestätigung, Konsens, Multi-Crop + 180° |
| 0.0.11 | 2026-09-23 | Schärfe-Gate + Tap-to-Focus, Trefferbilder, Verlauf mit Rückgängig, Sammlungsfilter + Statistik, DFC-Rückseite |
| 0.0.12 | 2026-09-23 | Nativer Scanner (CameraX + ML Kit), Druckinfo, Set-Modus |
| 0.0.13 | 2026-09-23 | Auto-Korb mit Kartenwechsel-Erkennung, Ton + Vibration |
| 0.1.0 | 2026-09-23 | Erste Tester-Version: Vibration unter *Mehr*, Pixel-Icons |
| 0.2.0 | 2026-09-23 | Such-Tab, Preise & Sammlungswert, Farbschemata, Pixel-Scan-Rahmen, Pixel-App-Icon, QR über native Kamera, Peer unter *Mehr*, Commander inkl. Farblos, Deck-Feedback |
| 0.2.1 | 2026-09-23 | Scanner im Querformat, Suche mit Mehrfarben-/Regeltext-/Typfilter, Pixel-Checkbox |
| 0.2.2 | 2026-09-23 | Pixel-Icons in der Navigationsleiste |
| 0.2.3 | 2026-10-19 | Katalog 19.10. (Reality Fracture), Karte einrasten + Scanner-Diagnose + ViewPort, Zurück-Taste, Set-Fortschritt, Deck-Wert, Farbschema Halloween |
| 0.2.4 | 2026-10-25 | Tokens erkennen statt falsche Karte zuordnen, Token-Zähler (Statistik, Sammlung, Backup) |
| 0.2.5 | 2026-10-26 | Großes Token-Update: Tokens je Artwork (Katalog 25.10. inkl. Tokens, Scanner, Sammlung Karten/Tokens), schnellere Sammlung und Set-Fortschritt |
| 0.2.6 | 2026-11-02 | Updates aus der App (App-Version mit Prüfsumme + Signaturprüfung, Katalog von GitHub), automatische Sicherungen, „Was ist neu", Release-Signatur mit eigenem Passwort |
| 0.2.7 | 2026-11-02 | Katalog- und App-Update im Hintergrund (Tab-Wechsel bricht nichts ab), Katalog-Update ~5× schneller und 27 statt 45 MB, Bildschirm bleibt beim Laden an; erstes Update aus der App heraus |
| 0.2.8 | 2026-11-03 | Fix: App-Update aus der App lud nie (Zielordner fehlte); Fehlermeldung nennt den Grund, Link zur Release-Seite. 0.2.6/0.2.7 einmal von Hand aktualisieren |
| 0.2.9 | 2026-11-08 | Umstieg von ManaBox: Sammlungs-CSV importieren (ManaBox, Moxfield & Co.), Sicherung in Dokumente/ScryGlass (übersteht Deinstallieren), Erinnerung ans Sichern, Manakurve und deutsche Typen in der Deck-Statistik |
| 0.3.0 | 2026-11-08 | Deck-Check (Bracket-Schätzung, Manabasis, Rollen aus Scryfall-Tags), alle Kombos von Commander Spellbook mit eigenen Pixel-Sternen (Suche, Σ-Statistik, Deck-Check), App-Update nimmt die geladene APK beim zweiten Versuch |
