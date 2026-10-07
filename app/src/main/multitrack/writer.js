'use strict';

/**
 * Mehrspur-Schreiber: eine 24-Bit-Mono-WAV je Spur.
 *
 * - Bekommt die Blöcke so, wie sie vom Gerät kommen (Int32, verschachtelt über alle Kanäle des
 *   Geräts), und zerlegt sie in die gewählten Spuren. Aus Int32 werden die oberen drei Bytes (24 Bit).
 * - Gesammelt wird je etwa eine halbe Sekunde, dann wird jede Spur mit einem einzigen
 *   positionierten Schreibbefehl (pwrite) geschrieben. Die Schreibbefehle laufen asynchron im
 *   Thread-Pool von Node: Die Erfassung wartet nie auf die Platte.
 * - Kopf wie bei der Stereoaufnahme (`wav.buildHeader`, 80 Byte mit Platz für RF64), alle 2 s
 *   aktualisiert, `fdatasync` alle 10 s: Nach einem Absturz bleiben abspielbare Dateien.
 *
 * Ereignisse: 'error' ({message, code, file}), 'slow' (true/false).
 */

const fs = require('fs');
const { EventEmitter } = require('events');
const { buildHeader, HEADER_BYTES } = require('../wav');

const BYTES = 3;                               // 24 Bit
const STAGE_SECONDS = 0.5;                     // so viel Audio wird je Spur gesammelt
const SLOW_BYTES = 64 * 1024 * 1024;           // so viel ungeschriebenes Audio gilt als "Laufwerk zu langsam"
const HEADER_EVERY_MS = 2000;
const SYNC_EVERY_MS = 10000;

class MultiWavWriter extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.sampleRate
   * @param {number} o.deviceChannels Kanäle je Frame im Eingangsblock
   * @param {{channel:number, file:string}[]} o.tracks channel = Index im Eingangsblock (0-basiert)
   */
  constructor({ sampleRate, deviceChannels, tracks }) {
    super();
    if (!tracks.length) throw new Error('Keine Spur ausgewählt.');
    this.sampleRate = sampleRate;
    this.deviceChannels = deviceChannels;
    this.dataBytes = 0;            // je Spur übergeben
    this.pendingBytes = 0;         // übergeben, aber noch nicht bestätigt geschrieben (alle Spuren)
    this.closed = false;
    this.failed = false;
    this._slow = false;

    this.stageFrames = Math.max(1, Math.round(sampleRate * STAGE_SECONDS));
    this.staged = 0;

    // Alle Dateien synchron öffnen: Scheitert eine, wird keine angelegt und der Aufrufer merkt es sofort.
    this.tracks = [];
    try {
      for (const t of tracks) {
        if (t.channel < 0 || t.channel >= deviceChannels) throw new Error(`Kanal ${t.channel + 1} gibt es am Gerät nicht.`);
        const fd = fs.openSync(t.file, 'wx');
        this.tracks.push({ channel: t.channel, file: t.file, fd, stage: Buffer.alloc(this.stageFrames * BYTES) });
        const head = buildHeader('ds64', sampleRate, 1, 0, 24);
        fs.writeSync(fd, head, 0, head.length, 0);
      }
    } catch (err) {
      for (const t of this.tracks) {
        try { fs.closeSync(t.fd); fs.unlinkSync(t.file); } catch { /* egal */ }
      }
      throw err;
    }

    this._headerTimer = setInterval(() => this._writeHeaders(), HEADER_EVERY_MS);
    this._syncTimer = setInterval(() => this._sync(), SYNC_EVERY_MS);
  }

  get files() {
    return this.tracks.map((t) => t.file);
  }

  get frames() {
    return this.dataBytes / BYTES + this.staged;
  }

  get durationSeconds() {
    return this.frames / this.sampleRate;
  }

  /** @param {Buffer} buf Int32LE, verschachtelt mit `deviceChannels` Kanälen */
  write(buf) {
    if (this.closed || !buf || !buf.length) return;
    const frameBytes = this.deviceChannels * 4;
    const frames = Math.floor(buf.length / frameBytes);
    let f = 0;
    while (f < frames) {
      const n = Math.min(frames - f, this.stageFrames - this.staged);
      for (const t of this.tracks) {
        const stage = t.stage;
        let src = f * frameBytes + t.channel * 4 + 1;   // obere drei Bytes des Int32
        let dst = this.staged * BYTES;
        for (let i = 0; i < n; i++) {
          stage[dst] = buf[src];
          stage[dst + 1] = buf[src + 1];
          stage[dst + 2] = buf[src + 2];
          src += frameBytes;
          dst += BYTES;
        }
      }
      this.staged += n;
      f += n;
      if (this.staged === this.stageFrames) this._flush();
    }
  }

  /** Gesammeltes Audio an die Platte übergeben. */
  _flush() {
    if (!this.staged) return;
    const len = this.staged * BYTES;
    const pos = HEADER_BYTES + this.dataBytes;
    for (const t of this.tracks) {
      const data = t.stage.subarray(0, len);
      t.stage = Buffer.alloc(this.stageFrames * BYTES);   // der alte Puffer gehört jetzt dem Schreibbefehl
      if (t.failed) continue;
      this.pendingBytes += len;
      this._write(t, data, pos);
    }
    this.dataBytes += len;
    this.staged = 0;
    this._checkSlow();
  }

  _write(t, data, pos, done = 0) {
    fs.write(t.fd, data, done, data.length - done, pos + done, (err, n) => {
      if (err) {
        this.pendingBytes -= data.length - done;
        t.failed = true;
        this._fail({ message: err.message, code: err.code || null, file: t.file });
      } else if (done + n < data.length) {
        this.pendingBytes -= n;
        this._write(t, data, pos, done + n);
        return;
      } else {
        this.pendingBytes -= n;
      }
      this._checkSlow();
      this._checkDrained();
    });
  }

  _fail(err) {
    if (!this.failed) {
      this.failed = true;
      this.emit('error', err);
    }
  }

  _checkSlow() {
    const slow = this.pendingBytes > SLOW_BYTES;
    if (slow !== this._slow) {
      this._slow = slow;
      this.emit('slow', slow);
    }
  }

  _writeHeaders() {
    const head = buildHeader('ds64', this.sampleRate, 1, this.dataBytes, 24);
    for (const t of this.tracks) {
      if (t.failed) continue;
      try { fs.writeSync(t.fd, head, 0, head.length, 0); } catch (err) {
        t.failed = true;
        this._fail({ message: err.message, code: err.code || null, file: t.file });
      }
    }
  }

  _sync() {
    for (const t of this.tracks) if (!t.failed) fs.fdatasync(t.fd, () => {});
  }

  _checkDrained() {
    if (this._drained && this.pendingBytes === 0) {
      const resolve = this._drained;
      this._drained = null;
      resolve();
    }
  }

  /** Schließt alle Dateien; das Versprechen erfüllt sich, wenn alles auf der Platte ist. */
  close() {
    if (this._closing) return this._closing;
    this.closed = true;
    clearInterval(this._headerTimer);
    clearInterval(this._syncTimer);
    this._flush();
    this._closing = new Promise((resolve) => {
      this._drained = resolve;
      this._checkDrained();
    }).then(() => {
      this._writeHeaders();
      for (const t of this.tracks) {
        try { fs.fsyncSync(t.fd); } catch { /* nicht jedes Dateisystem kann das */ }
        try { fs.closeSync(t.fd); } catch { /* bereits zu */ }
      }
      return { frames: this.dataBytes / BYTES, failed: this.failed };
    });
    return this._closing;
  }
}

module.exports = { MultiWavWriter, BYTES };
