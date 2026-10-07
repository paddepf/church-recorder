# Ebbton – Hinweise für Claude

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
- Pausen zwischen Punkten: **M** auf einem laufenden Abschnitt („Abschnitt abschließen“) lässt die Aufnahme ohne aktiven
  Abschnitt weiterlaufen, bis **N** den nächsten beginnt (`startNextPending` beginnt bei fehlendem offenem Abschnitt
  einfach an der Live-Stelle). Oberfläche: „Zwischen den Punkten“, wenn noch Punkte offen sind.
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
- **Vor dem ersten Start** (`status` `idle`) beginnt ein hineingezogener Ablaufpunkt bei 0 und bleibt offen (`end == null`),
  statt als 0:00–0:00 zu enden; `Session.start` sieht den offenen Abschnitt und beginnt keinen weiteren. Vorab lässt
  sich nur ein Punkt beginnen (`startPending`, Fehlermeldung beim zweiten).
- Alte Sessions mit `markers` (Version 1) werden in `loadFromFile` zu Abschnitten
  migriert (`migrateSections`). Session-Datei ist jetzt `version: 2`.
- Der Export kennt zusätzlich immer „Gesamte Aufnahme“ (`seg_full`). Der
  Snapshot heißt `sections` (nicht mehr `markers`).
- Schnittstellen-Namen bleiben aus Kompatibilität stehen: Companion-Aktion
  `marker_add` und WebSocket-Befehle `marker.add`/`marker.next` bedeuten jetzt
  Start/Ende-Umschalter bzw. „nächster Punkt“; Antwort enthält `change`
  (`started`/`ended`). Nicht `action` überschreiben (kollidiert mit der Antwort).

### Aufnahme, Fortsetzen, Schutz
- **Beim Start beginnt der erste offene Ablaufpunkt von selbst** (`Session.start` ruft `startNextPending(0)`; ohne Punkte
  passiert nichts; gilt nicht beim Anhängen mit „Fortsetzen“ und nicht beim Fortsetzen aus der Pause).
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

### Ablaufplan und Standardpunkte
- Quellen der Abschnitte (`section.source`): `churchtools` (aus dem Ablaufplan), `plan` (Standardpunkte
  und in der Kachel selbst hinzugefügte Punkte), `manual` (mit M gesetzte Abschnitte). Alles außer `manual`
  zählt als Ablaufplan: Beim Entfernen eines gesetzten Abschnitts geht er zurück in den Plan, bei einer neuen
  Aufnahme werden die Plan-Punkte wieder offen (`manual` entfällt).
- Meldet ChurchTools für `/agenda` einen 404 (`err.status`) oder liefert keine Punkte, nutzt `ct:agenda` die
  Vorlage, deren Name zum Titel des Termins passt (`RoleLogic.templateForTitle`: alle Wörter des Vorlagennamens
  stehen als ganze Wörter im Titel, längster Name gewinnt; „Bibelstunde“ → Vorlage „Bibelstunde“), sonst die
  Standardvorlage aus `agendaTemplates`/`defaultTemplateId` (siehe „Vorlagen“ unten; Vorgabe: Einleitung,
  Kinderbeitrag, Predigt, Abschluss), und meldet `usedDefaults` und `templateName`. Der Termin wird dabei trotzdem gesetzt. `session:service` (ohne
  ChurchTools) trägt dieselbe Vorlage ein, wenn noch keine Abschnitte existieren. Ein vorhandener ChurchTools-Ablaufplan
  hat immer Vorrang.
- Ablaufplan-Kachel: Knopf „ChurchTools …“ neben der Vorlagenwahl öffnet denselben Termin-Dialog wie der Klick auf den
  Gottesdienst in der Kopfzeile (`openServicePicker`); `#plan-source` zeigt die Herkunft („Aus ChurchTools geladen“ bzw.
  „Aus Vorlage“), abgeleitet aus `source` der Nicht-`manual`-Abschnitte (kein eigenes Feld, kein Vorlagenname).
- Ablaufplan-Kachel: Punkt hinzufügen (`section:add`), entfernen (`section:delete`), umsortieren per Drag in der
  Liste (`section:reorder`, setzt `order` der offenen Punkte neu). Dieselbe Drag-Quelle (`text/marker-id`) dient
  weiter zum Ablegen auf der Wellenform, das Ziel unterscheidet.

### Interpret aus ChurchTools
- Ablaufpunkt mit zuständiger Person (`item.responsible`, tolerant geparst in `responsibleText`/`personName`;
  verknüpfte Personen vor Freitext) → `artist` des Abschnitts (`setAgenda`: `it.responsible`).
- Dienstplanung: `churchtools.eventServices(eventId, wanted)` liest `GET /api/events/{id}?include=eventServices`,
  Dienstnamen über `GET /api/services`, Personennamen aus `es.person`, `es.name` (wenn ungleich Dienstname) oder
  per `GET /api/persons/{id}`; Filter: Dienstname enthält ein Wort aus Einstellung `artistServices`
  (Standard `Leitung, Predigt, Geschichte`; Dienste aus `RoleLogic.ALIASES` werden immer mitgelesen). Ergebnis in `session.service.suggestions` (`{role,name}`), im Editor
  (`editSection`) als Chips; passender Dienst zuerst (Wortvergleich: „Gebetsleitung“ passt nicht zu „Einleitung“; „Leitung“ → „Einleitung“ gilt nur über `ALIASES`).
  **Automatisch eintragen:** `Session.setAgenda` ruft `_applySuggestions()`: für Punkte ohne `artist` kommen die
  Namen aus `service.suggestions`, deren Dienst zum Punktnamen passt (`src/shared/roles.js`, `RoleLogic`:
  ganze Wörter, reine Zahlen zählen nicht; feste Zuordnung `ALIASES`: Dienst „Geschichte“ → Punkt „Kinderbeitrag“, Dienst „Leitung“ → Punkte „Einleitung“ und „Abschluss“; "Predigt 2" → Punkt "Predigt"; mehrere Treffer mit Komma). Dieselbe
  Regel sortiert die Chips im Editor. `setAgenda` gibt die Anzahl zurück (`autoFilled` in der Antwort von
  `ct:agenda`). Reihenfolge der Quellen: Ablaufplan-Person vor Dienstplanung.
  **Die genaue Antwortform von ChurchTools wurde nicht gegen eine echte Instanz geprüft** (nur mit nachgebauten
  Antworten); bei Abweichungen die echte Antwort ansehen und `eventServices` anpassen. Fehler beim Lesen stören
  den Termin-Import nicht (Hinweis per Toast, `suggestionError`).

### Meldungen (Toasts)
- Nur melden, was Aufmerksamkeit braucht: Fehler, Warnungen (Speicher, Eingang, Schreiben, Dienstplanung) und
  Hinweise, die sonst unsichtbar wären (z. B. Vorlage statt Ablaufplan, mehrere Termine heute). Bestätigungen, die
  man schon sieht (Aufnahme läuft/beendet, gespeichert, Rückgängig, Vorlage geladen, Schnitt entfernt), gibt es nicht.
  `toast()` zeigt dieselbe Meldung nicht doppelt und höchstens drei je Ort. **Fehler und Warnungen** (`error`/`warn`)
  erscheinen groß und farbig oben in der Mitte (`#alerts`, rot bzw. gelb, mit ⚠), bleiben mindestens 30 s (Fehler) bzw.
  15 s (Warnung) stehen und lassen sich per Klick schließen; Hinweise (`info`/`success`) klein unten rechts. Neue
  Meldungen daran messen.

### Infotext des Termins als Predigttitel
- `churchtools.eventServices` liefert zusätzlich `info` (`eventInfoText`: erste Zeile aus `description`, sonst
  `information`/`note`/`notes`/`info`, ohne HTML). Gespeichert in `session.service.info`; `Session._applyInfo()` hängt ihn
  beim ersten Abschnitt mit dem Wort „Predigt“ an: „Predigt: Kolosser 2,6-7 Verwurzelt in Christus“ (`baseLabel` merkt den
  ursprünglichen Namen, damit erneutes Laden keine Doppelten erzeugt und der Text nicht zweimal angehängt wird; Regel
  `RoleLogic.takesEventInfo`). Das Etikett ist Abschnittsname, Dateiname-`{abschnitt}` und ID3-Titel.
  **Welches ChurchTools-Feld den Infotext trägt, ist nicht gegen eine echte Instanz geprüft** (mehrere Feldnamen
  werden probiert); bei Abweichungen die echte Antwort von `GET /api/events/{id}` ansehen und `eventInfoText` anpassen.

### Absicherung der Aufnahme (Review Oktober 2026)
- Die Audioerfassung lebt im Renderer. Deshalb: kein „Neu laden“ im Mac-Menü (lag auf Cmd+R), Live-Reload des
  Renderers nicht während einer Aufnahme, und bei `render-process-gone` wird neu geladen. `init()` erkennt eine
  laufende Aufnahme und verbindet den Eingang sofort wieder (`recoverCapture`). Der Wächter im Renderer greift
  auch, wenn `capture.running` falsch ist; zusätzlich meldet der Hauptprozess `health.input = 'lost'`, wenn 5 s
  lang kein `audio:chunk` kommt (`chunksStale`). `recoverCapture` versucht es auch in der Pause weiter.
- `process.on('uncaughtException')` protokolliert nur (Electrons Fehlerdialog würde den Hauptprozess blockieren).
  Netzwerk: Nachrichten, die kein JSON-Objekt sind, werden abgewiesen; `wss.on('error')` fängt Port-Fehler.
- Speichern: Während der Aufnahme Autosave (3 s bei Änderungen, sonst alle 30 s für Wellenform/Dauer), danach
  gebündelt 800 ms nach jeder Änderung (`_scheduleSave`), `flushSave()` vor Laden/Neustart/Beenden. Session-Datei
  entsteht sofort beim Start. Eine geöffnete unterbrochene Aufnahme wird als wiederhergestellt gespeichert.
  Einstellungen werden atomar geschrieben (`.tmp` + `rename`).
- `start()` legt zuerst die WAV-Datei an; scheitert das, bleibt die angezeigte Aufnahme unverändert.
- WAV: siehe „Umgesetzte Review-Vorschläge“ (eigener Schreib-Thread, RF64 ab 4 GB). MP3-Export liest blockweise (30 s,
  `wav.readFrames`), räumt bei Fehlern die halbe Datei weg.
- Fernstart (`record.start` von Companion) startet ohne Rückfrage (`remote: true`); `record.toggle` beendet auch
  eine pausierte Aufnahme. Startbefehle setzen den Status lokal sofort auf `recording`, damit ein Doppeldruck die
  laufende Erfassung nicht beendet. Gehaltene Tasten (`e.repeat`) werden ignoriert.
- Einstellungen speichern startet die Netzwerkschnittstelle nur bei geänderten Werten neu. `settings:chooseFolder`
  wählt nur aus (speichert nichts). Der Updater sucht während einer Aufnahme nicht automatisch.

### Umgesetzte Review-Vorschläge (Oktober 2026)
- **Schreiben in eigenem Thread** (`wav.js`): `WavWriter` öffnet die Datei synchron (Fehler sofort sichtbar),
  schreibt dann über einen Worker (`WORKER_SOURCE`, per `eval` gestartet, damit es aus `app.asar` heraus ohne
  entpackte Dateien läuft). Der Worker nutzt die fd des Hauptprozesses, schreibt Header etwa jede Sekunde,
  `fdatasync` alle 10 s; den fd schließt der Hauptprozess nach `closed`. `close()` liefert ein Versprechen;
  `Session.whenWritten()` / `session.writing` – Export, Fortsetzen und App-Beenden warten darauf. Ereignisse
  `error` (→ `health.write = 'error'`) und `slow` (> 32 MB Rückstau → `'slow'`).
- **RF64:** Neue Dateien haben 80 Byte Kopf mit `JUNK`-Block; ab 4 GB wird daraus `RF64`/`ds64`. `readInfo`
  liest Chunks und liefert `dataOffset` (44 bei alten Dateien, 80 bei neuen); alte Dateien werden beim Anhängen
  weiter im alten Format geschrieben (gedeckelt).
- **Cue-Marker in der WAV:** Nach dem Beenden (und bei jeder späteren Änderung der Abschnitte, über `save()`)
  schreibt `Session._syncCues` die Abschnitte per `wav.writeCues` hinter den `data`-Block: `cue `-Chunk plus
  `LIST/adtl` mit `labl` (Name, bei Interpret „Name (Interpret)“, Latin-1) und `ltxt` (Region mit Länge). Die Session-Datei
  bleibt maßgeblich. `readInfo` erkennt nachgestellte `cue `/`LIST`-Chunks und nimmt dann die Datenlänge aus dem Kopf
  statt der Dateigröße (sonst zählten sie als Audio). `WavWriter` mit `append` schneidet sie ab (`ftruncate`), beim
  erneuten Beenden kommen sie neu. RF64-Dateien (> 4 GB) bekommen keine Marker. Bei Aufnahmen, die nie beendet
  wurden (Absturz), gibt es keine.
- Beim Beenden gibt die Erfassung den angefangenen Block ab (`capture.flush()` vor `record.stop`).
- **Beenden-Rückfrage asynchron** (`confirmAndFinishRecording`, `guardClose`): blockiert den Hauptprozess nicht.
- **Fernbefehle mit echter Antwort:** `record.start/stop/toggle` warten auf `recording-started/-stopped`
  (`waitForRemote`, 8 s); die Oberfläche meldet Fehlschläge über `remote:result`.
- **Netzwerk:** Origin-Header → nur `monitor`; 5 Fehlversuche → 60 s Sperre (`auth_locked`); `monitor` bekommt
  den Zustand ohne Pfade/Namen (`_forRole`). „Im Ordner zeigen“ nur in Aufnahme-/Exportordner oder für eben
  exportierte Dateien (`revealable`). Passwortfelder verdeckt.
- **ChurchTools:** `requestAll` folgt der Paginierung; Kalender-Filter `churchToolsCalendarIds` (Auswahl in den
  Einstellungen, `ct:calendars`; Termine ohne Kalenderangabe bleiben); flache Überschriften im Ablaufplan
  werden Kategorie der folgenden Punkte.
- Die frühere, nie umgesetzte Einstellung `keepMasterWavDays` ist entfernt (wird beim Laden gelöscht) –
  automatisches Löschen von Masteraufnahmen ist bewusst nicht vorgesehen.
- Oberfläche: Aufnahmeknopf in der Pause „Aufnahme pausiert“ (gesperrt), „An Aufnahme anhängen“ statt
  „Fortsetzen“; Tooltips mit Cmd/Strg je System; Listenzeilen per Tastatur (Pfeile, Enter, F2); Fokus in
  Dialoge; Schnittfarben als CSS-Variablen (`--cut`, `--cut-text`); Wellenform reagiert auf andere
  Pixeldichte; typografische Anführungszeichen „…“ überall.
- Updater auf dem Mac ohne Zertifikat: Status `manual` mit Hinweis statt Fehler. Release-Workflow: Tag-Prüfung,
  Tests, Entwurf, beide Builds, dann Freigabe; Mac ohne Zertifikat ad hoc signiert (`-c.mac.identity=-`).
  App-Icon `app/build/icon.png` (1024 px, wird von electron-builder umgerechnet).
- **Tests:** `npm test` (`node --test`, Ordner `app/test/`, `helpers.js` ersetzt `./settings`). CI:
  `.github/workflows/test.yml` auf Windows und macOS. Neue Logik dort mit Tests absichern.

### Rückgängig, Schnitte, Vorlagen, Health
- **Rückgängig:** `Session._changed()` vergleicht `JSON({sections, cuts})` mit dem letzten Stand und legt
  Änderungen auf einen Verlauf (`_undo`/`_redo`, 60 Schritte). `{ undoable: false }` für Änderungen, die nicht
  zurückgenommen werden sollen (Start, Stop, Laden, Ablaufplan laden: dort `_resetUndo()`). Mac: Menü
  „Widerrufen“ (eigener Eintrag, sendet `menu` `undo`; in Textfeldern `document.execCommand`), sonst Strg+Z
  im `keydown` (nur `ctrlKey`, damit nichts doppelt läuft).
- **Schnitte** (`session.cuts`, `{id,start,end|null}`): Taste X (live, `toggleCut`) oder Umschalt+Ziehen
  (`addCut`); überlappende werden verschmolzen, offene beim Stop geschlossen. `mp3.exportSegment` bekommt
  `skip` (`keepRanges` zerlegt in Teilstücke, jedes wird einzeln gelesen und codiert, 6 ms Fades an den
  Nähten). `exports[...].cuts` merkt die Schnitte zum Export, damit „geändert seit Export“ sie berücksichtigt.
  Segmente tragen `cuts` und `cutSeconds`.
- **Vorlagen:** Einstellungen `agendaTemplates` (`{id,name,items[]}`) und `defaultTemplateId`. Das frühere
  `defaultAgenda` wird beim Laden zur Vorlage „Gottesdienst“ migriert. `agenda:applyTemplate` ersetzt die
  offenen Punkte (Quelle `plan`); Auswahl `#plan-template` in der Ablaufplan-Kachel, Editor in den Einstellungen
  (Arbeitskopie `state.tpl`, gespeichert über `readTemplatesForSave`).
- **Health für Netzwerk-Clients:** Hauptprozess hält `health` (`input`: ok/silent/lost, `disk`) und hängt es an
  jeden veröffentlichten Zustand (`net.publishState({...snapshot, health})`). Stille = 20 s unter 0,001 Pegel
  (`levels`-Handler); `lost` meldet die Oberfläche über `health:input` (Wächter); Speicher alle 30 s
  (`refreshDisk`). Die Oberfläche zeigt `silent` als orangen, `lost` als roten Warnbalken (`applyHealth`).
- **Fallstrick Hilfsskripte:** Beim Bearbeiten von Dateien per Skript erst das Ergebnis berechnen und prüfen,
  dann schreiben. `open(p, 'w').write(fn(s))` leert die Datei, bevor `fn` läuft; ein Fehler dort hinterlässt
  eine leere Datei (so geschehen bei `settings.js`, wiederhergestellt mit `git checkout`).

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
  bearbeitet direkt im Feld über `editSection()` (`app.js`): ein Overlay mit Name- und
  Interpret-Eingabe legt sich über Fähnchen bzw. Listenzeile (Enter speichern, Esc abbrechen,
  Fokusverlust speichert); es gibt keinen Dialog mehr. „Gesamte Aufnahme“ nimmt nur den Standard-Interpret. Das Start-Fähnchen
  der Wellenform zeigt den Interpreten hinter dem Namen (`hoverHandle` blendet „+ Interpret“
  ein); Doppelklick darauf startet den Editor im Interpret-Feld (`onRenameSection(id, 'artist', rect)`,
  `rect` = Fähnchen in Zeichenflächen-Koordinaten).
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
- **Mini-Fenster** (`setCompact` in `main.js`, IPC `window:compact`, Ereignis `compact`): dasselbe Fenster,
  nur verkleinert (Mindestgröße 400×266, Standard 480×270 unten rechts – jeweils Inhaltsgröße, Titelleiste/Rahmen kommen über `frameSize()` dazu, Lage in `compactBounds`), wahlweise
  immer im Vordergrund (`compactOnTop`). Bewusst kein zweites Fenster und kein Neuladen: Die Audioerfassung
  läuft in der Oberfläche. Die Ansicht blendet per `body.compact` alles außer Kopfzeile, Transport und den
  Knöpfen M/N aus; der laufende Abschnitt (`#current-item`, ein Button mit `#current-name`/`#current-artist`) steht groß
  mit Interpret im Mini-Fenster und öffnet per Klick `editSection` (Anker = Button; auch im großen Fenster nutzbar); die Wellenform bleibt in 1000 px Breite außerhalb des Fensters (sonst Zoom 0 bei Breite 0).
  Nach dem Beenden (`body.review`) ersetzt die Karte `#compact-export` Aufnahme- und Abschnittsknöpfe: Zusammenfassung,
  ein Export-Knopf (`exportFromCompact` → `exportSelected`, wählt angehakte, sonst ungesicherte bzw. seit dem Export geänderte; ohne Abschnitte die ganze
  Aufnahme; ist alles gesichert, entfällt der Knopf) und „Neue Aufnahme“; Ergebnis und Fortschritt spiegelt `setExportResult` in beide Ansichten.
  Der Knopf „Nächster Ablaufpunkt“ zeigt den Namen des ersten offenen Punkts (`#next-name`, nach `order` sortiert).
  Die Wellenform baut ihre Zeichenfläche bei jeder Größenänderung neu auf (`ResizeObserver`) und beim Umschalten explizit
  (`applyCompact` → `wave.resize()`): Sonst kommt das Fenster-Ereignis vor der Umstellung der Ansicht und alles wirkt gestreckt.
  Die Laufzeit des aktuellen Abschnitts (`#current-elapsed`, `updateSectionElapsed`) tickt mit den `levels`-Meldungen aus
  `state.duration - state.sectionStart` und steht in beiden Ansichten in der Karte `#current-item`; die Liste der Abschnitte zeigt je Abschnitt `.dur`
  (`fmtLength`; beim laufenden mit `data-live`, von `updateSectionElapsed` mitgezählt).
  Dialoge passen nicht hinein: `openModal`, `confirmDialog` und `?` schalten vorher auf groß zurück.
  Kürzel Strg+Umschalt+M im Renderer, auf dem Mac Cmd+Umschalt+M über das Menü „Fenster“.
- Zeitangaben (Marken, Listen, Zeitleiste der Wellenform) nutzen dieselbe
  Schrift wie der große Timer: `var(--sans)` mit `font-variant-numeric: tabular-nums`.
  Keine Monospace-Schrift verwenden (`--mono` gibt es nicht mehr).
- Wellenform-Beschriftung: Der Name am Start-Fähnchen wird mit „…“ auf den Platz bis zum Ende-Fähnchen
  gekürzt (`_fitText`, `_drawHandles`); reicht der Platz nicht, schrumpft das Ende-Fähnchen zur Lasche. Der
  Interpret erscheint nur bei genug Platz.
- Wellenform: Standardansicht 5 Minuten (`DEFAULT_VISIBLE_SECONDS`, `setDefaultZoom()` beim Start und
  bei neuer/fortgesetzter Aufnahme), beendete Aufnahmen werden eingepasst (`fitZoom`). Der Zoom wird nicht
  mehr in den Einstellungen gespeichert.
- Die drei unteren Bereiche sind bewusst groß ausgelegt (Zeilenschrift 16 px, Überschriften 17 px, Knöpfe
  ✎/× 18 px, Eingabefelder 16 px); die Exportspalte ist 400 px breit, Exportzeilen sind zweizeilig
  (Name / Zeitraum + „gesichert“). Beim Ändern der Größen im 1360×880-Fenster mit der Layout-Vorschau prüfen.
- Kopfleiste, Transport und Werkzeugleiste sind ebenfalls groß (Dienstname 21 px, Aufnahmeknopf 18 px,
  Timer 60 px, Pegel 280 px breit). Für kleine Fenster gibt es zwei Abstufungen: `max-width: 1180px` (kleinere
  Schrift/Abstände, sonst läuft die Seite über) und `max-height: 820px` bzw. `720px` (Wellenform 150/120 px
  hoch, engere Leisten, damit unten genug Platz für die Listen bleibt). Mindestfenster ist 1024×680; nach
  Änderungen bei 1360×880 **und** 1024×680 messen (kein Überlauf: `scrollWidth == innerWidth`).
- **Der große Timer darf in keinem Zustand wandern** (bereit, läuft, pausiert, beendet): `.transport-controls` hat feste
  Mindestbreite (486 px), Aufnahmeknopf 244 px, Pause/Fortsetzen 116 px; im beendeten Zustand (`body.review`) entfallen die
  ausgegrauten Knöpfe Pause/Beenden zugunsten von „An Aufnahme anhängen“. Ändern sich Beschriftungen oder Größen, mit der
  Layout-Vorschau in allen vier Zuständen bei 1360 und 1024 px die Timer-Mitte messen (`#timecode`).
  Ab 1340 px Fensterbreite sitzt er exakt in der Fenstermitte (Spalten `1fr 300px 1fr`); darunter (Knöpfe + Pegel brauchen
  mehr Platz) bleibt er zwischen beiden stabil, aber nicht mittig.
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
  sofort neu – ebenfalls **nicht während einer Aufnahme** (die Audioerfassung läuft in der Oberfläche). Nach Änderungen an `main`/`preload`/`shared` also App neu starten:
  `pkill -f "app/node_modules/[e]lectron"; cd app && npm run dev`
  (die Klammer in `[e]lectron` verhindert, dass pkill sich selbst beendet).
- Claude öffnet für den Neustart einen Terminal-Tab (`run_in_terminal`); davon sind höchstens
  6 pro Sitzung erlaubt. Vor jedem Neustart den vorherigen Tab mit `stop_terminal_tab`
  (`close: true`) schließen.
- DevTools öffnen nicht automatisch: F12 bzw. Strg/Cmd+Umschalt+I oder
  `npm run dev:tools`.
- Tests: `npm test` im Ordner `app/`. Für eigene Prüfskripte: `settings`-Modul per `Module._load` ersetzen
  (siehe `test/helpers.js`), Aufnahmen mit `stop()` beenden und auf `whenWritten()` warten.
- Tests dürfen keine Dateideskriptoren unter der Hand schließen: Die Nummer wird sofort neu vergeben (z. B.
  an den Kanal des Testrunners) und der Schreib-Thread schreibt dann dort hinein.

### Name
Die App hieß früher „ChurchRecorder“ und heißt jetzt **Ebbton** (Ton + EBBP, Verein: Evangelische Baptisten-Brüdergemeinde
Pfungstadt). Kennungen: `appId` `de.ebbp.ebbton`, Companion-Modul `ebbton` (Variablen `$(ebbton:…)`), WebSocket-`app`-Feld
`ebbton`, Repo `paddepf/ebbton`. Electron legt die Einstellungen unter `userData/<name aus package.json>` ab, also
`~/Library/Application Support/ebbton` (Windows `%APPDATA%\ebbton`); beim Umbenennen musste der alte Ordner
`church-recorder` von Hand umbenannt werden, sonst startet die App mit leeren Einstellungen. Auch der ChurchTools-Token
ging dabei verloren: Er ist mit `safeStorage` verschlüsselt, dessen Schlüssel in der Schlüsselbundverwaltung unter dem
App-Namen liegt; unter neuem Namen gibt es einen neuen Schlüssel (Meldung „Token konnte nicht entschlüsselt werden“),
der Token musste in den Einstellungen neu eingetragen werden. Bei einer weiteren Umbenennung wieder daran denken.
Der Ordnername des lokalen Klons ist egal.

### Entfernt: Mitschrift
Die lokale Transkription (whisper.cpp, Mitschrift-Panel, Einstellungen) wurde
bewusst wieder ausgebaut, weil sie keinen Mehrwert brachte. Nicht neu einbauen,
ohne vorher nachzufragen. Alte Sessions mit `transcript` im JSON werden ohne
Fehler geladen; das Feld wird ignoriert und beim Speichern nicht mehr geschrieben.
