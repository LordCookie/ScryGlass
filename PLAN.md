# PLAN.md — MTG Sammlungs- & Deckbau-App

> Arbeitstitel: `mtg-scanner` (Repo-Name noch offen).
> Local-first, offline-fähig, nicht-kommerziell. Basiert auf dem wiederverwendbaren
> Kern von [engram](https://github.com/LordCookie/Engram) (Scanner, Sammlung, Dexie,
> Offline-Bilder, Capacitor), aber mit komplett neuer Datenschicht.

---

## 0. Scope

**In v1:**
- Vollständiger Kartenkatalog lokal (Deutsch + Englisch), Pull beim App-Start
- Scannen per Handykamera → Scan-Korb → Sammlung
- Sammlung: Bestand, Suche, Filter, Sortierung, Backup/Export
- Deckbau aus der eigenen Sammlung inkl. Formatvalidierung
- **Peer-Scanning:** mehrere Handys im selben WLAN scannen gemeinsam, ein Gerät
  sammelt ein und prüft vor der Übernahme

**Explizit NICHT:**
- Cloud, Accounts, Login, Server-Backend
- Preise / Sammlungswert
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
3. Filtern: `lang in ("en", "de")`, `set_type != "memorabilia"`, keine Tokens/Emblems
   (`layout in ("token","double_faced_token","emblem","art_series")` raus)
4. Gruppieren nach `oracle_id`
5. Vier NDJSON-Files schreiben (siehe unten)
6. `version.json` mit Zeitstempel + Zeilenzahlen + Scryfall-Bulk-Datum

### Output

```
dist/
  version.json      ~200 B    { catalogVersion, builtAt, scryfallBulkDate, counts }
  cards.ndjson      ~14 MB    Oracle-Karten (eine Zeile pro oracle_id)
  printings.ndjson   ~7 MB    Druckausgaben
  names.ndjson       ~3 MB    Namensindex DE + EN
  trigrams.ndjson    ~4 MB    Fuzzy-Fallback-Index
```

### Abgeleitete Felder (Pipeline, nicht App)

| Feld | Ableitung |
|---|---|
| `normName` | lowercase, Diakritika strippen (`ö→o`, `æ→ae`), `'`/`,`/`-` raus, Whitespace kollabieren |
| `maxCopies` | `4`, außer: Basic Land → `99`; Oracle-Text enthält „A deck can have any number of cards named" → `99` |
| `legalities` | Bitmaske über 8 Formate (siehe §3) |
| `trigrams` | 3er-Fenster über `normName`, invertierter Index `trigram → [oracleId]` |
| Bild-URL | **wird nicht gespeichert.** Zur Laufzeit aus `scryfallId` gebaut: `https://cards.scryfall.io/normal/front/{id[0]}/{id[1]}/{id}.jpg` |

### Nicht mit rein

- Preise (veralten binnen Stunden, brauchen wir nicht)
- Deutsche Regeltexte (verdoppelt den Textanteil; Namen reichen fürs Scannen,
  Oracle-Text auf Englisch reicht fürs Deckbauen). Nachrüstbar.
- `rulings`, `artist`, `flavor_text`, `frame_effects`, `related_uris`, …

### CI

`.github/workflows/catalog.yml` — wöchentlich + `workflow_dispatch`. Baut die vier
NDJSON-Files, hängt sie an ein Release `catalog-YYYYMMDD`. **Generierte Kartendaten
gehören nicht ins Repo** (gitignored, wie bei engram).

---

## 3. Datenmodell (Dexie / IndexedDB)

```ts
db.version(1).stores({
  cards:      'oracleId, normName, cmc, *colorIdentity',
  printings:  'scryfallId, oracleId, set, [set+collectorNumber]',
  names:      'normName, oracleId, lang',
  trigrams:   'trigram',
  owned:      '++id, oracleId, printingId, [oracleId+finish]',
  decks:      '++id, name, format, updatedAt',
  inbox:      'basketId, receivedAt, status',
  meta:       'key'
})
```

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
reicht und die UI massiv vereinfacht. Aber das Feld ist da und wird gefüllt, sobald
ein Scan Set + Sammlernummer sicher liest. **Keine Migration später.**

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

### Import

- NDJSON-Stream zeilenweise, `bulkPut` in Chunks à **1500 Records**
- Zwischen den Chunks `await new Promise(r => setTimeout(r, 0))` → UI bleibt bedienbar
- Fortschritt aus `counts` in `version.json`
- Import ist **abbruchsicher**: `meta.catalogVersion` wird erst nach dem letzten Chunk
  gesetzt. Abbruch mittendrin → beim nächsten Start wird neu importiert.
- Reihenfolge: `cards` → `printings` → `names` → `trigrams`

### Update

Gleicher Weg, aber `bulkPut` statt Leeren+Neuschreiben. `owned` und `decks` werden
**nie** angefasst. Alte `oracleId`s, die verschwinden, bleiben stehen (Scryfall
merged gelegentlich Oracle-IDs — das ist selten genug, um es zu ignorieren).

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

---

## 6. Scanner

Übernommen aus engram: Kamera, kontinuierlicher Autofokus, Torch, Zoom, adaptive/Otsu-
Binarisierung, 2-von-3-Frame-Konsens, Scan-Korb, Bulk-Auto-Add.

### Anpassungen

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
Validator. Der Rest ist danach fast geschenkt.

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
2. Sender scannt den QR (`jsQR` auf der bestehenden Kamera-Pipeline)
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
- [ ] `pipeline/fetch_scryfall.py`: Bulk-Index abfragen, `all_cards` per `jsonl_download_uri` ziehen
- [ ] Streaming-Parse (gzip + zeilenweise), Filter `lang in (en,de)`, Tokens raus
- [ ] Ableitungen: `normName`, `maxCopies`, `legalities`-Bitmaske, Trigramme
- [ ] Vier NDJSON-Files + `version.json` nach `dist/`
- [ ] `.github/workflows/catalog.yml`: wöchentlich, Release-Asset, Daten gitignored

### M2 — Repo & Shell
- [ ] Repo anlegen, MIT-Lizenz, README mit Disclaimer (§12)
- [ ] App-Shell aus engram, TCG-Module weglassen
- [ ] Dexie-Schema (§3), Capacitor-Projekt, erster leerer Build läuft

### M3 — Katalog-Sync
- [ ] Start-Check gegen `version.json`, Timeout 3s, stiller Offline-Fallback
- [ ] NDJSON-Streaming-Import, `bulkPut` in 1500er-Chunks, Fortschrittsanzeige
- [ ] Abbruchsicher: `meta.catalogVersion` erst am Ende
- [ ] Update-Pfad (`bulkPut`, `owned`/`decks` unangetastet)

### M4 — Matcher
- [ ] In-Memory-Namensindex beim Start aus `names` aufbauen
- [ ] Exakt → Präfix → Trigramm+Levenshtein-Fallback
- [ ] DE/EN parallel, Kollisions-Handling
- [ ] Vitest mit echten OCR-Fixtures

### M5 — Scanner & Sammlung
- [ ] Titelbalken-Crop, `--psm 7`, Whitelist, Invertierungs-Heuristik
- [ ] Layout-Sonderfälle + manueller Fallback
- [ ] Scan-Korb → Sammlung
- [ ] Sammlungsansicht: Bestand, Suche, Filter, Sortierung
- [ ] JSON-Backup + ManaBox/Moxfield-kompatibler CSV-Export

### M6 — Erste nutzbare APK
- [ ] `npm run cap:sync` + `gradlew assembleDebug` (JDK 17!)
- [ ] Auf echtem Gerät gegen echten Bulk testen
- [ ] **Ab hier kann sie scannen.**

### M7 — Deckbau
- [ ] Deck-Editor mit Bestandsanzeige aus der Sammlung
- [ ] Commander-Validierung (Singleton, Farbidentität, Legalität)
- [ ] Constructed-Formate
- [ ] Manakurve, Farbverteilung, Landanteil
- [ ] „Fehlt mir"-Liste
- [ ] Deck-Text Import/Export

### M8 — Peer-Scanning
- [ ] Kotlin-Plugin: NanoHTTPD, `/hello`, `/catalog/:file`, `/basket`, `/basket/:id/status`
- [ ] `network_security_config.xml`, KeepAwake, Port-Fallback
- [ ] QR-Pairing (Anzeige + `jsQR`-Scan)
- [ ] **Scan-Ziel im Scanner** (`local` / `peer`), Default „Meine Sammlung"
- [ ] **Korb mit `target`** — ein Korb-Modell, zwei Aktionen (übernehmen / senden)
- [ ] Empfang als Ein-/Ausschalter unter *Mehr*, kein globaler App-Modus
- [ ] Sender: Korb-Push per `CapacitorHttp`, Retry, „gesendet/bestätigt"-Status
- [ ] Receiver: `inbox`-Table, Prüfansicht nach Confidence sortiert, Übernahme nach `owned`
- [ ] Empfangen während eigenem Scannen testen (Badge statt Dialog)
- [ ] Test mit 3 Geräten und einem echten Bulk-Stapel

**Reihenfolge:** M8 kann vor M7, wenn der Bulk-Berg akut ist. Aber **nicht vor M5** —
sonst debuggt man Netzwerk und OCR gleichzeitig.

---

## 11. Risiken

| Risiko | Umgang |
|---|---|
| OCR über alte/Showcase/Borderless/Foil-Rahmen | Titelbalken-Crop hilft, aber real testen. Fixtures sammeln, Schwellen tunen. Foils sind der schlimmste Fall (Reflexionen) → Torch aus probieren. |
| Erster Import dauert gefühlt ewig | Fortschritt mit Zeilenzahlen, App bleibt bedienbar. 20 MB + Dexie-Import ≈ 30–60 s auf Mittelklasse. Einmalig. |
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
  gecacht, und **nur für Karten, die tatsächlich gescannt/besessen werden**. Nicht
  30k Bilder prefetchen.
- **Generierte Kartendaten nicht ins Repo** (gitignored, wie bei engram). Der
  Katalog entsteht in der CI und lebt im Release.
- Source-Code MIT. Disclaimer im README: unofficial fan project, nicht affiliiert
  mit Wizards of the Coast oder Scryfall.

---

## 13. Offene Fragen

- [ ] Welche Formate außer Commander?
- [ ] Foils/Editionen in der UI getrennt zählen — oder reicht Oracle-Ebene?
- [ ] Wie viele Helfer-Handys realistisch? (bei >3 lohnt Backpressure)
- [ ] Repo-Name / App-Name
