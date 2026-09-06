'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const wav = require('./wav');
const settings = require('./settings');

const TARGET_RATE = 16000;

/**
 * Live-Transkription mit whisper.cpp – vollständig lokal.
 *
 * Läuft bewusst als Hilfsfunktion nebenher: Die Audioaufnahme selbst wird
 * niemals blockiert. Kommt die Transkription nicht hinterher, werden Blöcke
 * übersprungen und ein Hinweis gemeldet.
 */
class Transcriber extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.buffer = [];        // Float32-Blöcke bei 16 kHz mono
    this.bufferSamples = 0;
    this.chunkStartTime = 0; // Sekunden seit Aufnahmebeginn
    this.busy = false;
    this.skipped = 0;
    this.active = false;
    this.tmpDir = path.join(os.tmpdir(), 'church-recorder');
    try { fs.mkdirSync(this.tmpDir, { recursive: true }); } catch { /* Prüfung erfolgt beim Start */ }
  }

  /** Prüft, ob Binary und Modell vorhanden sind. */
  static check() {
    const cfg = settings.load();
    if (!cfg.transcriptionEnabled) return { ok: false, reason: 'disabled' };
    if (!cfg.whisperBinaryPath || !fs.existsSync(cfg.whisperBinaryPath)) {
      return { ok: false, reason: 'binary_missing', message: 'Das Whisper-Programm wurde nicht gefunden.' };
    }
    if (!cfg.whisperModelPath || !fs.existsSync(cfg.whisperModelPath)) {
      return { ok: false, reason: 'model_missing', message: 'Die Whisper-Modelldatei wurde nicht gefunden.' };
    }
    return { ok: true };
  }

  start(sampleRate, channels) {
    this.reset();
    const check = Transcriber.check();
    if (!check.ok) {
      this.active = false;
      this.emit('status', { active: false, ...check });
      return check;
    }
    this.sourceRate = sampleRate;
    this.channels = channels;
    this.active = true;
    this.emit('status', { active: true });
    return { ok: true };
  }

  stop() {
    this.active = false;
    if (this.bufferSamples > TARGET_RATE) this._flush();
    this.emit('status', { active: false });
  }

  /**
   * Nimmt denselben Int16-Block entgegen wie der WAV-Writer und wandelt ihn
   * in 16-kHz-Mono um (einfache Mittelwert-Dezimierung).
   */
  push(int16Buffer, startTime) {
    if (!this.active) return;
    const ch = this.channels;
    const ratio = this.sourceRate / TARGET_RATE;
    const frames = int16Buffer.length / (2 * ch);
    const outLength = Math.floor(frames / ratio);
    if (outLength <= 0) return;

    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const from = Math.floor(i * ratio);
      const to = Math.min(frames, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let f = from; f < to; f++) {
        let mono = 0;
        for (let c = 0; c < ch; c++) mono += int16Buffer.readInt16LE((f * ch + c) * 2);
        sum += mono / ch / 32768;
        count += 1;
      }
      out[i] = count ? sum / count : 0;
    }

    if (this.bufferSamples === 0) this.chunkStartTime = startTime;
    this.buffer.push(out);
    this.bufferSamples += out.length;

    const chunkSeconds = settings.get('transcriptionChunkSeconds') || 12;
    if (this.bufferSamples >= chunkSeconds * TARGET_RATE) this._flush();
  }

  _flush() {
    const samples = this._drain();
    if (!samples || samples.length < TARGET_RATE * 0.5) return;

    if (this.busy) {
      // Nicht hinterhergekommen – Block verwerfen statt Speicher zu füllen.
      this.skipped += 1;
      this.emit('status', { active: true, skipped: this.skipped, message: 'Transkription hinkt hinterher.' });
      return;
    }
    this._run(samples, this.chunkStartTimeOfDrain);
  }

  _drain() {
    if (this.buffer.length === 0) return null;
    const total = this.bufferSamples;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const part of this.buffer) {
      merged.set(part, offset);
      offset += part.length;
    }
    this.chunkStartTimeOfDrain = this.chunkStartTime;
    this.buffer = [];
    this.bufferSamples = 0;
    return merged;
  }

  async _run(samples, startTime) {
    const cfg = settings.load();
    this.busy = true;
    const stamp = Date.now();
    const wavPath = path.join(this.tmpDir, `chunk_${stamp}.wav`);
    const outBase = path.join(this.tmpDir, `chunk_${stamp}`);

    try {
      wav.writeMonoFile(wavPath, TARGET_RATE, samples);

      const args = [
        '-m', cfg.whisperModelPath,
        '-f', wavPath,
        '-l', cfg.whisperLanguage || 'de',
        '-t', String(cfg.transcriptionThreads || 4),
        '-nt',                 // keine Zeitstempel im Text
        '-otxt',
        '-of', outBase
      ];

      const text = await new Promise((resolve, reject) => {
        const proc = spawn(cfg.whisperBinaryPath, args, { windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => reject(new Error('Whisper konnte nicht gestartet werden: ' + err.message)));
        proc.on('close', (code) => {
          if (code !== 0) return reject(new Error('Whisper endete mit Fehler: ' + stderr.slice(-400)));
          try {
            resolve(fs.readFileSync(outBase + '.txt', 'utf8'));
          } catch (err) {
            reject(new Error('Transkript konnte nicht gelesen werden: ' + err.message));
          }
        });
        // Notbremse: hängende Prozesse beenden
        setTimeout(() => { try { proc.kill(); } catch { /* bereits beendet */ } }, 120000);
      });

      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean) {
        this.emit('segment', {
          start: startTime,
          end: startTime + samples.length / TARGET_RATE,
          text: clean
        });
      }
    } catch (err) {
      this.emit('failure', err.message);
      this.active = false;
      this.emit('status', { active: false, message: err.message });
    } finally {
      this.busy = false;
      for (const f of [wavPath, outBase + '.txt']) {
        try { fs.unlinkSync(f); } catch { /* Datei existiert evtl. nicht */ }
      }
    }
  }
}

module.exports = { Transcriber, TARGET_RATE };
