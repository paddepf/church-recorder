# Netzwerkschnittstelle

Der ChurchRecorder stellt im lokalen Netzwerk einen WebSocket-Server bereit.
Darüber lässt sich der Aufnahmestatus mitlesen (Dashboard) und die Aufnahme
steuern (Bitfocus Companion).

- Adresse: `ws://<rechner>:<port>/` – Standardport **8765**
- Zusätzlich: `GET http://<rechner>:<port>/health` liefert ohne Anmeldung
  `{"app":"church-recorder","protocol":1,"status":"recording"}` –
  praktisch für eine einfache Erreichbarkeitsprüfung im Dashboard.
- Alle Nachrichten sind JSON-Objekte mit einem Feld `type`.

## Anmeldung

Jede Verbindung muss sich innerhalb von 10 Sekunden anmelden, sonst wird sie
getrennt. Es gibt zwei Rollen:

| Rolle | Passwort aus | Rechte |
|---|---|---|
| `control` | „Passwort für Steuerung" | mitlesen und steuern |
| `monitor` | „Passwort nur zum Mitlesen" | nur mitlesen |

Ist kein Monitor-Passwort gesetzt, existiert die Rolle nicht.

```json
{ "type": "auth", "password": "geheim" }
```

Alternativ als Query-Parameter: `ws://host:8765/?password=geheim&role=monitor`

Antwort:

```json
{ "type": "auth", "ok": true, "role": "control" }
```

Wer sich mit dem Steuer-Passwort anmeldet, kann sich mit `"role": "monitor"`
freiwillig auf Mitlesen beschränken.

## Nachrichten vom Recorder

### `state` – vollständiger Zustand

Wird direkt nach der Anmeldung und bei jeder Änderung gesendet (max. 10×/s).

```json
{
  "type": "state",
  "payload": {
    "status": "recording",
    "service": { "id": 4711, "name": "Sonntagsgottesdienst", "date": "2026-09-06" },
    "duration": 1832.4,
    "startedAt": "2026-09-06T09:30:02.000Z",
    "sampleRate": 48000,
    "channels": 2,
    "levels": { "l": 0.42, "r": 0.39, "clip": false },
    "markers": [
      { "id": "mk_x1", "label": "Predigt", "category": "Verkündigung",
        "time": 1420.5, "placed": true, "source": "churchtools" }
    ],
    "pending": [
      { "id": "mk_x2", "label": "Segen", "placed": false, "source": "churchtools" }
    ],
    "segments": [
      { "id": "seg_mk_x1", "label": "Predigt", "start": 1420.5, "end": 1832.4, "markerId": "mk_x1" }
    ],
    "currentSegment": { "id": "seg_mk_x1", "label": "Predigt", "start": 1420.5, "end": 1832.4 },
    "wavPath": "C:\\Aufnahmen\\2026-09-06_0930_Sonntagsgottesdienst.wav",
    "transcriptCount": 42
  }
}
```

`status` ist einer von `idle`, `recording`, `paused`, `stopped`.
Alle Zeitangaben sind Sekunden seit Aufnahmebeginn.

### `levels` – Pegel

Getrennt vom Zustand und auf 5×/s gedrosselt, damit das Netz nicht geflutet wird.

```json
{ "type": "levels", "payload": { "l": 0.42, "r": 0.39, "clip": false, "duration": 1832.4 } }
```

`l` und `r` sind Spitzenwerte von 0 bis 1. `clip` bleibt nach einer
Übersteuerung zwei Sekunden lang `true`.

### `event` – Ereignisse

```json
{ "type": "event", "event": "recording.started", "payload": { "wavPath": "…" } }
```

Ereignisse: `recording.started`, `recording.stopped`, `export.finished`.

### Weitere

- `hello` – direkt beim Verbindungsaufbau, enthält `protocol`
- `pong` – Antwort auf `ping`
- `result` – Antwort auf einen Befehl
- `error` – mit `code` (`auth_failed`, `unauthorized`, `read_only`,
  `unknown_action`, `auth_timeout`, `bad_json`) und `message`

## Nachrichten an den Recorder

### `command` – nur mit Rolle `control`

```json
{ "type": "command", "id": 17, "action": "marker.add", "params": { "label": "Predigt" } }
```

| Aktion | Wirkung |
|---|---|
| `record.start` | Aufnahme starten |
| `record.stop` | Aufnahme beenden und speichern |
| `record.toggle` | Starten bzw. beenden |
| `record.pause` | Pausieren |
| `record.resume` | Fortsetzen |
| `marker.add` | Marker an der aktuellen Stelle setzen, optional `params.label` |
| `marker.next` | Nächsten offenen Ablaufpunkt hier beginnen lassen |

Antwort:

```json
{ "type": "result", "id": 17, "action": "marker.add", "ok": true, "marker": { "…": "…" } }
```

Das mitgesendete `id`-Feld kommt unverändert zurück und dient der Zuordnung.

### Weitere

- `{ "type": "get_state", "id": 3 }` – Zustand erneut anfordern
- `{ "type": "ping", "id": 3 }` – Verbindungstest

## Beispiel: Dashboard-Anbindung

```js
const ws = new WebSocket('ws://recorder.local:8765/');

ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', password: 'mitlesen' }));

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'state') {
    render(msg.payload.status, msg.payload.currentSegment?.label, msg.payload.duration);
  }
  if (msg.type === 'levels') {
    setMeters(msg.payload.l, msg.payload.r, msg.payload.clip);
  }
};
```

## Hinweise für den Betrieb

- Der Server ist für ein vertrauenswürdiges lokales Netz gedacht. Die
  Verbindung ist unverschlüsselt (`ws://`), das Passwort schützt vor
  versehentlichem Zugriff, nicht vor einem Angreifer im selben Netz.
- Ohne gesetztes Steuer-Passwort startet der Server nicht.
- Die Windows-Firewall fragt beim ersten Start nach einer Freigabe für den Port.
