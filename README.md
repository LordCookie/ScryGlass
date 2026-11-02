# ScryGlass

**Local-first Sammlungs- & Deckbau-App für Magic: The Gathering.** Offline-fähig,
nicht-kommerziell, ohne Cloud oder Accounts. Scanne Karten mit der Handykamera in
deine Sammlung, durchsuche den kompletten Katalog, baue Decks daraus und scanne im
selben WLAN gemeinsam mit anderen.

> Unofficial fan project. **Nicht** affiliiert mit oder unterstützt von Wizards of
> the Coast oder Scryfall. Magic: The Gathering und alle zugehörigen Marken sind
> Eigentum von Wizards of the Coast. Kartendaten stammen von
> [Scryfall](https://scryfall.com). Siehe [Rechtliches](#rechtliches).

**Stand:** v0.2.6 (Tester-Version, Android). Die APK hängt am jeweils neuesten
[GitHub-Release](https://github.com/LordCookie/ScryGlass/releases) — ab 0.2.6 holt sich
die App neue Versionen selbst (*Mehr → App-Update*).

---

## Was es kann

- **Kompletter Kartenkatalog lokal** (Deutsch + Englisch, ~34.000 Karten plus ~1.000
  Tokens/Embleme, ~160.000 Druckausgaben) — steckt in der APK, funktioniert ab dem ersten
  Start ohne Netz.
- **Scanner** mit nativer Kamera (CameraX) und Texterkennung auf dem Gerät (ML Kit,
  offline), parallel dazu **Bilderkennung** per Perceptual Hash — die Karte wird dafür
  im Bild eingerastet, auch wenn sie kleiner, versetzt oder auf einem Stapel liegt.
  Beide Signale bestätigen sich gegenseitig. Dazu: Set-Modus, **Auto-Korb** für Stapel („Karte für
  Karte hinlegen"), **Tokens** mit Artwork erkennen, Ton + Vibration, Tap-to-Focus, Licht, Querformat, Scan-Verlauf
  mit Rückgängig. Im Browser läuft ein Fallback mit Tesseract.
- **Suche** über den ganzen Katalog: Name, Typ oder Regeltext (DE/EN), mehrere Farben
  (enthält / genau / höchstens), Kartentyp, Manawert, Format, Regeltext- und
  Kreaturentyp-Filter, „nur im Bestand".
- **Sammlung**: Bild-Raster oder Liste, Filter, Sortierung (Name, Manawert, Anzahl,
  Wert), Statistik mit **Set-Fortschritt**, Artwork-Wahl je Karte, **Richtpreise**
  (Cardmarket-Euro über Scryfall) und Sammlungswert. **Tokens** getrennt von den Karten,
  je Artwork gezählt. JSON-Backup + CSV-Export (ManaBox/Moxfield-kompatibel).
- **Deckbau** aus der eigenen Sammlung: Standard, Pioneer, Modern, Legacy, Vintage,
  Commander, Pauper, Brawl. Live-Validierung, Commander mit verfügbaren Farben,
  Manakurve, Farbverteilung, **Deck-Wert** und „Fehlt mir"-Liste mit Kosten,
  Moxfield-Text-Im/Export.
- **Gemeinsam scannen** (unter *Mehr*): mehrere Handys im selben WLAN, Pairing per
  QR-Code, ein Gerät sammelt ein und prüft vor der Übernahme.
- **Updates aus der App** (unter *Mehr*): neue App-Version direkt von GitHub — vorher
  automatische Sicherung der Sammlung, Prüfsumme und Signatur werden geprüft — und neue
  Sets per Katalog-Update ohne neue APK. Höchstens einmal am Tag wird nachgesehen.
- **Pixel-Art-Design** mit vier Farbschemata (Violett, Abendrot, Schwarz-Gold,
  Halloween), Countdown zum nächsten Set.

**Explizit nicht:** Cloud, Accounts, Login, Server-Backend, Handel, Monetarisierung
jeder Art. Preise sind reine Richtwerte zur Orientierung.

---

## Architektur in fünf Sätzen

1. **Der Katalog wird vorverarbeitet** (Python-Pipeline in der CI) und als schlanke
   NDJSON-Files ausgeliefert, nicht als roher Scryfall-Bulk (~2 GB).
2. **NDJSON statt JSON-Array**, damit die App zeilenweise streamen und in Batches in
   IndexedDB (Dexie) schreiben kann.
3. **Namen und Bild-Hashes im RAM, Karten in IndexedDB** — pro Kamera-Bild gibt es
   keine DB-Zugriffe, die DB wird erst bei einem Treffer angefasst.
4. **Scanner nativ, Entscheidung in TypeScript** — das Kotlin-Plugin liefert Text-
   zeilen, Schärfe und einen Kartenausschnitt; Abgleich, Fusion und Korb sind reine,
   getestete Logik in `domain/`.
5. **Gemeinsam scannen ohne Cloud** — der Empfänger startet einen nativen
   HTTP-Server, die Helfer pairen per QR-Code und schicken ihre Körbe per HTTP POST.

Details in [PLAN.md](PLAN.md), Gestaltung in [DESIGN.md](DESIGN.md).

---

## Projektstruktur

```
pipeline/            Python-Datenpipeline
  fetch_scryfall.py    Scryfall-Bulk → Slim-Katalog (NDJSON)
  hash_images.py       pHash je Druckausgabe → hashes.ndjson (Bilderkennung)
app/                 Vite + React + TS + Tailwind + Capacitor (die App)
  src/
    domain/          Framework-freie Logik + Tests (Matcher, Scan-Fusion, Filter,
                     Deck-Validierung, Preise, IO …)
    data/            Katalog-Sync, Namens-/Such-/Hash-Index, Preise, Bild-URLs
    db/              Dexie/IndexedDB-Schema
    native/          Brücken zu nativen Funktionen (Scanner-Kamera, Feedback, Updates)
    peer/            Gemeinsam scannen: Protokoll, Client, Server-Bridge
    ui/              React-Komponenten (Scanner, Suche, Sammlung, Decks, Mehr)
  android/           Capacitor-Android-Projekt (Kotlin-Plugins ScryCamera, PeerServer, AppUpdater)
design/
  make_icons.py      Pixel-App-Icon + Startbildschirm aus einem 32×32-Sprite
.github/workflows/
  catalog.yml        Baut den Katalog wöchentlich (Mo), Release catalog-latest
  hashes.yml         Ergänzt die Bild-Hashes nach jedem Katalog-Bau (fortsetzbar)
```

---

## Entwicklung

### Pipeline (Katalog bauen)

```bash
cd pipeline
python -m pip install -r requirements.txt
python fetch_scryfall.py --out dist                                   # echter Scryfall-Bulk (~2 GB Stream)
python fetch_scryfall.py --out dist --sample tests/sample_bulk.jsonl  # aus einer lokalen Datei
python hash_images.py --printings dist/printings.ndjson --out dist/hashes.ndjson   # Bild-Hashes (fortsetzbar)
python -m pytest                                                      # Unit-Tests (kein Netz nötig)
```

Output in `pipeline/dist/`: `version.json`, `cards.ndjson`, `printings.ndjson`,
`names.ndjson`, `trigrams.ndjson`, `hashes.ndjson`.

### App

```bash
cd app
npm install
npm run dev                # http://localhost:5174 (Desktop-Preview)
LAN=1 npm run dev          # https://<LAN-IP>:5174 — fürs Handy (Kamera braucht HTTPS)
npm test                   # Vitest — muss grün sein vor Build/Commit
npm run build              # tsc + Produktions-Build nach app/dist
```

### Android-APK

```bash
cd app
npm run cap:sync                          # Build + Capacitor sync
cd android && ./gradlew assembleDebug     # JDK 17!
```

Die APK liegt danach unter `app/android/app/build/outputs/apk/debug/`. Die native
Kamera (ScryCamera) gibt es nur in der APK — im Browser nutzt der Scanner die
Web-Kamera mit Tesseract.

Releases baut `./gradlew assembleRelease` mit dem eigenen Signaturschlüssel
(`android/keystore.properties`, nur lokal, nicht im Repo). Nur APKs mit demselben
Schlüssel lassen sich über eine installierte Version updaten.

---

## Katalog

Die App lädt den Katalog von `CATALOG_BASE_URL` (`app/src/data/catalog.ts`). Default
ist `/catalog` — also der Katalog, der beim Build aus `app/public/catalog/` mit in die
APK wandert. Zum lokalen Befüllen:

```bash
cd pipeline && python fetch_scryfall.py --out ../app/public/catalog --sample tests/sample_bulk.jsonl
```

`app/public/catalog/` ist gitignored. Neuere Kataloge lädt die App unter
*Mehr → Katalog* direkt aus dem Release `catalog-latest` (gzip-komprimiert, ~45 MB);
der eingebaute Katalog überschreibt nie einen jüngeren, schon geladenen.

---

## Versionen & Releases

- **0.x.y**: `0.1.x` = Fixes/Kleinkram, `0.2.x` = neue Funktionen, `1.0.0` = öffentlich.
  `versionCode` in `app/android/app/build.gradle` zählt einfach hoch.
- Jedes Release ist ein Tag `vX.Y.Z` mit deutschen Release-Notes (die App zeigt sie
  als „Was ist neu"). Es trägt `ScryGlass-X.Y.Z.apk` **und** `ScryGlass-X.Y.Z.apk.sha256`
  — ohne Prüfsumme installiert die App das Update nicht. **Nur das neueste Release
  trägt die APK**; ältere APK-Assets werden gelöscht. Die Releases
  `catalog-*` enthalten die CI-Katalogdaten und werden dabei nie angefasst.

---

## Rechtliches

- **Scryfall:** Kartendaten aus den [Scryfall-Bulk-Data](https://scryfall.com/docs/api/bulk-data),
  Preise und Set-Termine live über die Scryfall-API. Attribution in der App,
  `User-Agent` gesetzt, Rate-Limit eingehalten.
- **WotC Fan Content Policy:** Dieses Projekt ist nicht-kommerziell. **Keine
  Monetarisierung** — keine Ads, kein In-App-Kauf, kein Spendenbutton, kein Verkauf.
- **Keine Kartenbilder redistribuiert.** Bilder werden erst beim Anzeigen direkt vom
  Scryfall-CDN geladen und nur lokal gecacht; nichts wird vorab geladen. Der
  Bild-Hash-Index enthält nur 256-Bit-Fingerabdrücke, keine Bilder.
- **Generierte Kartendaten** liegen nicht im Repo (gitignored). Der Katalog entsteht
  in der CI und lebt im Release.
- Quellcode unter [MIT-Lizenz](LICENSE).
