# ChurchRecorder

Aufnahmeprogramm für Gottesdienste. Nimmt eine Stereospur des Audioeingangs auf,
gliedert sie über verschiebbare Marker in die Programmpunkte des Ablaufplans und
speichert einen ausgewählten Abschnitt – zum Beispiel die Predigt – als MP3.

- Durchgehende, verlustfreie WAV-Masteraufnahme; Marker sind nur Metadaten
- Ablaufplan aus ChurchTools, Punkte per Drag-and-Drop auf die Wellenform
- Lokale Mitschrift zum Auffinden der richtigen Stelle, ohne Internet
- Netzwerkschnittstelle für ein eigenes Monitoring-Dashboard
- Fernsteuerung über Bitfocus Companion

## Installation für die Entwicklung

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
npm start
```

Fertige Installationsdateien bauen:

```bash
npm run dist        # Windows: NSIS-Installer (.exe) in release/
npm run dist:mac    # macOS: DMG und ZIP in release/
```

### Entwicklung abwechselnd auf Mac und Windows

Das Repository ist auf beiden Systemen gleich einzurichten:

1. [Git for Windows](https://git-scm.com/download/win) und Node.js 20 (LTS)
   installieren, ein Editor wie VS Code oder die Claude-Desktop-App ist optional.
2. Klonen und starten (im Ordner `app/`):
   ```bash
   git clone https://github.com/paddepf/church-recorder.git
   cd church-recorder/app
   npm install
   npm run dev
   ```
3. Arbeitsablauf: vor dem Arbeiten `git pull`, danach committen und pushen.
   Änderungen am Aufnahmerechner besser auf einem Branch machen und nicht kurz
   vor dem Gottesdienst auf `main`.

Pro Rechner einmalig und nicht im Repository: die Pfade zu whisper.cpp und zum
Modell (Einstellungen → Transkription) sowie ChurchTools-Token und
Netzwerkpasswort. Unter Windows kann es bei nativen Modulen nötig sein, die
Visual Studio Build Tools zu installieren; aktuell hat die App keine.

Gebaut wird jeweils auf dem Zielsystem – ein Mac-Build lässt sich nicht unter
Windows erzeugen. Der mitgelieferte Workflow erledigt beides auf GitHub.

## Einrichtung beim ersten Start

1. **Einstellungen → Audio:** Eingang und Abtastrate wählen. Die Auswahl wird
   gespeichert und beim nächsten Start wiederverwendet.
2. **Einstellungen → Ablage:** Ordner für die Aufnahmen festlegen. Rechne mit
   etwa 700 MB pro Stunde für die WAV-Masteraufnahme.
3. **Einstellungen → ChurchTools:** Adresse und Personal Access Token eintragen,
   dann „Verbindung prüfen". Der Token wird über die Schlüsselverwaltung des
   Betriebssystems verschlüsselt abgelegt.
4. **Einstellungen → Netzwerk:** Ein Passwort für die Steuerung vergeben, sonst
   startet die Schnittstelle nicht. Optional ein zweites Passwort nur zum
   Mitlesen für das Dashboard.
5. **Einstellungen → Transkription:** Pfade zu whisper.cpp und Modell angeben
   (siehe unten). Ohne diese Angaben läuft die Aufnahme normal weiter, nur ohne
   Mitschrift.

## Ablauf eines Gottesdienstes

1. Oben auf den Namen klicken und den Gottesdienst wählen. Ist für heute genau
   ein Termin eingetragen, wird er beim Start automatisch geladen. Die
   Programmpunkte erscheinen links als offene Punkte.
2. **Aufnahme starten.** Die Wellenform wächst mit, die Pegelanzeige zeigt den
   Eingang, der obere Fensterrand leuchtet rot.
3. Beginnt ein Programmpunkt, auf „Nächster Ablaufpunkt" drücken (Taste **N**)
   oder in der Liste auf „jetzt". Für ungeplantes „Marker setzen" (Taste **M**).
4. Marker sitzen selten sofort richtig. Sie lassen sich jederzeit – auch während
   der Aufnahme – am Fähnchen auf der Wellenform verschieben. Die Mitschrift
   darunter hilft beim Finden der genauen Stelle.
5. **Beenden.** Danach unten rechts den Abschnitt wählen und als MP3 speichern.
   Vorausgewählt ist der längste Abschnitt, weil das meist die Predigt ist.

Die WAV-Masteraufnahme bleibt erhalten. Über „Aufnahmen" kann eine frühere
Session erneut geöffnet, die Marker nachjustiert und ein weiterer Abschnitt
exportiert werden.

### Tastaturkürzel

| Taste | Wirkung |
|---|---|
| `Strg` + `R` (macOS: `Cmd` + `R`) | Aufnahme starten bzw. beenden |
| `M` | Marker an der aktuellen Stelle setzen |
| `N` | Nächsten Ablaufpunkt hier beginnen lassen |
| `Leertaste` | Abspielen/Pause (nach dem Beenden) |
| Mausrad | auf der Wellenform scrollen |
| `Strg` + Mausrad | zoomen |

## Lokale Mitschrift einrichten

Die Transkription nutzt [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
und läuft vollständig auf dem Aufnahmerechner.

**Windows:**

1. Fertige Windows-Binaries von whisper.cpp herunterladen oder selbst bauen.
2. Ein Modell holen, zum Beispiel `ggml-small.bin` oder ein deutsches Modell.
   `small` ist ein guter Kompromiss; `medium` ist genauer, braucht aber deutlich
   mehr Rechenleistung.
3. In den Einstellungen beide Pfade angeben.

**macOS:**

Fertige Windows-`.exe`-Dateien laufen auf macOS nicht – whisper.cpp muss dort
als natives macOS-Programm vorliegen. Am zuverlässigsten ist, es selbst zu
bauen:

1. Einmalig die Xcode-Kommandozeilenwerkzeuge installieren:
   ```bash
   xcode-select --install
   ```
2. whisper.cpp klonen und bauen:
   ```bash
   git clone https://github.com/ggerganov/whisper.cpp
   cd whisper.cpp
   cmake -B build
   cmake --build build --config Release
   ```
   Auf Apple Silicon (M1 bis M4) wird dabei standardmäßig Metal-Unterstützung
   eingebaut – die Berechnung läuft dann über die GPU statt nur über die CPU
   und die Transkription ist spürbar schneller. Das fertige Programm liegt
   danach unter `build/bin/whisper-cli` (in älteren Versionen `build/bin/main`).
3. Ein Modell holen, zum Beispiel mit dem mitgelieferten Skript:
   ```bash
   bash ./models/download-ggml-model.sh small
   ```
4. In den Einstellungen den Pfad zu `whisper-cli` sowie zur Modelldatei
   (`.bin` unter `models/`) angeben.

Die Mitschrift arbeitet blockweise mit einigen Sekunden Verzögerung. Sie ist
eine Orientierungshilfe, kein wortgenaues Protokoll. Kommt der Rechner nicht
mit, werden Blöcke übersprungen – die Audioaufnahme selbst wird niemals
beeinträchtigt oder gestoppt.

## Netzwerkschnittstelle

Beschreibung aller Nachrichten: [`docs/websocket-api.md`](docs/websocket-api.md).

Kurz: `ws://<rechner>:8765/`, Anmeldung mit
`{"type":"auth","password":"…"}`, danach kommen `state`- und `levels`-Nachrichten.
Für eine reine Statusabfrage genügt `http://<rechner>:8765/health`.

Das Companion-Modul liegt im Nachbarordner
`companion-module-churchrecorder`.

## Updates

Die App prüft beim Start und danach alle sechs Stunden, ob im GitHub-Repository
ein neues Release liegt, und lädt es im Hintergrund herunter. Ist es fertig,
erscheint oben „Update installieren".

**Während einer laufenden oder pausierten Aufnahme wird nie installiert oder neu
gestartet.** Der Knopf verweigert in diesem Fall mit einem Hinweis; das Update
wird spätestens beim nächsten regulären Beenden eingespielt.

### Neue Version veröffentlichen

1. In `package.json` bei `build.publish` `owner` und `repo` eintragen.
2. Version erhöhen: `npm version patch` (oder `minor` / `major`).
3. Ein GitHub-Token mit Repo-Rechten als `GH_TOKEN` setzen und
   `npm run publish` ausführen – oder den Tag pushen und den mitgelieferten
   Workflow (`.github/workflows/release.yml`) bauen lassen.

Da das Repository öffentlich ist, braucht niemand ein Zugriffstoken, um Updates
herunterzuladen – `electron-updater` liest öffentliche Releases ohne Anmeldung.
Ein `GH_TOKEN` ist nur beim Veröffentlichen selbst nötig (siehe oben), nicht
beim Herunterladen auf den Aufnahmerechnern.

## Besonderheiten unter macOS

Die App läuft auf macOS 11 und neuer, sowohl auf Intel als auch auf Apple
Silicon. Ein paar Dinge unterscheiden sich:

- **Mikrofonfreigabe.** Beim ersten Start fragt macOS nach dem Zugriff auf den
  Audioeingang. Wird das abgelehnt, nimmt die App nichts auf. Nachträglich
  freigeben unter *Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon*.
- **Menüleiste.** Oben am Bildschirm liegt ein Menü mit den üblichen Kürzeln.
  Aufnahme starten und beenden geht dort mit `Cmd` + `R`, Marker setzen mit
  `Cmd` + `M`, der nächste Ablaufpunkt mit `Cmd` + `Alt` + `N`. Die Kürzel aus
  dem Fenster (`M`, `N`, Leertaste) funktionieren weiterhin.
- **Beenden mit `Cmd` + `Q`** fragt nach, solange eine Aufnahme läuft.
- **whisper.cpp** wird als macOS-Binary benötigt, nicht als .exe. Auf Apple
  Silicon läuft die Transkription über Metal spürbar schneller.

### Signierung und Notarisierung

Ohne Apple-Entwicklerzertifikat (99 $ im Jahr) lässt sich die App zwar bauen und
benutzen – beim ersten Öffnen ist dann aber ein Rechtsklick auf die App und
*Öffnen* nötig, um Gatekeeper zu überzeugen.

**Wichtig:** Die automatische Update-Funktion arbeitet auf macOS ausschließlich
mit signierten Apps. Ohne Zertifikat muss jede neue Version von Hand installiert
werden; unter Windows bleiben die Updates davon unberührt.

Sobald ein Zertifikat vorliegt, sind nur zwei Schritte nötig:

1. In `package.json` unter `build.mac` `"notarize"` auf `true` setzen.
2. Im GitHub-Repository diese Secrets hinterlegen – der Workflow nutzt sie
   automatisch:

   | Secret | Inhalt |
   |---|---|
   | `MAC_CERT_P12` | Zertifikat als Base64-kodierte .p12-Datei |
   | `MAC_CERT_PASSWORD` | Passwort der .p12-Datei |
   | `APPLE_ID` | Apple-ID des Entwicklerkontos |
   | `APPLE_APP_PASSWORD` | app-spezifisches Passwort |
   | `APPLE_TEAM_ID` | Team-ID aus dem Entwicklerportal |

Die Rechte für Mikrofon, Netzwerk und den Start von whisper.cpp stehen bereits
in `build/entitlements.mac.plist`.

## Aufbau des Projekts

```
src/main/        Hauptprozess
  main.js        Fenster, IPC, Verdrahtung
  session.js     Zustand, Marker, Abschnitte, Autosave
  wav.js         WAV schreiben/lesen (Masteraufnahme)
  mp3.js         MP3-Export eines Abschnitts
  churchtools.js ChurchTools-API
  netserver.js   WebSocket-Schnittstelle
  transcribe.js  lokale Mitschrift über whisper.cpp
  updater.js     Updates über GitHub Releases
  settings.js    Einstellungen, Token-Verschlüsselung
src/preload.js   Brücke zur Oberfläche
src/renderer/    Oberfläche
  capture.js     Audioerfassung (AudioWorklet)
  waveform.js    Wellenform und Marker
  app.js         Bedienlogik
```

Audio wird in der Oberfläche erfasst, als Int16-Blöcke an den Hauptprozess
übergeben und dort sofort auf die Festplatte geschrieben. Der Hauptprozess
berechnet Pegel und Wellenform-Spitzenwerte und führt die einzige gültige
Version des Zustands – Oberfläche, Netzwerk und Companion sehen alle dasselbe.

## Sicherheitshinweis

Die Netzwerkschnittstelle ist für ein vertrauenswürdiges lokales Netz gedacht.
Die Verbindung ist unverschlüsselt; das Passwort verhindert versehentlichen
Zugriff, schützt aber nicht gegen einen Angreifer im selben Netz.
