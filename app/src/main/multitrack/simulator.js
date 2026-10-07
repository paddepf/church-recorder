'use strict';

/**
 * Nachgebautes 32-Kanal-Gerät mit derselben Schnittstelle wie `RtAudio` aus audify (soweit Ebbton
 * sie nutzt). Zum Entwickeln auf dem Mac und für die Tests – ohne Pult und ohne ASIO.
 *
 * Kanal k erzeugt einen Sinuston, jeder achte Kanal ist stumm, Kanal 32 übersteuert.
 * `stall(ms)` lässt die Blöcke eine Zeit lang ausbleiben (wie ein hängender Treiber).
 */

const SIM_DEVICE_ID = 9001;

class SimulatedAudio {
  constructor({ channels = 32, name = 'Simuliertes Pult (32 Kanäle)' } = {}) {
    this.channels = channels;
    this.name = name;
    this.running = false;
    this.open = false;
    this._stallUntil = 0;
  }

  getApi() { return 'Simulation'; }

  getDevices() {
    return [{
      id: SIM_DEVICE_ID,
      name: this.name,
      inputChannels: this.channels,
      outputChannels: this.channels,
      duplexChannels: this.channels,
      isDefaultInput: 1,
      isDefaultOutput: 1,
      sampleRates: [44100, 48000],
      preferredSampleRate: 48000,
      nativeFormats: 0x8
    }];
  }

  openStream(output, input, format, sampleRate, frameSize, name, inputCallback, frameOutputCallback, flags, errorCallback) {
    if (!input || input.deviceId !== SIM_DEVICE_ID) throw new Error('Simulation: unbekanntes Gerät');
    if (input.nChannels + (input.firstChannel || 0) > this.channels) throw new Error('Simulation: zu viele Kanäle');
    this.sampleRate = sampleRate;
    this.frameSize = frameSize || 256;
    this.nChannels = input.nChannels;
    this.firstChannel = input.firstChannel || 0;
    this.inputCallback = inputCallback;
    this.errorCallback = errorCallback;
    this.open = true;
    this.frame = 0;
    return this.frameSize;
  }

  start() {
    if (!this.open) throw new Error('Simulation: kein Strom geöffnet');
    this.running = true;
    this._t0 = performance.now();
    this._sent = 0;
    this._timer = setInterval(() => this._tick(), 5);
  }

  _tick() {
    const now = performance.now();
    if (now < this._stallUntil) {
      this._t0 += 5;       // was ausbleibt, kommt nie nach (wie ein echter Ausfall)
      return;
    }
    const due = Math.floor(((now - this._t0) / 1000) * this.sampleRate / this.frameSize);
    while (this._sent < due) {
      this._sent++;
      this.inputCallback && this.inputCallback(this._block());
    }
  }

  _block() {
    const n = this.frameSize;
    const ch = this.nChannels;
    const buf = Buffer.alloc(n * ch * 4);
    for (let i = 0; i < n; i++) {
      const t = (this.frame + i) / this.sampleRate;
      for (let c = 0; c < ch; c++) {
        const k = c + this.firstChannel;
        let v = 0;
        if (k === 31) v = Math.sin(2 * Math.PI * 220 * t) > 0 ? 1 : -1;      // übersteuert
        else if (k % 8 !== 7) v = Math.sin(2 * Math.PI * 110 * (1 + (k % 12) / 4) * t) * (0.6 - (k % 8) * 0.07);
        buf.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(v * 2147483647))), (i * ch + c) * 4);
      }
    }
    this.frame += n;
    return buf;
  }

  /** Lässt `ms` Millisekunden lang keine Blöcke kommen. */
  stall(ms) {
    this._stallUntil = performance.now() + ms;
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
  }

  closeStream() {
    this.stop();
    this.open = false;
  }

  isStreamOpen() { return this.open; }
  isStreamRunning() { return this.running; }
  write() {}
  clearOutputQueue() {}
}

module.exports = { SimulatedAudio, SIM_DEVICE_ID };
