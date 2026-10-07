'use strict';

/**
 * Mehrspur-Engine: öffnet das Gerät (unter Windows per ASIO), nimmt die gewählten Kanäle auf,
 * meldet Pegel und erkennt Aussetzer. Läuft im eigenen Prozess (siehe `host.js`), damit weder
 * der Hauptprozess noch die Oberfläche die Aufnahme ausbremsen.
 *
 * Gerät: `audify` (RtAudio). Unter Windows ASIO (nur dort kommen alle 32 Kanäle der DN32-USB an),
 * sonst die Standard-Schnittstelle des Systems. `simulate` nimmt stattdessen das nachgebaute Pult.
 * Der Strom wird mit Ausgängen geöffnet, wenn das Gerät welche hat: ASIO lässt meist nur einen
 * Strom je Gerät zu, das spätere Zurückspielen muss also über denselben Strom laufen.
 *
 * Aussetzer: audify meldet Überläufe des Treibers nicht. Deshalb zwei eigene Prüfungen:
 * - Kommt 1 s lang kein Block, gilt der Eingang als hängend ('stall'); nach 3 s wird das Gerät
 *   neu geöffnet (wiederholt, bis es klappt), geschrieben wird in dieselben Dateien weiter.
 *   Kommt wieder Audio, folgt 'gap' mit Stelle und Länge.
 * - Fehlen gegenüber der Uhr dauerhaft mehr als 0,25 s Audio (über ein 5-s-Fenster, damit
 *   Uhrendrift und verspätete Blöcke nicht zählen), folgt ebenfalls 'gap'.
 *
 * Ereignisse: 'levels' ({peaks, clips, buckets, seconds}), 'stall' ({at}), 'gap' ({at, seconds}), 'reopen' ({ok, error}),
 * 'device-error' / 'device-warning' ({type, message}), 'write-error', 'slow'.
 */

const { EventEmitter } = require('events');
const { MultiWavWriter } = require('./writer');
const { SimulatedAudio, SIM_DEVICE_ID } = require('./simulator');

const FORMAT_SINT32 = 0x8;
const LEVEL_EVERY_MS = 50;
const WATCH_EVERY_MS = 250;
const STALL_MS = 1000;
const REOPEN_AFTER_MS = 3000;
const GAP_MIN_SECONDS = 0.25;
const DRIFT_WINDOW_MS = 5000;
const CLIP = 2147483647 * 0.999;   // etwa -0,01 dBFS
const DEFAULT_FRAME_SIZE = 512;
const BUCKET_MS = 50;              // Wellenform: ein Spitzenwert je 50 ms (wie PEAK_BUCKET_MS der Session)
const ERROR_DEBUG_WARNING = 1;     // RtAudioErrorType: 0 WARNING, 1 DEBUG_WARNING, ab 2 Fehler

let audify = null;
function loadAudify() {
  if (!audify) audify = require('audify');
  return audify;
}

/** Erzeugt die Geräte-Schnittstelle. Windows: ASIO, sonst Systemstandard. */
function defaultBackend(simulate) {
  if (simulate) return new SimulatedAudio();
  const { RtAudio, RtAudioApi } = loadAudify();
  return new RtAudio(process.platform === 'win32' ? RtAudioApi.WINDOWS_ASIO : RtAudioApi.UNSPECIFIED);
}

class MultitrackEngine extends EventEmitter {
  /** @param {{createBackend?: (simulate:boolean)=>object, now?: ()=>number}} [o] */
  constructor({ createBackend = defaultBackend, now = () => performance.now() } = {}) {
    super();
    this.createBackend = createBackend;
    this.now = now;
    this.backend = null;
    this.writer = null;
    this.running = false;
  }

  /** Geräte der Schnittstelle (bzw. das simulierte Pult). */
  devices({ simulate = false } = {}) {
    const b = this.running && !!this.opts.simulate === simulate ? this.backend : this.createBackend(simulate);
    return {
      api: b.getApi(),
      devices: b.getDevices().map((d) => ({
        id: d.id,
        name: d.name,
        inputs: d.inputChannels,
        outputs: d.outputChannels,
        sampleRates: d.sampleRates,
        preferredSampleRate: d.preferredSampleRate
      }))
    };
  }

  /**
   * Startet die Aufnahme.
   * @param {object} o
   * @param {number} o.deviceId
   * @param {number} [o.sampleRate] Standard: bevorzugte Rate des Geräts
   * @param {number} [o.frameSize] 0 = Puffergröße des Treibers (bei ASIO so gewollt)
   * @param {{channel:number, file:string}[]} o.tracks
   * @param {boolean} [o.simulate]
   * @param {boolean} [o.append] an die vorhandenen Spurdateien anhängen
   */
  start(o) {
    if (this.running) throw new Error('Mehrspuraufnahme läuft bereits.');
    const backend = this.createBackend(!!o.simulate);
    const device = backend.getDevices().find((d) => d.id === o.deviceId);
    if (!device) throw new Error('Das Audiogerät wurde nicht gefunden.');
    if (!device.inputChannels) throw new Error(`„${device.name}“ hat keine Eingänge.`);
    const sampleRate = o.sampleRate || device.preferredSampleRate || 48000;

    this.opts = { ...o, sampleRate };
    this.device = device;
    this.inputs = device.inputChannels;
    this.outputs = device.outputChannels;
    this.backend = backend;

    // Zuerst die Dateien: Scheitert das, wird das Gerät gar nicht erst geöffnet.
    this.writer = new MultiWavWriter({ sampleRate, deviceChannels: this.inputs, tracks: o.tracks, append: !!o.append });
    this.writer.on('error', (e) => this.emit('write-error', e));
    this.writer.on('slow', (s) => this.emit('slow', s));

    try {
      this.frameSize = this._open();
    } catch (err) {
      this.writer.close();
      this.writer = null;
      this.backend = null;
      throw err;
    }

    this.running = true;
    this.paused = false;
    this.framesIn = 0;
    this.gaps = [];
    this.peaks = new Float64Array(this.inputs);
    this.clips = new Uint8Array(this.inputs);
    this.armed = Int32Array.from(o.tracks.map((t) => t.channel));
    this.bucketSize = Math.round((sampleRate * BUCKET_MS) / 1000);
    this.bucketAcc = 0;
    this.bucketFill = 0;
    this.buckets = [];
    this.stalledAt = null;
    this.lastChunkAt = this.now();
    this.startedAt = this.lastChunkAt;
    this.history = [];
    this._levelTimer = setInterval(() => this._emitLevels(), LEVEL_EVERY_MS);
    this._watchTimer = setInterval(() => this._watch(), WATCH_EVERY_MS);
    return {
      device: device.name, api: backend.getApi(), sampleRate, frameSize: this.frameSize,
      inputs: this.inputs, outputs: this.outputs, seconds: this.writer.durationSeconds
    };
  }

  _open() {
    const b = this.backend;
    const input = { deviceId: this.device.id, nChannels: this.inputs, firstChannel: 0 };
    const output = this.outputs ? { deviceId: this.device.id, nChannels: this.outputs, firstChannel: 0 } : null;
    // ASIO: 0 = Puffergröße aus dem Treiber-Panel. Andere Schnittstellen nähmen sonst winzige Puffer (CoreAudio: 15 Frames).
    const frameSize = this.opts.frameSize || (process.platform === 'win32' ? 0 : DEFAULT_FRAME_SIZE);
    const actual = b.openStream(output, input, FORMAT_SINT32, this.opts.sampleRate, frameSize, 'Ebbton',
      (buf) => this._onInput(buf), null, 0,
      (type, message) => {
        this.emit(type > ERROR_DEBUG_WARNING ? 'device-error' : 'device-warning', { type, message });
      });
    try {
      b.start();
    } catch (err) {
      this._close(b);
      throw err;
    }
    return actual;
  }

  _onInput(buf) {
    if (!this.running) return;
    const t = this.now();
    this.lastChunkAt = t;
    if (this.stalledAt != null) {
      const seconds = (t - this.stalledAt.time) / 1000;
      this.gaps.push({ at: this.stalledAt.at, seconds, kind: 'stall' });
      this.emit('gap', { at: this.stalledAt.at, seconds });
      this.stalledAt = null;
      this.lastReopen = null;
      this.history = [];
      this._resetClock(t);
    }
    // In der Pause läuft das Gerät weiter (Pegel, Wächter), geschrieben wird nicht.
    if (!this.paused) this.writer.write(buf);
    this.framesIn += buf.length / (this.inputs * 4);
    this._measure(buf);
  }

  /**
   * Spitzenpegel je Kanal seit der letzten Meldung; außerhalb der Pause zusätzlich die Wellenform
   * (Spitzenwert über alle aufgenommenen Spuren je 50 ms, 0..255 wie bei der Stereoaufnahme).
   */
  _measure(buf) {
    const ch = this.inputs;
    const view = buf.byteOffset % 4 === 0
      ? new Int32Array(buf.buffer, buf.byteOffset, buf.length >> 2)
      : new Int32Array(Uint8Array.from(buf).buffer);
    const frames = Math.floor(view.length / ch);
    const { peaks, clips, armed } = this;
    const wave = !this.paused;
    for (let f = 0; f < frames; f++) {
      const base = f * ch;
      for (let c = 0; c < ch; c++) {
        let v = view[base + c];
        if (v < 0) v = -v;
        if (v > peaks[c]) peaks[c] = v;
        if (v >= CLIP) clips[c] = 1;
      }
      if (!wave) continue;
      for (let a = 0; a < armed.length; a++) {
        let v = view[base + armed[a]];
        if (v < 0) v = -v;
        if (v > this.bucketAcc) this.bucketAcc = v;
      }
      if (++this.bucketFill >= this.bucketSize) {
        this.buckets.push(Math.min(255, Math.round((this.bucketAcc / 2147483648) * 255)));
        this.bucketAcc = 0;
        this.bucketFill = 0;
      }
    }
  }

  _emitLevels() {
    this.emit('levels', {
      peaks: Array.from(this.peaks, (p) => Math.round((p / 2147483648) * 10000) / 10000),
      clips: Array.from(this.clips, Boolean),
      buckets: this.buckets,
      seconds: this.seconds
    });
    this.peaks.fill(0);
    this.clips.fill(0);
    this.buckets = [];
  }

  /** Pause: Gerät bleibt offen, es wird nur nicht geschrieben. */
  pause() {
    if (!this.running) return false;
    this.paused = true;
    this.bucketAcc = 0;
    this.bucketFill = 0;
    return true;
  }

  resume() {
    if (!this.running) return false;
    this.paused = false;
    return true;
  }

  /** Aufgenommene Sekunden (je Spur). */
  get seconds() {
    return this.writer ? this.writer.durationSeconds : 0;
  }

  _resetClock(t) {
    this.startedAt = t;
    this.framesAtStart = this.framesIn;
  }

  _watch() {
    const t = this.now();
    if (t - this.lastChunkAt > STALL_MS) {
      if (this.stalledAt == null) {
        this.stalledAt = { time: this.lastChunkAt, at: this.seconds };
        this.emit('stall', { at: this.seconds });
      }
      if (t - (this.lastReopen || this.stalledAt.time) > REOPEN_AFTER_MS) this._reopen(t);
      return;
    }
    // Fehlbetrag gegenüber der Uhr, über ein Fenster beobachtet.
    const expected = ((t - this.startedAt) / 1000) * this.opts.sampleRate;
    const deficit = expected - (this.framesIn - (this.framesAtStart || 0));
    this.history.push({ t, deficit });
    while (this.history.length && t - this.history[0].t > DRIFT_WINDOW_MS + 1000) this.history.shift();
    if (t - this.history[0].t < DRIFT_WINDOW_MS) return;
    // Kleinster Fehlbetrag der letzten Sekunde gegen den kleinsten am Fensteranfang: verspätete Blöcke zählen so nicht.
    const recent = Math.min(...this.history.filter((h) => t - h.t <= 1000).map((h) => h.deficit));
    const old = Math.min(...this.history.filter((h) => h.t - this.history[0].t <= 1000).map((h) => h.deficit));
    const missing = (recent - old) / this.opts.sampleRate;
    if (missing > GAP_MIN_SECONDS) {
      this.gaps.push({ at: this.seconds, seconds: missing, kind: 'drop' });
      this.emit('gap', { at: this.seconds, seconds: missing });
      this.history = [];
      this._resetClock(t);
    }
  }

  _reopen(t) {
    this.lastReopen = t;
    this._close(this.backend);
    try {
      // Bei ASIO kann ein neues Objekt nötig sein, wenn der Treiber weg war (Pult aus und wieder an).
      this.backend = this.createBackend(!!this.opts.simulate);
      const device = this.backend.getDevices().find((d) => d.name === this.device.name);
      if (!device) throw new Error(`„${this.device.name}“ ist nicht verfügbar.`);
      if (device.inputChannels !== this.inputs) throw new Error(`„${device.name}“ meldet jetzt ${device.inputChannels} statt ${this.inputs} Eingänge.`);
      this.device = device;
      this.frameSize = this._open();
      this.emit('reopen', { ok: true });
    } catch (err) {
      this.emit('reopen', { ok: false, error: err.message });
    }
  }

  _close(b) {
    try { if (b.isStreamRunning()) b.stop(); } catch { /* egal */ }
    try { if (b.isStreamOpen()) b.closeStream(); } catch { /* egal */ }
  }

  /** Beendet die Aufnahme; das Versprechen erfüllt sich, wenn alles auf der Platte ist. */
  async stop() {
    if (!this.running) return null;
    this.running = false;
    clearInterval(this._levelTimer);
    clearInterval(this._watchTimer);
    this._close(this.backend);
    const writer = this.writer;
    this.writer = null;
    const result = await writer.close();
    return { ...result, seconds: result.frames / this.opts.sampleRate, files: writer.files, gaps: this.gaps };
  }
}

module.exports = { MultitrackEngine, SIM_DEVICE_ID };
