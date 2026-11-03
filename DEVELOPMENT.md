# ScryGlass — Entwicklung

Technische Übersicht für Entwickler. Was die App kann und wie man sie benutzt, steht in
der [README](README.md); der maßgebliche Plan ist [PLAN.md](PLAN.md), die Gestaltung
[DESIGN.md](DESIGN.md), Konventionen in [CLAUDE.md](CLAUDE.md).

**Technik:** Vite + React + TypeScript + Tailwind, Daten in IndexedDB (Dexie), Android-App
über Capacitor 6 mit eigenen Kotlin-Plugins (Kamera: CameraX, Texterkennung: ML Kit
offline, Bilderkennung: Perceptual Hash), Katalog aus einer Python-Pipeline in GitHub
Actions.

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
*Mehr → Katalog* direkt aus dem Release `catalog-latest` (gzip-komprimiert, ~27 MB) und
schreibt dabei nur, was sich geändert hat; der eingebaute Katalog überschreibt nie einen
jüngeren, schon geladenen. `trigrams.ndjson` braucht die App seit 0.2.7 nicht mehr (der
Namensindex baut die Trigramme selbst) — nicht nach `app/public/catalog/` legen.

---

## Versionen & Releases

- **0.x.y**: `0.1.x` = Fixes/Kleinkram, `0.2.x` = neue Funktionen, `1.0.0` = öffentlich.
  `versionCode` in `app/android/app/build.gradle` zählt einfach hoch.
- Jedes Release ist ein Tag `vX.Y.Z` mit deutschen Release-Notes (die App zeigt sie
  als „Was ist neu"). Es trägt `ScryGlass-X.Y.Z.apk` **und** `ScryGlass-X.Y.Z.apk.sha256`
  — ohne Prüfsumme installiert die App das Update nicht. **Nur das neueste Release
  trägt die APK**; ältere APK-Assets werden gelöscht. Die Releases
  `catalog-*` enthalten die CI-Katalogdaten und werden dabei nie angefasst.
