/* Lautheitskurve einer Aufnahme (ITU-R BS.1770 / EBU R128): Je 100 ms liegt ein Messwert vor (Leistung nach
   K-Bewertung, als LUFS; null = Stille). Daraus lassen sich für jede Stelle Momentary (0,4 s), Short-term (3 s) und
   die integrierte Lautheit eines Bereichs berechnen. Hauptprozess (Messung, Netzwerk) und Oberfläche (Wellenform,
   Anzeige) nutzen dieselbe Rechnung, deshalb UMD wie `sections.js`. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LoudnessCurve = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEPS_PER_SECOND = 10;
  const MOMENTARY_STEPS = 4;     // 400 ms
  const SHORT_TERM_STEPS = 30;   // 3 s
  const ABS_GATE = -70;
  const REL_GATE = -10;

  const toLufs = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);
  const toPower = (v) => (v == null || !Number.isFinite(v) ? 0 : 10 ** ((v + 0.691) / 10));

  /** Messwert eines 100-ms-Schritts für die Ablage (auf 0,1 dB gerundet, Stille = null). */
  function stepValue(power) {
    const v = toLufs(power);
    return v > -100 ? Math.round(v * 10) / 10 : null;
  }

  class Curve {
    constructor(values) {
      this.reset(values || []);
    }

    reset(values) {
      this.values = values;
      this.prefix = [0];           // Summe der Leistung bis Schritt i (für gleitende Mittel in O(1))
      this._extend();
    }

    get length() {
      return this.values.length;
    }

    push(list) {
      for (const v of list) this.values.push(v);
      this._extend();
    }

    /** Neue Werte am Ende (z. B. wenn `values` von außen gewachsen ist) in die Summen übernehmen. */
    _extend() {
      for (let i = this.prefix.length - 1; i < this.values.length; i++) {
        this.prefix.push(this.prefix[i] + toPower(this.values[i]));
      }
    }

    _mean(a, b) {
      const from = Math.max(0, a);
      const to = Math.min(this.values.length, b);
      return to > from ? (this.prefix[to] - this.prefix[from]) / (to - from) : 0;
    }

    /** Lautheit der `steps` Schritte, die bei `end` (exklusiv) enden. */
    window(end, steps) {
      if (end <= 0) return -Infinity;
      return toLufs(this._mean(end - steps, end));
    }

    momentary(end = this.values.length) {
      return this.window(end, MOMENTARY_STEPS);
    }

    shortTerm(end = this.values.length) {
      return this.window(end, SHORT_TERM_STEPS);
    }

    /** Integrierte Lautheit der Schritte [a, b) mit absolutem und relativem Gate (Blöcke 400 ms, 75 % Überlappung). */
    integrated(a = 0, b = this.values.length) {
      const from = Math.max(0, Math.floor(a));
      const to = Math.min(this.values.length, Math.ceil(b));
      const absPower = toPower(ABS_GATE);
      let sum = 0;
      let count = 0;
      for (let k = from + MOMENTARY_STEPS; k <= to; k++) {
        const z = this._mean(k - MOMENTARY_STEPS, k);
        if (z > absPower) { sum += z; count += 1; }
      }
      if (!count) return -Infinity;
      const relPower = toPower(toLufs(sum / count) + REL_GATE);
      sum = 0;
      count = 0;
      for (let k = from + MOMENTARY_STEPS; k <= to; k++) {
        const z = this._mean(k - MOMENTARY_STEPS, k);
        if (z > absPower && z > relPower) { sum += z; count += 1; }
      }
      return count ? toLufs(sum / count) : -Infinity;
    }

    /** Schritt zu einer Zeit in Sekunden (Ende des Schritts, der diese Stelle enthält). */
    static stepAt(seconds) {
      return Math.floor(seconds * STEPS_PER_SECOND) + 1;
    }
  }

  return { Curve, stepValue, toLufs, toPower, STEPS_PER_SECOND, MOMENTARY_STEPS, SHORT_TERM_STEPS };
}));
