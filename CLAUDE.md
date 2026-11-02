# CLAUDE.md — Konventionen für ScryGlass

Local-first MTG-Sammlungs- & Deckbau-App. Der maßgebliche Plan ist [PLAN.md](PLAN.md);
Code-Kommentare referenzieren die Abschnitte (`§ 5`, `E3`, `M4` …).

## Grundregeln

- **Kommentare & UI-Texte auf Deutsch.** Code-Bezeichner auf Englisch.
- **`domain/` ist framework-frei und rein testbar.** Keine React-/DOM-/Dexie-Importe
  dort. Logik gehört nach `domain/`, nicht in Komponenten.
- **Persistenz nur über Dexie/IndexedDB** (`db/db.ts`). Kein LocalStorage für Daten.
- **TypeScript strict.** Keine `any` ohne Not.
- **Keine generierten Kartendaten committen** (siehe `.gitignore`, PLAN.md § 12).
- **Keine Kartenbilder verteilen** — nur Scryfall-URLs zur Laufzeit, lokal gecacht.
- **Keine Monetarisierung** in irgendeiner Form (WotC Fan Content Policy).

## Tests

- Vitest, Node-Environment, `fake-indexeddb` für DB-Tests.
- Der **Matcher** (`domain/nameMatch.ts`) ist der wichtigste Testfall — echte
  OCR-Outputs als Fixtures in `domain/__tests__/fixtures/ocr-samples.json` festnageln
  (PLAN.md § 5).
- `npm test` muss grün sein, bevor gebaut/committet wird.

## Build

- App: `cd app && npm run build` (`tsc -b && vite build`).
- APK: `npm run cap:sync && cd android && ./gradlew assembleRelease` — **JDK 17**.
  Signiert wird mit dem Release-Schlüssel aus `android/keystore.properties` (nur lokal,
  nie committen). Immer derselbe Schlüssel, sonst lassen sich installierte Apps nicht
  mehr updaten. Ausgabe: `android/app/build/outputs/apk/release/app-release.apk`.
- Release: APK als `ScryGlass-X.Y.Z.apk` UND `ScryGlass-X.Y.Z.apk.sha256` (sha256sum-
  Format) hochladen — ohne Prüfsumme installiert die App das Update nicht (M15).
- Pipeline: `cd pipeline && python -m pytest`.

## Commit-Konventionen

- Kleine, thematische Commits pro Milestone/Feature. Aussagekräftige Messages.
