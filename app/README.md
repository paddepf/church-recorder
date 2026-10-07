# Ebbton

Aufnahmeprogramm für Gottesdienste. Nimmt eine Stereospur des Audioeingangs auf,
gliedert sie über Abschnitte mit verschiebbarer Anfangs- und Endmarke in die Programmpunkte des Ablaufplans und
speichert einen ausgewählten Abschnitt – zum Beispiel die Predigt – als MP3.

- Durchgehende, verlustfreie WAV-Masteraufnahme; Abschnitte sind Metadaten (Session-Datei, nach dem Beenden zusätzlich als Cue-Marker in der WAV, lesbar in Audacity, Reaper u. a.)
- Ablaufplan aus ChurchTools, Punkte per Drag-and-Drop auf die Wellenform
- Netzwerkschnittstelle für ein eigenes Monitoring-Dashboard
- Fernsteuerung über Bitfocus Companion

## Installation für die Entwicklung

Voraussetzung: Node.js 22.12 oder neuer (empfohlen 24 LTS), weil Electron 44 und
electron-builder 26 das zum Installieren und Bauen verlangen.

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

1. [Git for Windows](https://git-scm.com/download/win) und Node.js 24 (LTS)
   installieren, ein Editor wie VS Code oder die Claude-Desktop-App ist optional.
2. Klonen und starten (im Ordner `app/`):
   ```bash
   git clone https://github.com/paddepf/ebbton.git
   cd ebbton/app
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

1. **Einstellungen → Audio:** Eingang, Ausgang (fürs Mithören) und Abtastrate wählen. Die Auswahl wird
   gespeichert und beim nächsten Start wiederverwendet.
2. **Einstellungen → Ablage:** Ordner für die Aufnahmen festlegen. Rechne mit
   etwa 700 MB pro Stunde für die WAV-Masteraufnahme. Zusätzlich lässt sich ein
   Oberordner für die MP3-Exporte angeben (z. B. „Aufnahmen 2026“); darin
   entsteht je Gottesdienst ein Unterordner `Datum_Gottesdienstname`. Der **Dateiname**
   der MP3s ist ein Muster mit den Platzhaltern `{interpret}`, `{abschnitt}`,
   `{gottesdienst}`, `{datum}` und `{zeit}`; Standard ist
   `{interpret}_{abschnitt}_{gottesdienst}_{datum}`. Fehlt der Interpret, entfällt er
   samt Trennzeichen (z. B. `Predigt_Sonntagsgottesdienst_2026-10-05.mp3`).
3. **Einstellungen → ChurchTools:** Adresse und Personal Access Token eintragen,
   dann „Verbindung prüfen“. Der Token wird über die Schlüsselverwaltung des
   Betriebssystems verschlüsselt abgelegt.
4. **Einstellungen → Netzwerk:** Ein Passwort für die Steuerung vergeben, sonst
   startet die Schnittstelle nicht. Optional ein zweites Passwort nur zum
   Mitlesen für das Dashboard.

## Ablauf eines Gottesdienstes

1. Oben auf den Namen klicken und den Gottesdienst wählen. Ist für heute genau
   ein Termin eingetragen, wird er beim Start automatisch geladen. Die
   Programmpunkte erscheinen links als offene Punkte. Dieselbe Auswahl öffnet auch der Knopf
   „ChurchTools …“ in der Kachel „Ablaufplan“; darunter steht in einer Zeile, ob der Plan aus ChurchTools oder aus welcher Vorlage stammt, mit Zahl der Dienste und Infotext (Details im Tooltip).
2. **Neue Aufnahme starten.** Die Wellenform wächst mit, die Pegelanzeige zeigt den
   Eingang, der obere Fensterrand leuchtet rot. **Der erste Punkt des Ablaufplans beginnt dabei
   automatisch** (bei Sekunde 0); ohne Ablaufpunkte läuft zunächst kein Abschnitt.
3. Jeder Abschnitt besteht aus zwei Marken: Anfang und Ende. „Abschnitt starten“
   (Taste **M**) setzt die Anfangsmarke, derselbe Knopf („Abschnitt abschließen“,
   wieder **M**) die Endmarke. Beginnt ein Programmpunkt des Ablaufplans, auf
   „Nächster Ablaufpunkt“ drücken (Taste **N**) oder den Punkt in der Liste anklicken:
   Ein laufender Abschnitt endet dabei an derselben Stelle. Die Marke wird sofort
   gesetzt, benannt wird danach direkt im Feld (siehe unten). Jeder Abschnitt hat
   eine eigene dezente Farbe in Wellenform und Liste.
   **Pausen zwischen zwei Punkten:** Ist nach einem Punkt eine längere Pause (Ansage, Umbau, Stille), die in keinem
   der beiden Abschnitte landen soll, zuerst **„Abschnitt abschließen“** (`M`) drücken: Die Aufnahme läuft ohne aktiven
   Abschnitt weiter („Zwischen den Punkten“), bis **„Nächster Ablaufpunkt“** (`N`) den nächsten beginnt. Ohne
   Zwischenschritt beginnt der nächste Punkt nahtlos da, wo der vorige endet.
4. Marken sitzen selten sofort richtig. Sie lassen sich jederzeit – auch während
   der Aufnahme – am Fähnchen auf der Wellenform verschieben; mit der
   Leertaste lässt sich dabei in die Aufnahme hineinhören. Nach „Beenden“ werden noch
   laufende Abschnitte am Ende der Aufnahme geschlossen.
5. **Beenden.** Danach unten rechts unter „Abschnitte exportieren“ die gewünschten
   Abschnitte anhaken (neue sind vorausgewählt, „Alle“/„Keine“ schalten um; ein
   Klick auf den Namen zeigt den Abschnitt in der Wellenform) und mit „Ausgewählte
   als MP3 speichern" exportieren. Bereits gesicherte Abschnitte tragen den
   Vermerk „✓“ (oder „⚠“ = geändert seit Export, wenn ihre Marken seitdem
   verschoben wurden; Zeitraum und Datei im Tooltip, die Zeile zeigt die Länge) und sind nicht mehr vorausgewählt. „Gesamte Aufnahme“ steht
   ebenfalls zur Wahl. Ist ein Export-Oberordner eingestellt, wird ohne Rückfrage
   in dessen Unterordner `Datum_Gottesdienstname` gespeichert (bei gleichem Namen
   mit „ (2)“ usw.); ohne Oberordner wird ein Zielordner abgefragt. Die MP3s
   erhalten ID3-Tags: **Titel** = Abschnittsname, **Album** = Datum des
   Gottesdienstes (z. B. `2026-10-05`), **Jahr**, **Interpret** = der beim
   Abschnitt eingetragene Name, sonst der „Standard-Interpret“ aus den Einstellungen.
   Den Interpreten trägst du direkt im Feld ein (siehe „Name und Interpret direkt
   bearbeiten") – auch schon bei den offenen Punkten im Ablaufplan, bevor sie
   aufgenommen werden. Er steht hell hinter dem Namen, fehlt er, erscheint beim
   Darüberfahren „+ Interpret“.
   Lange Namen werden in den Listen mit „…“ gekürzt; beim Darüberfahren erscheint
   der ganze Titel samt Interpret.

Die WAV-Masteraufnahme bleibt erhalten. Über „Aufnahmen“ kann eine frühere
Session erneut geöffnet, die Marken nachjustiert und ein weiterer Abschnitt
exportiert werden.

### Interpret aus ChurchTools

- **Ablaufplan:** Ist bei einem Ablaufpunkt in ChurchTools eine zuständige Person eingetragen, wird sie
  automatisch als Interpret übernommen (jederzeit änderbar).
- **Dienstplanung:** Auch ohne Ablaufplan sind meist Dienste wie „Leitung“ und „Predigt“ besetzt. Beim Wählen
  eines Termins liest die App diese Personen aus der Dienstplanung. Beim Bearbeiten eines Abschnitts erscheinen
  sie als **Vorschläge zum Anklicken** (Name · Dienst) unter den Eingabefeldern; ein Klick übernimmt den Namen
  und speichert.
- **Automatisch eintragen:** Passt ein Dienst zum Namen eines Ablaufpunkts, wird die Person direkt als Interpret
  eingetragen – zum Beispiel der Dienst „Predigt 2“ beim Punkt „Predigt“. Verglichen werden ganze Wörter
  („Leitung“ passt nicht zu „Einleitung“), Zahlen zählen nicht („Predigt 2“ passt nicht zu „Lied 2“).
  Sind mehrere Dienste passend (z. B. „Predigt“ und „Predigt 2“), stehen alle Namen mit Komma dort. Eine
  zuständige Person aus dem Ablaufplan hat Vorrang, und jeder Eintrag lässt sich ändern. Die übrigen Personen
  bleiben als Vorschläge zum Anklicken; passende stehen zuerst und haben einen grünen Rand. Welche Dienste gelesen werden, steht unter **Einstellungen → ChurchTools →
  Dienste für Interpret-Vorschläge** (Standard: `Leitung, Predigt, Geschichte`, durch Komma getrennt; der Dienst „Geschichte“ gehört fest zum Ablaufpunkt „Kinderbeitrag“, „Leitung“ fest zu „Einleitung“ und „Abschluss“; diese Dienste werden immer gelesen; der Dienstname muss
  das Wort enthalten, „Leitung“ findet also auch „Gebetsleitung“).
- Beim Wählen des Termins meldet die App nur Ungewöhnliches: dass kein Ablaufplan vorlag (und welche Vorlage
  geladen wurde) oder dass die Dienstplanung nicht gelesen werden konnte. Eingetragene Punkte, Interpreten und
  Infotext stehen direkt in den Listen.

### Name und Interpret direkt bearbeiten

Ohne Dialog, direkt am Element: ein kleines Eingabefeld legt sich über das Fähnchen
oder die Listenzeile, links der Name, rechts der Interpret.
- **Wellenform:** Doppelklick auf das Fähnchen eines Abschnitts. Ein Doppelklick auf den
  Interpreten (bzw. „+ Interpret“) springt direkt in dieses Feld.
- **Abschnittsliste:** Doppelklick auf den Namen, ✎, oder ein Klick auf den Interpreten.
- **Ablaufplan:** ✎ oder ein Klick auf den Interpreten (ein Klick auf den Punkt selbst
  beginnt ihn).
- **F2:** bearbeitet den gewählten Abschnitt in der Abschnittsliste.

`Enter` speichert, `Esc` bricht ab, `Tab` wechselt zwischen Name und Interpret, ein Klick
daneben speichert ebenfalls.

### Rückgängig, Schnitte und Warnungen

- **Rückgängig / Wiederholen:** `Strg`/`Cmd` + `Z` nimmt die letzte Änderung an Abschnitten oder Schnitten
  zurück (Marke gesetzt, verschoben, gelöscht, umbenannt …), `Umschalt` + `Strg`/`Cmd` + `Z` bzw. `Strg` + `Y`
  stellt sie wieder her. Bis zu 60 Schritte; auch das Laden einer Vorlage oder eines Ablaufplans lässt sich
  zurücknehmen. Mit „Beenden“, einer neuen Aufnahme oder dem Öffnen einer anderen beginnt der Verlauf neu. In Eingabefeldern wirkt
  Rückgängig wie gewohnt auf den Text.
- **Schnitte (Stellen, die im MP3 fehlen sollen):** Ein Husten oder eine Störung mitten im Abschnitt lässt sich
  auslassen, ohne die Aufnahme zu verändern. Während der Aufnahme beginnt `X` einen Schnitt und beendet ihn
  mit dem zweiten Druck. Nachträglich: mit `Umschalt` + Ziehen in der Wellenform aufziehen. Schnitte erscheinen
  rot schraffiert, ihre Ränder lassen sich ziehen, ein Doppelklick entfernt sie. Beim Export fehlen die Stellen
  (mit kurzer Ein-/Ausblendung an den Nahtstellen); die Exportliste zeigt die gekürzte Länge („✂ −0:12“).
  Beim Abschnitt „✓ geändert seit Export“ erscheint auch, wenn sich die Schnitte seither geändert haben.
- **Eingang überwacht:** Kommt über 20 Sekunden fast kein Pegel (Mischpult stumm, Kabel gezogen), erscheint ein
  oranger Balken. Fällt der Eingang ganz aus, ein roter. Beides sehen auch Companion und Dashboards (`health`).

### Ablaufplan bearbeiten und Standardpunkte

Hat ein Termin in ChurchTools **keinen Ablaufplan** (die Abfrage meldet 404) oder wird
ohne ChurchTools aufgenommen, trägt die App die **Standard-Programmpunkte** ein
(Vorgabe: Einleitung, Kinderbeitrag, Predigt, Abschluss). Das ist die **Standardvorlage**.
Unter **Einstellungen → Vorlagen für Programmpunkte** lassen sich beliebig viele Vorlagen anlegen
(z. B. „Gottesdienst“, „Jugend“, „Gebetsabend“): Vorlage wählen, Namen und Punkte bearbeiten (↑/↓ zum
Umsortieren), neue Vorlage mit „Neu“, und eine als Standard festlegen. Im Ablaufplan lädt das Auswahlfeld
**„Vorlage laden …“** jederzeit eine andere Vorlage; die offenen Punkte werden dabei (nach Rückfrage)
ersetzt, bereits gesetzte Abschnitte bleiben.

**Infotext als Predigttitel:** Trägt der Termin in ChurchTools einen Infotext (z. B. bei der Bibelstunde
„Kolosser 2,6-7 Verwurzelt in Christus“), hängt die App ihn beim Laden an den Abschnitt „Predigt“ an – er heißt
dann „Predigt: Kolosser 2,6-7 Verwurzelt in Christus“ und landet so auch im Dateinamen und im MP3-Titel. Nur die
erste Zeile wird genommen; der Name lässt sich jederzeit wie gewohnt ändern. Der Text steht dann im Namen des
Abschnitts.

**Passende Vorlage automatisch:** Fehlt der Ablaufplan, nimmt die App nicht blind die Standardvorlage,
sondern die Vorlage, deren **Name zum Titel des Gottesdienstes passt** – ein Termin „Bibelstunde“ (oder
„Bibelstunde im Gemeindehaus“) lädt die Vorlage „Bibelstunde“. Das gilt für jede selbst angelegte Vorlage:
alle Wörter des Vorlagennamens müssen als ganze Wörter im Titel vorkommen (Groß-/Kleinschreibung egal), bei
mehreren Treffern gewinnt der längere Name. Ohne Treffer gilt die Standardvorlage. Hat ChurchTools einen
Ablaufplan, bleibt dieser maßgeblich.

In der Kachel **Ablaufplan** lässt sich die Liste jederzeit anpassen:
- **Hinzufügen:** unten Namen eintippen, Enter oder „+“.
- **Entfernen:** × neben dem Punkt. Ein bereits gesetzter Abschnitt aus dem Ablaufplan
  geht über × in der Abschnittsliste zurück in den Ablaufplan.
- **Umsortieren:** einen Punkt in der Liste auf einen anderen ziehen (oberhalb/unterhalb
  der Mitte entscheidet, davor oder dahinter) oder auf den freien Platz darunter, um ihn ans
  Ende zu setzen. „Nächster Ablaufpunkt“ (N) nimmt immer den obersten.

### Oberfläche rund um die Wellenform

Die Wellenform zeigt beim Start und bei jeder neuen oder fortgesetzten Aufnahme
standardmäßig **5 Minuten** auf einmal; mit den Knöpfen `+`/`−`, `Strg` + Mausrad oder
`Umschalt` + Mausrad lässt sich zoomen. Eine beendete oder geöffnete Aufnahme wird komplett eingepasst. Lange
Abschnittsnamen werden an der Marke mit „…“ gekürzt, damit sich Beschriftungen
nicht überlappen; weiter hineinzoomen zeigt mehr vom Namen.

Unter der Wellenform stehen drei Bereiche: **Ablaufplan** (offene Punkte),
**Abschnitte** (gesetzte Abschnitte mit Zeitraum, Doppelklick zum Umbenennen) und
**Abschnitte exportieren**. Ganz unten zeigt eine Leiste die wichtigsten
**Tastenkürzel** („alle Kürzel (?)“ öffnet die komplette Liste). Rechts oben in
der Kopfleiste steht der **freie Speicherplatz** und wie viele Aufnahmestunden das
sind; unter 3 Stunden wird die Anzeige orange, unter 30 Minuten rot (dann auch mit
Meldung während der Aufnahme).

### Tastaturkürzel

| Taste | Wirkung |
|---|---|
| `Strg` + `R` (macOS: `Cmd` + `R`) | Aufnahme starten bzw. beenden (auch eine pausierte) |
| `M` | Abschnitt starten bzw. beenden (Anfangs-/Endmarke setzen) |
| `N` | Laufenden Abschnitt beenden und nächsten Ablaufpunkt beginnen |
| `X` | Schnitt starten bzw. beenden (Stelle fehlt im MP3) |
| `Strg`/`Cmd` + `Z` | Rückgängig; `Umschalt` + `Strg`/`Cmd` + `Z` oder `Strg` + `Y`: Wiederholen |
| `F2` | Gewählten Abschnitt bearbeiten (Name und Interpret) |
| `?` | Alle Tastenkürzel anzeigen (nochmal `?` oder `Esc` schließt) |
| `Strg` + `Umschalt` + `M` (macOS: `Cmd` + `Umschalt` + `M`) | Mini-Fenster ein/aus |
| `Esc` | Offenen Dialog schließen |
| `Leertaste` | Abspielen/Pause; während der Aufnahme: Mithören ab dem Hörcursor |
| Mausrad | auf der Wellenform scrollen |
| `Strg` + Mausrad oder `Umschalt` + Mausrad | zoomen |

Gehaltene Tasten wiederholen nicht (sonst würden sich z. B. Abschnitte im Wechsel starten und beenden).

### Meldungen

**Fehler und Warnungen** (z. B. Platte voll, Eingang ausgefallen, wenig Speicher) erscheinen groß und farbig oben
in der Mitte: rot für Fehler, gelb für Warnungen. Sie bleiben mindestens 15 bzw. 30 Sekunden stehen und lassen
sich per Klick schließen. Kleine Hinweise erscheinen dezent unten rechts und verschwinden von selbst. Bestätigungen
für das, was man ohnehin sieht, gibt es nicht.

### Laufzeit des aktuellen Abschnitts

Unter dem Timer (und im Mini-Fenster rechts in der Karte des laufenden Abschnitts) steht, **wie lange der aktuelle
Abschnitt schon läuft** – als `2:20`, ab einer Stunde `1:04:00`. Die Anzeige läuft mit der Aufnahme mit und
verschwindet, wenn kein Abschnitt aktiv ist (z. B. in der Pause zwischen zwei Punkten). Auch in der Kachel
**Abschnitte** steht hinter jedem Abschnitt seine **Laufzeit** (bei einem laufenden zählt sie mit).

### Mini-Fenster

Rechts oben wählt der Umschalter **„Groß | Kompakt | Mini“** die Ansicht.

Wird nebenher am PC gearbeitet, verkleinert **„Mini“** die App auf ein sehr kleines
Fenster (ab 320 × 164) mit Gottesdienstname, Timer, Pegel (schmaler Streifen), dem **laufenden Abschnitt groß mit Interpret** und den Knöpfen für Aufnahme, Pause,
Beenden, „Abschnitt starten“ und „Nächster Ablaufpunkt“ (der Knopf nennt den Namen des Punktes, der als Nächstes
beginnt – „→ Predigt“; ist keiner mehr offen, steht dort „→ Abschnitt abschließen“). Ein Klick auf den laufenden Abschnitt (oder ✎) öffnet
direkt die Eingabe für Name und Interpret samt Vorschlägen aus der Dienstplanung (Klick auf den Interpret
setzt den Cursor gleich dorthin); das geht auch im großen Fenster unter dem Timer. Die Tastenkürzel gelten weiter. Es liegt beim
ersten Mal unten rechts und merkt sich danach Lage und Größe. Mit **„Immer oben“** bleibt es über
anderen Programmen (Voreinstellung, abschaltbar). **Nach dem Beenden** der Aufnahme verschwinden die Aufnahmeknöpfe;
stattdessen zeigt das Mini-Fenster, wie viele Abschnitte noch nicht gesichert sind, und einen Knopf **„… als MP3
speichern“** (angehakte bzw. noch nicht gesicherte oder seit dem Export geänderte Abschnitte, ohne Abschnitte die gesamte
Aufnahme; ist alles gesichert, steht dort „alles gesichert ✓“ und der Knopf entfällt), dazu Fortschritt
und „Im Ordner zeigen“. „Neue Aufnahme“ darunter beginnt die nächste. **„Groß“** bzw. **„Kompakt“** stellt die vorherige Größe
wieder her. Öffnet sich ein Dialog (z. B. Rückfrage beim Start, Einstellungen, `?`), schaltet die App
selbst auf das große Fenster um. Die Aufnahme läuft beim Umschalten unverändert weiter.

### Kompakte Ansicht

**„Kompakt“** (Voreinstellung) verkleinert Schrift, Knöpfe, Abstände und Wellenform,
lässt aber **alle Bereiche und Funktionen** stehen: Ablaufplan, Abschnitte, Export, Wellenform und Tastenleiste. So
lässt sich auch in einem kleineren Fenster (ab 760 × 520 statt 1024 × 680) vollständig arbeiten. In sehr schmalen
Fenstern entfallen die Zeitspalte der Abschnitte (Zeitraum im Tooltip), das Datum neben dem Gottesdienstnamen und bei
sehr niedrigen die Tastenleiste (Kürzel weiter über `?`). Beim Einschalten wird das Fenster passend verkleinert
(beim ersten Mal 960 × 640, danach die zuletzt benutzte Größe), beim Ausschalten bekommt es wieder seine vorherige Größe.
Die Wahl bleibt gespeichert; die App startet dann gleich in der kompakten Größe. Das Mini-Fenster ist davon
unabhängig und sieht immer gleich aus.

### Kalender, Beenden, Bedienung per Tastatur

- **Kalender:** Unter Einstellungen → ChurchTools → „Kalender laden“ lassen sich die Kalender
  wählen, deren Termine in der Auswahl erscheinen (ohne Häkchen: alle).
- **Beenden:** Beim Schließen während einer Aufnahme fragt die App nach, ohne die Aufnahme dabei
  anzuhalten, und schließt erst, wenn die Datei vollständig geschrieben ist.
- **Pause:** In der Pause zeigt der Aufnahmeknopf „Aufnahme pausiert“, fortgesetzt wird mit dem
  Pause-Knopf („Fortsetzen“). „An Aufnahme anhängen“ hängt an eine bereits beendete Aufnahme an.
- **Tastatur:** Die Punkte in Ablaufplan und Abschnittsliste lassen sich mit `Tab` erreichen,
  mit den Pfeiltasten wechseln, mit `Enter` auslösen (Ablaufpunkt beginnen bzw. Abschnitt
  anzeigen) und mit `F2` bearbeiten.

## Netzwerkschnittstelle

Beschreibung aller Nachrichten: [`docs/websocket-api.md`](docs/websocket-api.md).

Kurz: `ws://<rechner>:8765/`, Anmeldung mit
`{"type":"auth","password":"…"}`, danach kommen `state`- und `levels`-Nachrichten.
Für eine reine Statusabfrage genügt `http://<rechner>:8765/health`.

Das Companion-Modul liegt im Ordner `companion-module/` dieses Repositorys.

## Updates

Die App sucht kurz nach dem Start und danach alle zwei Stunden, ob im GitHub-Repository
ein neues Release liegt (abschaltbar in den Einstellungen; dort auch „Jetzt nach Update suchen“
mit Ergebnis und Zeitpunkt der letzten Suche). Jeder Schritt braucht eine Zustimmung:

1. **Gefunden:** Ein Dialog nennt die neue und die installierte Version samt „Was ist neu?“ und
   fragt, ob heruntergeladen werden soll. „Später“ lässt oben den Knopf „Update … verfügbar“ stehen.
2. **Download:** Fortschrittsbalken mit Prozent, MB, Geschwindigkeit und Restzeit; der Dialog kann
   geschlossen werden („Im Hintergrund weiter“), der Kopfzeilen-Knopf zählt mit.
3. **Bereit:** Zweite Rückfrage „Jetzt installieren und neu starten?“. Danach wird Ebbton beendet,
   das Update unter Windows ohne Installer-Fragen eingespielt und Ebbton von selbst neu gestartet
   (etwa eine halbe Minute). Nach dem Neustart meldet die App „aktualisiert: alt → neu“.

Beim Beenden der App wird nie ungefragt installiert. Fehler beim Download oder bei der Installation
erscheinen im Dialog mit „Erneut versuchen“ und Link zur Download-Seite; schlägt nur die automatische
Suche fehl (kein Internet), gibt es keine Meldung, nur einen Vermerk in den Einstellungen. Protokoll:
`logs/updater.log` im Einstellungsordner (`%APPDATA%\ebbton` bzw. `~/Library/Application Support/ebbton`).

**Während einer laufenden oder pausierten Aufnahme wird weder gesucht, heruntergeladen noch installiert.**
Der Dialog öffnet sich dann nicht von selbst, die Knöpfe sind mit Hinweis gesperrt.

### Neue Version veröffentlichen

1. Im Ordner `app/` die Version erhöhen: `npm version patch --no-git-tag-version`
   (oder `minor` / `major`). Weil das Git-Repository eine Ebene höher liegt, legt
   `npm version` dort keinen Tag an.
2. Änderung committen und den Tag selbst setzen – er muss zur Version in
   `package.json` passen, denn veröffentlicht wird unter dieser Version:
   `git tag v1.2.3` und `git push --tags`.
3. Der Workflow `.github/workflows/release.yml` prüft, ob Tag und Version
   übereinstimmen, lässt die Tests laufen, legt einen Release-Entwurf an, baut
   die Windows-Version hinein und gibt das Release erst frei, wenn sie vollständig ist.
   **Mac-Releases sind vorerst abgeschaltet.** Wieder einschalten: auf GitHub unter
   *Settings → Secrets and variables → Actions → Variables* die Variable `MAC_RELEASE`
   mit dem Wert `true` anlegen; dann baut der Workflow auch die Mac-Version (ohne
   Zertifikat ad hoc signiert) und wartet mit der Freigabe auf beide. Ohne Mac-Release
   meldet eine installierte Mac-App bei „Jetzt nach Update suchen“ einen Fehler
   (`latest-mac.yml` fehlt); neue Mac-Versionen lokal mit `npm run dist:mac` bauen.

Der Windows-Installer lässt sich auf einem Mac mit Apple Silicon nur mit Rosetta
bauen (das NSIS-Werkzeug von electron-builder ist ein Intel-Programm); verlässlich
entsteht er im Workflow auf einem Windows-Rechner.

Da das Repository öffentlich ist, braucht niemand ein Zugriffstoken, um Updates
herunterzuladen – `electron-updater` liest öffentliche Releases ohne Anmeldung.
Ein `GH_TOKEN` ist nur beim Veröffentlichen selbst nötig (siehe oben), nicht
beim Herunterladen auf den Aufnahmerechnern.

## Besonderheiten unter macOS

Die App läuft auf macOS 13 (Ventura) und neuer (Vorgabe von Electron 44), sowohl auf Intel als auch auf Apple
Silicon. Ein paar Dinge unterscheiden sich:

- **Mikrofonfreigabe.** Beim ersten Start fragt macOS nach dem Zugriff auf den
  Audioeingang. Wird das abgelehnt, nimmt die App nichts auf. Nachträglich
  freigeben unter *Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon*.
- **Menüleiste.** Oben am Bildschirm liegt ein Menü mit den üblichen Kürzeln.
  Aufnahme starten und beenden geht dort mit `Cmd` + `R`, Abschnitt starten/beenden
  mit `Cmd` + `M`, der nächste Ablaufpunkt mit `Cmd` + `Alt` + `N`, Rückgängig mit
  `Cmd` + `Z`. Die Kürzel aus dem Fenster (`M`, `N`, `X`, Leertaste) funktionieren
  weiterhin.
- **Beenden mit `Cmd` + `Q`** fragt nach, solange eine Aufnahme läuft.

### Signierung und Notarisierung

Ohne Apple-Entwicklerzertifikat (99 $ im Jahr) lässt sich die App zwar bauen und
benutzen – beim ersten Öffnen blockiert Gatekeeper sie aber. Seit macOS 15 hilft
der frühere Rechtsklick → *Öffnen* nicht mehr: Nach dem ersten Startversuch unter
*Systemeinstellungen → Datenschutz & Sicherheit* auf **„Dennoch öffnen“** klicken.
Meldet macOS die App als „beschädigt“, entfernt
`xattr -dr com.apple.quarantine /Applications/Ebbton.app` die Sperre.

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
  wav.js         WAV/RF64 schreiben (eigener Thread), lesen, Cue-Marker (Abschnitte) eintragen
  mp3.js         MP3-Export eines Abschnitts
  id3.js         ID3-Tags (Titel, Interpret, Album, Jahr)
  churchtools.js ChurchTools-API
  netserver.js   WebSocket-Schnittstelle
  updater.js     Updates über GitHub Releases
  settings.js    Einstellungen, Token-Verschlüsselung
src/shared/      Von Hauptprozess und Oberfläche gemeinsam genutzt
  sections.js    Regeln für Abschnitte (Verschieben ohne Überlappung)
  roles.js       Zuordnung Dienst (ChurchTools) zu Programmpunkt
src/preload.js   Brücke zur Oberfläche
src/renderer/    Oberfläche
  capture.js     Audioerfassung (AudioWorklet)
  monitor.js     Mithören der laufenden Aufnahme
  waveform.js    Wellenform und Abschnittsmarken
  app.js         Bedienlogik
```

Audio wird in der Oberfläche erfasst, als Int16-Blöcke an den Hauptprozess
übergeben und von einem eigenen Schreib-Thread auf die Festplatte geschrieben (ein
langsames Laufwerk bremst so nie die Aufnahme; alle 10 Sekunden werden die Daten fest
auf die Platte gezwungen). Ab 4 GB (gut 6 Stunden) wird die Datei im laufenden Betrieb
zu **RF64**, der WAV-Erweiterung für große Dateien – es bleibt eine Datei, die gängige
Programme (Audacity, VLC, Reaper …) öffnen. Der Hauptprozess
berechnet Pegel und Wellenform-Spitzenwerte und führt die einzige gültige
Version des Zustands – Oberfläche, Netzwerk und Companion sehen alle dasselbe.

Tests: `npm test` im Ordner `app/` (Node-Testrunner, ohne Electron). Sie liegen in `test/` und
laufen bei jedem Push automatisch auf Windows und macOS (`.github/workflows/test.yml`).

## Sicherheitshinweis

Die Netzwerkschnittstelle ist für ein vertrauenswürdiges lokales Netz gedacht.
Die Verbindung ist unverschlüsselt; das Passwort verhindert versehentlichen
Zugriff, schützt aber nicht gegen einen Angreifer im selben Netz. Zusätzlich:
Webseiten im Browser dürfen nur mitlesen, nach 5 Fehlversuchen wird eine Adresse
für eine Minute gesperrt, und mit dem Mitlese-Passwort sind weder Dateipfade noch
Personennamen zu sehen.
