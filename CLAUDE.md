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
- Bei jedem Commit die Dokumentation mitpflegen: `CLAUDE.md` (Abschnitt
  „Entwurfsentscheidungen“, wenn sich Verhalten oder Entscheidungen ändern),
  `app/README.md` (Bedienung, Dateiübersicht), bei Schnittstellenänderungen auch
  `app/docs/websocket-api.md` und `companion-module/README.md`. Die Doku-Änderung
  gehört in denselben Commit wie die Code-Änderung.
- Muss die App nach einer Änderung neu gestartet werden (Hauptprozess, Preload,
  `src/shared`), führt Claude den Neustart selbst im Terminal aus (Befehl siehe
  „Entwicklung“) und meldet es. **Nie**, wenn gerade eine Aufnahme läuft oder
  pausiert ist: vorher prüfen (jüngste `.session.json` im Aufnahmeordner hat
  `status` `recording`/`paused` bzw. die WAV wächst) und dann nachfragen.
- Plattformneutral bleiben: Pfade mit `path`, keine festen Laufwerks- oder
  `/Users`-Pfade, Plattformunterschiede nur über `process.platform`.
- Während einer Aufnahme darf nie etwas die Audioaufnahme blockieren oder
  die App neu starten (siehe Updater).
- Auch der Windows-PC arbeitet direkt auf `main` (aktuell nur Testphase). Sobald
  die Software produktiv genutzt wird, auf Branches umstellen, weil der
  Kirchen-PC dann zugleich Produktivrechner ist.
- Vor dem Arbeiten `git pull`, damit beide Rechner synchron bleiben.

## Entwurfsentscheidungen (nicht aus dem Code ablesbar)

Stand der Funktionen und das Warum dahinter. Beim Weiterarbeiten beachten.

### Abschnitte statt Einzelmarker
- Ein Abschnitt hat Anfang **und** Ende (`sections` in `session.js`, je
  `start`/`end`; `start == null` = offener Ablaufpunkt, `end == null` = läuft
  gerade). Es läuft höchstens einer. Jeder Abschnitt hat eine feste `color`
  (Index, wird beim Anlegen vergeben; Farbtöne in `waveform.js`).
- **M** (`section.toggle`) beginnt bzw. beendet einen Abschnitt, **N**
  beendet den laufenden und beginnt den nächsten Ablaufpunkt. Marken werden
  sofort gesetzt, benannt wird danach (✎, Doppelklick, F2).
- **Abschnitte überlappen nie.** Die Regel steht in `src/shared/sections.js`
  und wird vom Hauptprozess *und* der Wellenform genutzt (UMD-Datei, damit
  beide dasselbe Ergebnis beim Ziehen bekommen): Stößt eine Marke an einen
  Nachbarn, wandert dessen angrenzende Marke mit, kürzer als 0,1 s wird keiner.
- Drag & Drop eines Ablaufpunkts (`placePending`): in einer Lücke füllt er
  sie genau, hinter dem letzten beginnt er an der Ablagestelle, mitten in einem
  Abschnitt kürzt er diesen. Ein Klick auf den Punkt im Ablaufplan (nur während der Aufnahme) und N (`startPending`) setzen dagegen
  immer an der Live-Stelle.
- Alte Sessions mit `markers` (Version 1) werden in `loadFromFile` zu Abschnitten
  migriert (`migrateSections`). Session-Datei ist jetzt `version: 2`.
- Der Export kennt zusätzlich immer „Gesamte Aufnahme“ (`seg_full`). Der
  Snapshot heißt `sections` (nicht mehr `markers`).
- Schnittstellen-Namen bleiben aus Kompatibilität stehen: Companion-Aktion
  `marker_add` und WebSocket-Befehle `marker.add`/`marker.next` bedeuten jetzt
  Start/Ende-Umschalter bzw. „nächster Punkt“; Antwort enthält `change`
  (`started`/`ended`). Nicht `action` überschreiben (kollidiert mit der Antwort).

### Aufnahme, Fortsetzen, Schutz
- „Neue Aufnahme starten“ fragt nach, wenn eine beendete Aufnahme angezeigt wird,
  und setzt deren Abschnitte zurück (Ablaufpunkte werden wieder offen). Dateinamen
  werden nie überschrieben (`_freeBasePath` hängt `_2`, `_3` an).
- „Fortsetzen“ nach dem Beenden hängt an dieselbe WAV an
  (`WavWriter` mit `append`) und braucht dieselbe Abtastrate.
- Pause: Der Eingang läuft weiter, die Oberfläche verwirft die Blöcke (sonst
  wächst die Wellenform weiter) und gleicht danach die Peaks mit dem Hauptprozess ab.
- **Schlafsperre** (`powerSaveBlocker`) während Aufnahme/Pause. **Wächter** im
  Renderer: kommen 2,5 s keine Audioblöcke, wird der Eingang neu geöffnet und in
  dieselbe Datei weitergeschrieben (roter Balken, Lücke wird gemeldet). Anlass: Der
  Mac schlief ein, der Eingang blieb nach dem Aufwachen stumm, die Aufnahme stand
  still, die App zeigte weiter „läuft“.

### MP3-Export
- Einstellung `exportDir` (Oberordner). Gesetzt: Export ohne Dialog nach
  `<exportDir>/<Datum>_<Gottesdienstname aus ChurchTools>/`, vorhandene Dateien
  werden nie überschrieben (` (2)`). Leer: Zielordner wird beim Export abgefragt,
  die Dateien liegen dann direkt darin. Ordnername nutzt `slug()` und
  `session.service` (Datum lokal, Name aus ChurchTools).
- Dateiname: Muster `fileNamePattern`, Standard `{interpret}_{abschnitt}_{gottesdienst}_{datum}`
  (`buildFileName` in `main.js`). Ein leerer `{interpret}` hinterlässt keine doppelten
  Trennzeichen. Das alte Standardmuster `{datum}_{gottesdienst}_{abschnitt}` wird beim Laden der
  Einstellungen auf das neue umgestellt, selbst geänderte Muster bleiben unberührt.
- ID3-Tags (`id3.js`, eigener ID3v2.3-Schreiber, UTF-16): Titel = Abschnittsname, Album =
  `session.service.date`, Jahr, Interpret = `section.artist` bzw. Einstellung
  `defaultArtist`. `artist` ist ein Feld des Abschnitts (auch bei offenen Ablaufpunkten),
  bearbeitet über den Dialog `modal-section` (Name + Interpret; ersetzt den alten
  Prompt-Dialog). „Gesamte Aufnahme“ nimmt nur den Standard-Interpret. Das Start-Fähnchen
  der Wellenform zeigt den Interpreten hinter dem Namen (`hoverHandle` blendet „+ Interpret“
  ein); Doppelklick darauf fokussiert das Interpret-Feld (`onRenameSection(id, 'artist')`).
- Der Export-Bereich ist eine Auswahlliste mit Häkchen (kein Dropdown): alle echten,
  beendeten Abschnitte plus „Gesamte Aufnahme“; ein Knopf „Ausgewählte als MP3
  speichern“ (`export:batch`, nacheinander, ein Fehler stoppt die übrigen nicht,
  `failed` in der Antwort). Vorausgewählt sind Abschnitte, die noch nicht gesichert
  wurden. Fortschritt über `export-progress` mit `index`/`total`.
- Gesicherte Abschnitte werden in der Session gemerkt (`exports`, Schlüssel =
  Segment-ID, mit Datei und Zeitraum). Weichen Anfang/Ende später ab, zeigt die
  Liste „geändert seit Export“. `exports` wird bei einer neuen Aufnahme geleert.

### Mithören
- Klick in die Wellenform setzt während der Aufnahme einen Hörcursor, Leertaste =
  Play/Pause (`monitor.js`). Gelesen wird blockweise aus der wachsenden WAV
  (`audio:read`, `Session.readAudio`), die Aufnahme bleibt unberührt. Marker
  werden weiterhin an der Live-Position gesetzt, nicht am Cursor.
- Ausgabegerät ist in den Einstellungen wählbar (`outputDeviceId`, `setSinkId`);
  über Lautsprecher landet das Mithören sonst im Mikrofon.

### ChurchTools
- Beim Start wird heute geprüft: ein Termin wird geladen, bei mehreren der
  laufende bzw. nächste (Ende oder +2 h). Der Termin-Dialog zeigt die letzten und
  kommenden 5 Termine. ChurchTools liefert **UTC**; Zeit und Datum werden in
  Ortszeit umgerechnet (`withLocalTime`).

### Oberfläche
- Zeitangaben (Marken, Listen, Zeitleiste der Wellenform) nutzen dieselbe
  Schrift wie der große Timer: `var(--sans)` mit `font-variant-numeric: tabular-nums`.
  Keine Monospace-Schrift verwenden (`--mono` gibt es nicht mehr).
- Wellenform-Beschriftung: Der Name am Start-Fähnchen wird mit „…“ auf den Platz bis zum Ende-Fähnchen
  gekürzt (`_fitText`, `_drawHandles`); reicht der Platz nicht, schrumpft das Ende-Fähnchen zur Lasche. Der
  Interpret erscheint nur bei genug Platz.
- Wellenform: Standardansicht 5 Minuten (`DEFAULT_VISIBLE_SECONDS`, `setDefaultZoom()` beim Start und
  bei neuer/fortgesetzter Aufnahme), beendete Aufnahmen werden eingepasst (`fitZoom`). Der Zoom wird nicht
  mehr in den Einstellungen gespeichert.
- Layout unter der Wellenform: drei Bereiche (Ablaufplan | Abschnitte | Export), ganz
  unten die Tastenleiste (`.keybar`). Die Kürzelliste steht zentral in `shortcutList()`
  (`app.js`) und speist Leiste und Dialog (`?`): neue Kürzel dort eintragen.
  Speicherplatz zeigt `#disk-badge` in der Kopfleiste (`disk:free`, `fs.statfsSync`;
  Stunden aus der Abtastrate, 16 Bit Stereo); orange < 3 h, rot < 30 min.
- Layout-Vorschau ohne Electron: statischer Server auf `app/src` und eine Seite mit
  Mock-`window.api` (CSP verbietet Inline-Skripte, Mock als eigene Datei laden). Die
  Bildschirmfotos funktionieren im frisch geöffneten Tab ohne `resize_window`; mit gesetzter
  Fenstergröße waren sie unzuverlässig skaliert (dann Größen über `getBoundingClientRect()`
  messen). Für die Wellenform allein genügt eine Testseite mit `waveform.js` und Beispieldaten.
  Vorschau-Dateien (`_*.html/js`, `.claude/launch.json`) danach wieder löschen.

### Entwicklung
- `npm run dev` startet neu bei Änderungen im Hauptprozess, **außer während einer
  Aufnahme** (dann nur ein Hinweis). Änderungen am Renderer laden die Oberfläche
  sofort neu. Nach Änderungen an `main`/`preload`/`shared` also App neu starten:
  `pkill -f "church-recorder/app/node_modules/[e]lectron"; cd app && npm run dev`
  (die Klammer in `[e]lectron` verhindert, dass pkill sich selbst beendet).
- Claude öffnet für den Neustart einen Terminal-Tab (`run_in_terminal`); davon sind höchstens
  6 pro Sitzung erlaubt. Vor jedem Neustart den vorherigen Tab mit `stop_terminal_tab`
  (`close: true`) schließen.
- DevTools öffnen nicht automatisch: F12 bzw. Strg/Cmd+Umschalt+I oder
  `npm run dev:tools`.
- Skripte zum Testen der Session-Logik ohne Electron: `settings`-Modul per
  `Module._load` ersetzen und am Ende `process.exit(0)` aufrufen (Autosave-Timer).

### Entfernt: Mitschrift
Die lokale Transkription (whisper.cpp, Mitschrift-Panel, Einstellungen) wurde
bewusst wieder ausgebaut, weil sie keinen Mehrwert brachte. Nicht neu einbauen,
ohne vorher nachzufragen. Alte Sessions mit `transcript` im JSON werden ohne
Fehler geladen; das Feld wird ignoriert und beim Speichern nicht mehr geschrieben.
