# Companion-Modul: Ebbton

Steuert Ebbton aus Bitfocus Companion heraus und zeigt den
Aufnahmestatus auf den Tasten an.

## Voraussetzung

**Companion ab 5.0.** Das Modul nutzt die Modul-API 2.1 (`@companion-module/base` 2.1). Companion 4.x und
älter laden es nicht; dafür bräuchte es den Stand vor Version 2.0.0 des Moduls (API 1.11, Git-Verlauf).
API 2.2 (Companion 5.1) wird bewusst noch nicht genutzt, damit das Modul auch auf 5.0.x läuft.

## Installieren

Paket bauen (auf einem Rechner mit Node 22 oder neuer):

```bash
npm install
npm run package      # erzeugt ebbton-<version>.tgz
```

In Companion unter **Modules** → **Import module package** die `.tgz`-Datei wählen, danach unter
**Connections** eine Verbindung „Ebbton“ anlegen. Das Paket enthält alles gebündelt, auf dem
Companion-Rechner ist kein `npm install` nötig.

Zum Entwickeln kann Companion den Ordner auch direkt laden: im Startfenster von Companion (nicht in der
Weboberfläche) den Ordner für **Developer Modules** wählen, diesen Ordner hineinkopieren, `npm install`
ausführen und Companion neu starten.

## Konfiguration

| Feld | Bedeutung |
|---|---|
| Adresse | IP oder Hostname des Aufnahmerechners |
| Port | Standard 8765, siehe Recorder-Einstellungen |
| Passwort | das Passwort für die **Steuerung** (nicht das Mitlese-Passwort); liegt im Secrets-Speicher von Companion, nicht in der exportierten Konfiguration |

Das Modul verbindet sich selbstständig neu, wenn die App noch nicht läuft oder
die Verbindung abbricht.

## Aktionen

| Aktion | Wirkung |
|---|---|
| Aufnahme starten | startet die Aufnahme |
| Aufnahme beenden | beendet und speichert |
| Aufnahme starten/beenden | eine Taste für beides |
| Aufnahme pausieren / fortsetzen / Pause umschalten | Pause steuern |
| Abschnitt starten / beenden | erster Druck setzt den Anfang eines Abschnitts (Bezeichnung frei wählbar, Variablen und Ausdrücke erlaubt – Companion setzt sie selbst ein), der nächste Druck das Ende |
| Nächster Programmpunkt beginnt hier | beendet den laufenden Abschnitt und beginnt den nächsten offenen Ablaufpunkt des ChurchTools-Plans |
| Schnitt starten / beenden | erster Druck beginnt einen Schnitt, der nächste beendet ihn; die Stelle fehlt in den MP3-Exporten |
| Rückgängig / Wiederholen | letzte Änderung an Abschnitten oder Schnitten zurücknehmen bzw. wiederholen |
| Vorlage für Programmpunkte laden | lädt eine Vorlage (Name, leer = Standardvorlage) und ersetzt die offenen Punkte |
| Aufnahmeart wählen (Stereo / Mehrspur) | Umschalten, Stereo oder Mehrspur – gilt für die nächste Aufnahme; während einer Aufnahme lehnt Ebbton ab. Das Routing am Mischpult muss man selbst passend umstellen |

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
| Routing am Mischpult passt nicht zur Aufnahmeart | Taste wird rot: z. B. Mehrspur eingestellt, die USB-Ausgänge liefern aber die Stereo-Matrix (oder umgekehrt); „unbekannt“ (Pult nicht erreichbar) löst nicht aus |
| Aufnahmeart ist Mehrspur | Taste wird blau |

## Variablen

`status`, `timecode`, `service_name`, `current_item`, `next_item`,
`marker_count`, `pending_count`, `level_left`, `level_right`, `clipping`,
`input_status` (ok / leise / ausgefallen), `write_status` (ok / langsam / Fehler), `disk_free` (GB),
`disk_hours`, `cut_open`, `recording_mode` (Stereo / Mehrspur), `routing_status` (ok / falsch / unbekannt / -;
„-“ = keine Pult-Verbindung in Ebbton eingerichtet)

Beispiel für eine Tastenbeschriftung:

```
REC $(ebbton:timecode)
$(ebbton:current_item)
```

## Mitgelieferte Presets

Unter **Aufnahme**, **Abschnitte**, **Ablaufplan** und **Anzeige** liegen fertige
Tasten, unter anderem eine Aufnahmetaste mit Laufzeit, eine Taste „Predigt“ und
eine Weiter-Taste, die den nächsten Programmpunkt anzeigt.

Seit 2.1.0: **Aufnahmeart umschalten** (unter *Aufnahme*) zeigt Aufnahmeart und Routing-Status, wird blau bei
Mehrspur und rot, wenn das Routing am Pult nicht passt; ein Druck schaltet um. Die Anzeige-Taste **Eingang und
Speicher** warnt jetzt auch bei falschem Routing. Bereits platzierte Tasten übernehmen geänderte Presets nicht –
dort die Rückmeldung „Routing am Mischpult passt nicht …“ von Hand hinzufügen oder die Taste neu aus dem Preset ziehen.
