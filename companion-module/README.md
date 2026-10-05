# Companion-Modul: ChurchRecorder

Steuert ChurchRecorder aus Bitfocus Companion heraus und zeigt den
Aufnahmestatus auf den Tasten an.

## Einbinden

Companion lädt Module aus einem frei wählbaren Ordner für Entwicklermodule:

1. In Companion unter **Settings → Developer modules path** einen Ordner
   auswählen.
2. Diesen Ordner hier hineinkopieren und die Abhängigkeiten installieren:

```bash
npm install
```

3. Companion neu starten. Das Modul erscheint unter **Connections** als
   „ChurchRecorder".

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

## Feedbacks

| Feedback | Wirkung |
|---|---|
| Aufnahme läuft | Taste wird rot |
| Aufnahme pausiert | Taste wird orange |
| Es gibt offene Programmpunkte | Taste wird blau |
| Eingang übersteuert | Taste wird gelb |

## Variablen

`status`, `timecode`, `service_name`, `current_item`, `next_item`,
`marker_count`, `pending_count`, `level_left`, `level_right`, `clipping`

Beispiel für eine Tastenbeschriftung:

```
REC $(churchrecorder:timecode)
$(churchrecorder:current_item)
```

## Mitgelieferte Presets

Unter **Aufnahme**, **Abschnitte**, **Ablaufplan** und **Anzeige** liegen fertige
Tasten, unter anderem eine Aufnahmetaste mit Laufzeit, eine Taste „Predigt" und
eine Weiter-Taste, die den nächsten Programmpunkt anzeigt.
