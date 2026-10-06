# Companion-Modul: ChurchRecorder

Steuert ChurchRecorder aus Bitfocus Companion heraus und zeigt den
Aufnahmestatus auf den Tasten an.

## Einbinden

Companion lädt Module aus einem frei wählbaren Ordner für Entwicklermodule:

1. Im **Startfenster von Companion** (dem kleinen Launcher-Fenster, nicht in der
   Weboberfläche) über das Zahnrad bzw. die erweiterten Einstellungen den Ordner für
   **Developer Modules** auswählen.
2. Diesen Ordner hier hineinkopieren und die Abhängigkeiten installieren:

```bash
npm install
```

3. Companion neu starten. Das Modul erscheint unter **Connections** als
   „ChurchRecorder“.

Für die Weitergabe an andere Rechner lässt sich mit
`npx companion-module-build` ein Paket erzeugen.

## Konfiguration

| Feld | Bedeutung |
|---|---|
| Adresse | IP oder Hostname des Aufnahmerechners |
| Port | Standard 8765, siehe Recorder-Einstellungen |
| Passwort | das Passwort für die **Steuerung** (nicht das Mitlese-Passwort) |

Das Modul verbindet sich selbstständig neu, wenn die App noch nicht läuft oder
die Verbindung abbricht.

## Aktionen

| Aktion | Wirkung |
|---|---|
| Aufnahme starten | startet die Aufnahme |
| Aufnahme beenden | beendet und speichert |
| Aufnahme starten/beenden | eine Taste für beides |
| Aufnahme pausieren / fortsetzen / Pause umschalten | Pause steuern |
| Abschnitt starten / beenden | erster Druck setzt den Anfang eines Abschnitts (Bezeichnung frei wählbar, Variablen erlaubt), der nächste Druck das Ende |
| Nächster Programmpunkt beginnt hier | beendet den laufenden Abschnitt und beginnt den nächsten offenen Ablaufpunkt des ChurchTools-Plans |
| Schnitt starten / beenden | erster Druck beginnt einen Schnitt, der nächste beendet ihn; die Stelle fehlt in den MP3-Exporten |
| Rückgängig / Wiederholen | letzte Änderung an Abschnitten oder Schnitten zurücknehmen bzw. wiederholen |
| Vorlage für Programmpunkte laden | lädt eine Vorlage (Name, leer = Standardvorlage) und ersetzt die offenen Punkte |

## Verbindung

- Das Modul meldet sich mit dem **Steuer-Passwort** an. Wird stattdessen das Passwort
  „nur zum Mitlesen“ eingetragen, zeigt die Verbindung einen Hinweis: Status und
  Variablen kommen an, die Tasten steuern aber nichts.
- Bei falschem Passwort versucht das Modul es nicht endlos weiter, sondern erst wieder,
  wenn die Einstellungen der Verbindung geändert werden. Nach 5 Fehlversuchen sperrt der
  Recorder die Adresse für eine Minute.
- Das Passwortfeld wird verdeckt angezeigt. Passt die Protokollversion von Modul und App nicht
  zusammen, steht eine Warnung im Log.
- „Aufnahme starten/beenden“ meldet einen Fehler ins Log, wenn die Aufnahme am Rechner nicht
  wirklich startet bzw. endet (z. B. Eingang nicht verfügbar).
- Alle 10 Sekunden prüft das Modul, ob der Recorder noch antwortet. Fällt der
  Aufnahmerechner weg, wird neu verbunden und die Tasten zeigen keinen veralteten
  Zustand (z. B. „Aufnahme läuft“) mehr an.

## Feedbacks

| Feedback | Wirkung |
|---|---|
| Aufnahme läuft | Taste wird rot |
| Aufnahme pausiert | Taste wird orange |
| Es gibt offene Programmpunkte | Taste wird blau |
| Eingang übersteuert | Taste wird gelb |
| Aufnahme kann nicht gespeichert werden | Taste wird rot: Schreibfehler (z. B. Platte voll) oder Laufwerk zu langsam |
| Eingang leise oder ausgefallen | Taste wird rot: seit über 20 s kaum Pegel oder der Eingang wird neu verbunden |
| Speicherplatz wird knapp | Taste wird orange (unter 3 Stunden Platz) |
| Speicherplatz fast voll | Taste wird rot (unter 30 Minuten) |
| Schnitt läuft gerade | Taste wird violett |

## Variablen

`status`, `timecode`, `service_name`, `current_item`, `next_item`,
`marker_count`, `pending_count`, `level_left`, `level_right`, `clipping`,
`input_status` (ok / leise / ausgefallen), `write_status` (ok / langsam / Fehler), `disk_free` (GB),
`disk_hours`, `cut_open`

Beispiel für eine Tastenbeschriftung:

```
REC $(churchrecorder:timecode)
$(churchrecorder:current_item)
```

## Mitgelieferte Presets

Unter **Aufnahme**, **Abschnitte**, **Ablaufplan** und **Anzeige** liegen fertige
Tasten, unter anderem eine Aufnahmetaste mit Laufzeit, eine Taste „Predigt“ und
eine Weiter-Taste, die den nächsten Programmpunkt anzeigt.
