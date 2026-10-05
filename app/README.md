# ChurchRecorder

Aufnahmeprogramm für Gottesdienste. Nimmt eine Stereospur des Audioeingangs auf,
gliedert sie über Abschnitte mit verschiebbarer Anfangs- und Endmarke in die Programmpunkte des Ablaufplans und
speichert einen ausgewählten Abschnitt – zum Beispiel die Predigt – als MP3.

- Durchgehende, verlustfreie WAV-Masteraufnahme; Abschnitte sind nur Metadaten
- Ablaufplan aus ChurchTools, Punkte per Drag-and-Drop auf die Wellenform
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
   Die Entwicklerwerkzeuge öffnen sich nicht von selbst (sie würden bei jedem
   Neustart den Fokus holen): per `F12` bzw. `Strg`/`Cmd` + `Umschalt` + `I`
   ein- und ausblenden, oder dauerhaft starten mit `npm run dev:tools`.
3. Arbeitsablauf: vor dem Arbeiten `git pull`, danach committen und pushen.
   Aktuell wird auf beiden Rechnern direkt auf `main` gearbeitet (Testphase);
   bei produktiver Nutzung sollten Änderungen am Aufnahmerechner auf Branches.

Pro Rechner einmalig und nicht im Repository: der ChurchTools-Token und das
Netzwerkpasswort. Unter Windows kann es bei nativen Modulen nötig sein, die
Visual Studio Build Tools zu installieren; aktuell hat die App keine.

Gebaut wird jeweils auf dem Zielsystem – ein Mac-Build lässt sich nicht unter
Windows erzeugen. Der mitgelieferte Workflow erledigt beides auf GitHub.

## Einrichtung beim ersten Start

1. **Einstellungen → Audio:** Eingang und Abtastrate wählen. Die Auswahl wird
   gespeichert und beim nächsten Start wiederverwendet.
2. **Einstellungen → Ablage:** Ordner für die Aufnahmen festlegen. Rechne mit
   etwa 700 MB pro Stunde für die WAV-Masteraufnahme. Zusätzlich lässt sich ein
   Oberordner für die MP3-Exporte angeben (z. B. „Aufnahmen 2026"); darin
   entsteht je Gottesdienst ein Unterordner `Datum_Gottesdienstname`.
3. **Einstellungen → ChurchTools:** Adresse und Personal Access Token eintragen,
   dann „Verbindung prüfen". Der Token wird über die Schlüsselverwaltung des
   Betriebssystems verschlüsselt abgelegt.
4. **Einstellungen → Netzwerk:** Ein Passwort für die Steuerung vergeben, sonst
   startet die Schnittstelle nicht. Optional ein zweites Passwort nur zum
   Mitlesen für das Dashboard.

## Ablauf eines Gottesdienstes

1. Oben auf den Namen klicken und den Gottesdienst wählen. Ist für heute genau
   ein Termin eingetragen, wird er beim Start automatisch geladen. Die
   Programmpunkte erscheinen links als offene Punkte.
2. **Neue Aufnahme starten.** Die Wellenform wächst mit, die Pegelanzeige zeigt den
   Eingang, der obere Fensterrand leuchtet rot.
3. Jeder Abschnitt besteht aus zwei Marken: Anfang und Ende. „Abschnitt starten"
   (Taste **M**) setzt die Anfangsmarke, derselbe Knopf („Abschnitt beenden",
   wieder **M**) die Endmarke. Beginnt ein Programmpunkt des Ablaufplans, auf
   „Nächster Ablaufpunkt" drücken (Taste **N**) oder in der Liste auf „starten":
   Ein laufender Abschnitt endet dabei an derselben Stelle. Die Marke wird sofort
   gesetzt, benannt wird danach (✎, Doppelklick oder **F2**). Jeder Abschnitt hat
   eine eigene dezente Farbe in Wellenform und Liste.
4. Marken sitzen selten sofort richtig. Sie lassen sich jederzeit – auch während
   der Aufnahme – am Fähnchen auf der Wellenform verschieben; mit der
   Leertaste lässt sich dabei in die Aufnahme hineinhören. Nach „Beenden" werden noch
   laufende Abschnitte am Ende der Aufnahme geschlossen.
5. **Beenden.** Danach unten rechts unter „Abschnitte exportieren" die gewünschten
   Abschnitte anhaken (neue sind vorausgewählt, „Alle"/„Keine" schalten um; ein
   Klick auf den Namen zeigt den Abschnitt in der Wellenform) und mit „Ausgewählte
   als MP3 speichern" exportieren. Bereits gesicherte Abschnitte tragen den
   Vermerk „✓ gesichert" (oder „✓ geändert seit Export", wenn ihre Marken seitdem
   verschoben wurden) und sind nicht mehr vorausgewählt. „Gesamte Aufnahme" steht
   ebenfalls zur Wahl. Ist ein Export-Oberordner eingestellt, wird ohne Rückfrage
   in dessen Unterordner `Datum_Gottesdienstname` gespeichert (bei gleichem Namen
   mit „ (2)" usw.); ohne Oberordner wird ein Zielordner abgefragt.

Die WAV-Masteraufnahme bleibt erhalten. Über „Aufnahmen" kann eine frühere
Session erneut geöffnet, die Marken nachjustiert und ein weiterer Abschnitt
exportiert werden.

### Oberfläche rund um die Wellenform

Unter der Wellenform stehen drei Bereiche: **Ablaufplan** (offene Punkte),
**Abschnitte** (gesetzte Abschnitte mit Zeitraum, Doppelklick zum Umbenennen) und
**Abschnitte exportieren**. Ganz unten zeigt eine Leiste die wichtigsten
**Tastenkürzel** („alle Kürzel (?)" öffnet die komplette Liste). Rechts oben in
der Kopfleiste steht der **freie Speicherplatz** und wie viele Aufnahmestunden das
sind; unter 3 Stunden wird die Anzeige orange, unter 30 Minuten rot (dann auch mit
Meldung während der Aufnahme).

### Tastaturkürzel

| Taste | Wirkung |
|---|---|
| `Strg` + `R` (macOS: `Cmd` + `R`) | Aufnahme starten bzw. beenden |
| `M` | Abschnitt starten bzw. beenden (Anfangs-/Endmarke setzen) |
| `N` | Laufenden Abschnitt beenden und nächsten Ablaufpunkt beginnen |
| `F2` | Gewählten Abschnitt umbenennen |
| `?` | Alle Tastenkürzel anzeigen |
| `Leertaste` | Abspielen/Pause; während der Aufnahme: Mithören ab dem Hörcursor |
| Mausrad | auf der Wellenform scrollen |
| `Strg` + Mausrad | zoomen |

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

Die Rechte für Mikrofon und Netzwerk stehen bereits
in `build/entitlements.mac.plist`.

## Aufbau des Projekts

```
src/main/        Hauptprozess
  main.js        Fenster, IPC, Verdrahtung
  session.js     Zustand, Abschnitte, Aufnahme/Fortsetzen, Autosave
  wav.js         WAV schreiben/lesen (Masteraufnahme)
  mp3.js         MP3-Export eines Abschnitts
  churchtools.js ChurchTools-API
  netserver.js   WebSocket-Schnittstelle
  updater.js     Updates über GitHub Releases
  settings.js    Einstellungen, Token-Verschlüsselung
src/shared/      Von Hauptprozess und Oberfläche gemeinsam genutzt
  sections.js    Regeln für Abschnitte (Verschieben ohne Überlappung)
src/preload.js   Brücke zur Oberfläche
src/renderer/    Oberfläche
  capture.js     Audioerfassung (AudioWorklet)
  monitor.js     Mithören der laufenden Aufnahme
  waveform.js    Wellenform und Abschnittsmarken
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
