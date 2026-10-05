/* Mithören: spielt einen Ausschnitt der Aufnahme ab, während diese noch
   läuft. Die Daten kommen blockweise aus der WAV-Datei des Hauptprozesses;
   die Aufnahme selbst wird dabei nicht berührt. */

(function () {
  'use strict';

  const CHUNK_SEC = 1;       // Größe der angeforderten Blöcke
  const AHEAD_SEC = 3;       // so weit wird vorausgeplant

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class Monitor {
    /**
     * @param {object} opts
     * @param {(start:number, seconds:number)=>Promise<object>} opts.read liefert {ok, sampleRate, channels, buffer}
     * @param {()=>boolean} opts.isLive true, solange die Aufnahme noch wächst
     * @param {(t:number)=>void} opts.onPosition
     * @param {()=>void} opts.onStateChange
     */
    constructor(opts) {
      this.read = opts.read;
      this.isLive = opts.isLive || (() => false);
      this.onPosition = opts.onPosition || (() => {});
      this.onStateChange = opts.onStateChange || (() => {});
      this.ctx = null;
      this.playing = false;
      this.position = 0;
      this._gen = 0;
      this._sources = [];
      this._anchor = null;      // { ctxTime, pos }
      this._nextStart = 0;
      this._ended = false;
    }

    async play(from) {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this._halt();
      const gen = ++this._gen;
      this.position = Math.max(0, from || 0);
      this._nextStart = this.ctx.currentTime + 0.05;
      this._anchor = { ctxTime: this._nextStart, pos: this.position };
      this._ended = false;
      this.playing = true;
      this.onStateChange();
      this._pump(gen, this.position);
      this._tick(gen);
    }

    pause() {
      if (!this.playing) return;
      this.position = this._currentPosition();
      this._halt();
      this.playing = false;
      this.onStateChange();
    }

    /** Springt an eine neue Stelle; spielt weiter, falls gerade abgespielt wurde. */
    seek(t) {
      this.position = Math.max(0, t);
      if (this.playing) this.play(this.position);
    }

    _halt() {
      this._gen += 1;
      this._sources.forEach((s) => { try { s.stop(); } catch { /* schon beendet */ } });
      this._sources = [];
    }

    _currentPosition() {
      if (!this.ctx || !this._anchor) return this.position;
      return this._anchor.pos + Math.max(0, this.ctx.currentTime - this._anchor.ctxTime);
    }

    _tick(gen) {
      if (gen !== this._gen || !this.playing) return;
      if (this._ended && this.ctx.currentTime >= this._nextStart) {
        this.pause();
        return;
      }
      this.position = this._currentPosition();
      this.onPosition(this.position);
      requestAnimationFrame(() => this._tick(gen));
    }

    async _pump(gen, pos) {
      while (gen === this._gen) {
        if (this._nextStart - this.ctx.currentTime > AHEAD_SEC) {
          await sleep(200);
          continue;
        }
        let res;
        try {
          res = await this.read(pos, CHUNK_SEC);
        } catch {
          res = null;
        }
        if (gen !== this._gen) return;
        if (!res || !res.ok) { this._ended = true; return; }

        const channels = res.channels || 2;
        const samples = new Int16Array(res.buffer);
        const frames = Math.floor(samples.length / channels);
        if (frames === 0) {
          if (this.isLive()) { await sleep(300); continue; }   // Aufnahme holt noch Daten nach
          this._ended = true;
          return;
        }

        const buffer = this.ctx.createBuffer(channels, frames, res.sampleRate);
        for (let c = 0; c < channels; c++) {
          const out = buffer.getChannelData(c);
          for (let f = 0; f < frames; f++) out[f] = samples[f * channels + c] / 32768;
        }
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.ctx.destination);

        if (this._nextStart < this.ctx.currentTime) {
          // Daten kamen zu spät: neu aufsetzen statt Lücke in der Positionsanzeige.
          this._nextStart = this.ctx.currentTime + 0.02;
          this._anchor = { ctxTime: this._nextStart, pos };
        }
        src.start(this._nextStart);
        this._sources.push(src);
        src.onended = () => { this._sources = this._sources.filter((s) => s !== src); };
        this._nextStart += frames / res.sampleRate;
        pos += frames / res.sampleRate;
      }
    }
  }

  window.Monitor = Monitor;
})();
