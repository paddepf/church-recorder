# ChurchRecorder – Hinweise für Claude

Aufnahmesoftware für Gottesdienste (Electron). Entwickelt wird abwechselnd auf
einem MacBook und auf dem Windows-PC in der Kirche. Der Code muss auf beiden
Systemen laufen.

## Aufbau
- `app/` – Electron-App (Hauptprozess `src/main`, Oberfläche `src/renderer`)
- `companion-module/` – Bitfocus-Companion-Modul
- `.github/workflows/release.yml` – baut bei Tag `v*` Windows- und Mac-Release

Befehle (im Ordner `app/`): `npm install`, `npm run dev` (Live-Reload),
`npm start`. Architektur und Einrichtung stehen in `app/README.md`.

## Regeln
- Sprache: Oberfläche, Kommentare, Commit-Messages und Doku auf Deutsch.
- Nach jedem angeforderten Commit direkt pushen.
- Plattformneutral bleiben: Pfade mit `path`, keine festen Laufwerks- oder
  `/Users`-Pfade, Plattformunterschiede nur über `process.platform`.
- whisper.cpp-Binary und Modell sind pro Rechner verschieden und stehen nur in
  den lokalen Einstellungen, nie im Repo.
- Während einer Aufnahme darf nie etwas die Audioaufnahme blockieren oder
  die App neu starten (siehe Updater).
- Auch der Windows-PC arbeitet direkt auf `main` (aktuell nur Testphase). Sobald
  die Software produktiv genutzt wird, auf Branches umstellen, weil der
  Kirchen-PC dann zugleich Produktivrechner ist.
- Vor dem Arbeiten `git pull`, damit beide Rechner synchron bleiben.
