'use strict';

/**
 * Technik-Test der Mehrspuraufnahme, läuft statt der normalen App, wenn die Umgebungsvariable
 * `EBBTON_MT_PROBE` gesetzt ist – auch mit der installierten App (prüft so Prozess, audify und
 * ASIO genau in der Form, in der sie ausgeliefert werden).
 *
 *   EBBTON_MT_PROBE=list       nur Geräte auflisten
 *   EBBTON_MT_PROBE=auto       Gerät mit den meisten Eingängen aufnehmen
 *   EBBTON_MT_PROBE=<id>       dieses Gerät aufnehmen
 *   EBBTON_MT_PROBE=simulate   simuliertes Pult aufnehmen
 *   EBBTON_MT_SECONDS=10       Dauer (Standard 10 s)
 *
 * Ergebnis: Protokoll in `userData/logs/mt-probe.log` und ein Dialog mit der Zusammenfassung.
 * Die Testaufnahme bleibt im Temp-Ordner liegen (Pfad im Protokoll).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { MultitrackManager } = require('./manager');

function run() {
  const mode = String(process.env.EBBTON_MT_PROBE).trim();
  const seconds = Number(process.env.EBBTON_MT_SECONDS) || 10;
  const lines = [];
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    lines.push(line);
    console.log(line);
  };

  app.whenReady().then(async () => {
    const logDir = path.join(app.getPath('userData'), 'logs');
    const logFile = path.join(logDir, 'mt-probe.log');
    const m = new MultitrackManager();
    let ok = false;
    try {
      log(`Ebbton ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform} ${process.arch} · gepackt: ${app.isPackaged}`);
      const simulate = mode === 'simulate';
      const { api, devices } = await m.devices({ simulate });
      log(`Schnittstelle: ${api}`);
      for (const d of devices) log(`  Gerät ${d.id}: ${d.name} · ${d.inputs} ein / ${d.outputs} aus · ${d.preferredSampleRate} Hz · ${d.sampleRates.join(', ')}`);
      if (mode === 'list') {
        ok = true;
        return;
      }
      const device = /^\d+$/.test(mode) ? devices.find((d) => d.id === Number(mode))
        : devices.filter((d) => d.inputs > 0).sort((a, b) => b.inputs - a.inputs)[0];
      if (!device) throw new Error('Kein passendes Gerät gefunden.');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebbton-mt-probe-'));
      const tracks = Array.from({ length: device.inputs }, (_, c) => ({ channel: c, file: path.join(dir, `${String(c + 1).padStart(2, '0')}.wav`) }));
      const max = new Array(device.inputs).fill(0);
      const clips = new Array(device.inputs).fill(false);
      let levelCount = 0;
      m.on('levels', (l) => {
        levelCount++;
        l.peaks.forEach((p, i) => { if (p > max[i]) max[i] = p; });
        l.clips.forEach((c, i) => { if (c) clips[i] = true; });
      });
      for (const ev of ['stall', 'gap', 'reopen', 'device-error', 'device-warning', 'write-error', 'slow', 'exit']) m.on(ev, (d) => log(`Ereignis ${ev}:`, d || ''));

      log(`Aufnahme von „${device.name}“, ${device.inputs} Spuren, ${seconds} s → ${dir}`);
      const t0 = Date.now();
      const info = await m.start({ simulate, deviceId: device.id, tracks });
      log('Gestartet:', info);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const res = await m.stop();
      const wall = (Date.now() - t0) / 1000;
      log(`Beendet: ${res.seconds.toFixed(3)} s Audio in ${wall.toFixed(3)} s Uhrzeit · ${levelCount} Pegelmeldungen · Lücken: ${res.gaps.length} · Schreibfehler: ${res.failed}`);
      const sizes = new Set(res.files.map((f) => fs.statSync(f).size));
      log(`Dateien: ${res.files.length}, Größe ${[...sizes].join('/')} Byte${sizes.size === 1 ? ' (alle gleich)' : ' (UNTERSCHIEDLICH)'}`);
      log('Spitzenpegel je Kanal (dBFS):');
      for (let c = 0; c < max.length; c += 8) {
        log('  ' + max.slice(c, c + 8).map((p, i) => `${String(c + i + 1).padStart(2)}: ${p > 0 ? (20 * Math.log10(p)).toFixed(1).padStart(6) : '  -inf'}${clips[c + i] ? '!' : ' '}`).join('  '));
      }
      ok = res.gaps.length === 0 && !res.failed && sizes.size === 1 && res.seconds > seconds * 0.9;
      log(ok ? 'ERGEBNIS: in Ordnung' : 'ERGEBNIS: Auffälligkeiten, siehe oben');
    } catch (err) {
      log(`FEHLER: ${err.stack || err.message}`);
    } finally {
      try {
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(logFile, lines.join('\n') + '\n');
      } catch { /* egal */ }
      m.dispose();
      if (process.env.EBBTON_MT_QUIET) {
        app.exit(ok ? 0 : 1);
      } else {
        await dialog.showMessageBox({ type: ok ? 'info' : 'warning', title: 'Ebbton – Mehrspur-Test', message: ok ? 'Mehrspur-Test in Ordnung' : 'Mehrspur-Test mit Auffälligkeiten', detail: `${lines.slice(-14).join('\n')}\n\nProtokoll: ${logFile}` });
        app.exit(ok ? 0 : 1);
      }
    }
  });
}

module.exports = { run };
