# ScryGlass

**Local-first Sammlungs- & Deckbau-App für Magic: The Gathering.** Offline-fähig,
nicht-kommerziell, ohne Cloud oder Accounts. Scanne Karten mit der Handykamera in
deine Sammlung, baue Decks daraus und scanne im selben WLAN gemeinsam mit anderen
(Peer-Scanning).

> Unofficial fan project. **Nicht** affiliiert mit oder unterstützt von Wizards of
> the Coast oder Scryfall. Magic: The Gathering und alle zugehörigen Marken sind
> Eigentum von Wizards of the Coast. Kartendaten stammen von
> [Scryfall](https://scryfall.com). Siehe [Rechtliches](#rechtliches).

---

## Was es kann (v1)

- **Vollständiger Kartenkatalog lokal** (Deutsch + Englisch), einmaliger Download
  beim App-Start, danach offline nutzbar.
- **Scannen** per Handykamera → Scan-Korb → Sammlung.
- **Sammlung**: Bestand, Suche, Filter, Sortierung, JSON-Backup + CSV-Export
  (ManaBox/Moxfield-kompatibel).
- **Deckbau** aus der eigenen Sammlung inkl. Formatvalidierung (Commander +
  Constructed), Manakurve, Farbverteilung, „Fehlt-mir"-Liste, Moxfield-Text-Im/Export.
- **Peer-Scanning**: mehrere Handys im selben WLAN scannen gemeinsam, ein Gerät
  sammelt ein und prüft vor der Übernahme.

**Explizit nicht:** Cloud, Accounts, Login, Server-Backend, Preise/Sammlungswert,
Monetarisierung jeder Art.

---

## Architektur in vier Sätzen

1. **Der Katalog wird vorverarbeitet** (Python-Pipeline in der CI) und als vier
   schlanke NDJSON-Files (~20 MB) ausgeliefert, nicht als roher Scryfall-Bulk (~2 GB).
2. **NDJSON statt JSON-Array**, damit die App den Download zeilenweise streamen und
   in Batches in IndexedDB schreiben kann.
3. **Namen im RAM, Karten in IndexedDB** — pro Kamera-Frame gibt es null DB-Zugriffe,
   die DB wird erst bei einem Treffer angefasst.
4. **Peer-Scanning ohne Cloud** — der Empfänger startet einen nativen HTTP-Server,
   die Sender pairen per QR-Code und pushen ihre Körbe per HTTP POST.

Details in [PLAN.md](PLAN.md).

---

## Projektstruktur

```
pipeline/          Python-Datenpipeline (Scryfall-Bulk → Slim-Katalog)
  fetch_scryfall.py
  test_fetch_scryfall.py
app/               Vite + React + TS + Tailwind + Capacitor (die App)
  src/
    domain/        Framework-freie Logik (Matcher, Deck-Validierung, IO) + Tests
    data/          Katalog-Sync, Namensindex, Bild-URLs
    db/            Dexie/IndexedDB-Schema
    ui/            React-Komponenten (Scanner, Sammlung, Deck-Editor, Peer)
    peer/          Peer-Scanning-Bridge (TS) zum nativen Kotlin-Plugin
  android/         Capacitor-Android-Projekt (inkl. PeerServer-Plugin)
.github/workflows/
  catalog.yml      Baut den Katalog wöchentlich, hängt ihn ans Release
```

---

## Entwicklung

### Pipeline (Katalog bauen)

```bash
cd pipeline
python -m pip install -r requirements.txt
python fetch_scryfall.py --out dist        # zieht den echten Scryfall-Bulk (~2 GB Stream)
python fetch_scryfall.py --out dist --sample tests/sample_bulk.jsonl   # aus einer lokalen Datei
python -m pytest                            # Unit-Tests (kein Netz nötig)
```

Output landet in `pipeline/dist/`: `version.json`, `cards.ndjson`, `printings.ndjson`,
`names.ndjson`, `trigrams.ndjson`.

### App

```bash
cd app
npm install
npm run dev                # http://localhost:5174 (Desktop-Preview)
LAN=1 npm run dev          # https://<LAN-IP>:5174 — nötig fürs Handy (Kamera braucht HTTPS)
npm test                   # Vitest (Matcher, Deck-Validierung, IO …)
npm run build              # Produktions-Build nach app/dist
```

### Android-APK

```bash
cd app
npm run cap:sync           # Build + Capacitor sync
cd android && ./gradlew assembleDebug     # JDK 17!
```

Die APK liegt danach unter `app/android/app/build/outputs/apk/debug/`.

---

## Katalog fürs lokale Testen

Die App lädt den Katalog beim Start von der in `app/src/data/catalog.ts` konfigurierten
Basis-URL (Default: das GitHub-Release `catalog-latest`). Zum lokalen Testen ohne CI:

```bash
cd pipeline && python fetch_scryfall.py --out ../app/public/catalog --sample tests/sample_bulk.jsonl
```

`app/public/catalog/` ist gitignored und wird beim Dev-Server unter `/catalog/` serviert.

---

## Rechtliches

- **Scryfall:** Kartendaten stammen aus den [Scryfall-Bulk-Data](https://scryfall.com/docs/api/bulk-data).
  Attribution im About-Screen, `User-Agent` gesetzt, Rate-Limit eingehalten.
- **WotC Fan Content Policy:** Dieses Projekt ist nicht-kommerziell. **Keine
  Monetarisierung** — keine Ads, kein In-App-Kauf, kein Spendenbutton, kein Verkauf.
- **Keine Kartenbilder redistribuiert.** Bilder werden zur Laufzeit direkt vom
  Scryfall-CDN geladen und nur lokal gecacht — und nur für Karten, die tatsächlich
  gescannt/besessen werden.
- **Generierte Kartendaten** liegen nicht im Repo (gitignored). Der Katalog entsteht
  in der CI und lebt im Release.
- Quellcode unter [MIT-Lizenz](LICENSE).
