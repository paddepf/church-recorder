'use strict';

const fs = require('fs');
const wav = require('./wav');
const { buildId3v2 } = require('./id3');
const { LoudnessMeter, limiterGains, PEAK_BLOCK } = require('./loudness');

let cachedEncoder = null;
const READ_SECONDS = 30;   // so viele Sekunden werden beim Export jeweils aus der WAV gelesen

/**
 * Lädt den MP3-Encoder. Das Paket wird nur als ES-Modul ausgeliefert,
 * daher der dynamische Import; das klassische lamejs dient als Rückfallebene.
 */
async function loadEncoder() {
  if (cachedEncoder) return cachedEncoder;

  let lib = null;
  try {
    lib = await import('@breezystack/lamejs');
  } catch {
    try {
      lib = require('lamejs');
    } catch {
      throw new Error('MP3-Encoder nicht gefunden. Bitte "npm install" ausführen.');
    }
  }

  const Mp3Encoder = lib.Mp3Encoder || (lib.default && lib.default.Mp3Encoder);
  if (typeof Mp3Encoder !== 'function') throw new Error('MP3-Encoder konnte nicht geladen werden.');
  cachedEncoder = Mp3Encoder;
  return Mp3Encoder;
}

/**
 * Zerlegt [start, end] in die Teilstücke, die übrig bleiben, wenn die Schnitte entfallen.
 * @param {{start:number,end:number}[]} skip
 */
function keepRanges(start, end, skip) {
  let pieces = [[start, end]];
  (skip || []).slice().sort((a, b) => a.start - b.start).forEach((cut) => {
    const next = [];
    pieces.forEach(([a, b]) => {
      if (cut.end <= a || cut.start >= b) { next.push([a, b]); return; }
      if (cut.start > a) next.push([a, cut.start]);
      if (cut.end < b) next.push([cut.end, b]);
    });
    pieces = next;
  });
  return pieces.filter(([a, b]) => b - a > 0.001);
}

/**
 * Liest die Teilstücke blockweise (je READ_SECONDS) und blendet an den Schnitten 6 ms ein bzw. aus.
 * @yields {{samples:Int16Array, frames:number, offset:number}} offset = Lage im Ergebnis (Frames)
 */
function* readPieces(wavPath, info, frameRanges) {
  const channels = info.channels;
  const rate = info.sampleRate;
  const readFrames = rate * READ_SECONDS;         // gelesen wird in Blöcken: kleiner Speicherbedarf auch bei Stunden
  const fadeFrames = Math.round(rate * 0.006);    // 6 ms, damit Schnittstellen nicht knacken
  let offset = 0;
  for (let p = 0; p < frameRanges.length; p++) {
    const [pStart, pEnd] = frameRanges[p];
    for (let f0 = pStart; f0 < pEnd; f0 += readFrames) {
      const count = Math.min(readFrames, pEnd - f0);
      const { samples } = wav.readFrames(wavPath, f0, count, info);
      const frames = samples.length / channels;
      if (frameRanges.length > 1) {
        // Einblenden nach einem Schnitt, Ausblenden vor einem Schnitt
        const fadeIn = p > 0 && f0 === pStart;
        const fadeOut = p < frameRanges.length - 1 && f0 + count >= pEnd;
        for (let f = 0; f < Math.min(fadeFrames, frames); f++) {
          const gain = f / fadeFrames;
          for (let c = 0; c < channels; c++) {
            if (fadeIn) samples[f * channels + c] *= gain;
            if (fadeOut) samples[(frames - 1 - f) * channels + c] *= gain;
          }
        }
      }
      yield { samples, frames, offset };
      offset += frames;
    }
  }
}

const tick = () => new Promise((r) => setImmediate(r));

/**
 * Erster Durchgang der Lautheitsangleichung: misst die Lautheit und die Spitzen, daraus Verstärkung und Begrenzer.
 * @returns {{measured:number, gainDb:number, gain:number, limits:Float32Array}}
 */
async function analyseLoudness(wavPath, info, frameRanges, totalFrames, { target, ceilingDb = -1, maxGainDb = 20 }, onProgress) {
  const channels = info.channels;
  const meter = new LoudnessMeter(info.sampleRate, channels);
  const peaks = new Float32Array(Math.ceil(totalFrames / PEAK_BLOCK));
  const slice = info.sampleRate * 5;               // alle 5 s Audio kurz abgeben: der Hauptprozess bleibt bedienbar
  for (const { samples, frames, offset } of readPieces(wavPath, info, frameRanges)) {
    for (let s0 = 0; s0 < frames; s0 += slice) {
      const n = Math.min(slice, frames - s0);
      meter.push(samples.subarray(s0 * channels, (s0 + n) * channels), n);
      for (let f = s0; f < s0 + n; f++) {
        const k = Math.floor((offset + f) / PEAK_BLOCK);
        for (let c = 0; c < channels; c++) {
          const v = Math.abs(samples[f * channels + c]) / 32768;
          if (v > peaks[k]) peaks[k] = v;
        }
      }
      if (onProgress) onProgress(Math.min(0.99, (offset + s0 + n) / totalFrames));
      await tick();
    }
  }
  const measured = meter.integrated();
  // Stille (oder zu kurz zum Messen): nicht anheben, sonst würde nur das Rauschen laut.
  const gainDb = Number.isFinite(measured) ? Math.max(-30, Math.min(maxGainDb, target - measured)) : 0;
  const gain = 10 ** (gainDb / 20);
  const limits = limiterGains(peaks, gain, 10 ** (ceilingDb / 20), info.sampleRate);
  return { measured, gainDb, gain, limits };
}

/**
 * Exportiert einen Zeitausschnitt der Masteraufnahme als MP3.
 * @param {object} opts
 * @param {string} opts.wavPath  Pfad zur Masteraufnahme
 * @param {number} opts.start    Startzeit in Sekunden
 * @param {number} opts.end      Endzeit in Sekunden
 * @param {string} opts.outPath  Zieldatei
 * @param {number} [opts.bitrate=192]
 * @param {{title?:string, artist?:string, album?:string, year?:string}} [opts.tags] ID3-Angaben
 * @param {{start:number,end:number}[]} [opts.skip] Stellen, die ausgelassen werden (Schnitte)
 * @param {{target:number, ceilingDb?:number, maxGainDb?:number}} [opts.loudness] Lautheit angleichen (LUFS), sonst unverändert
 * @param {(p:number)=>void} [opts.onProgress] 0..1
 */
async function exportSegment({ wavPath, start, end, outPath, bitrate = 192, tags, skip, loudness, onProgress }) {
  if (!fs.existsSync(wavPath)) throw new Error('Die Masteraufnahme wurde nicht gefunden.');
  if (!(end > start)) throw new Error('Der gewählte Abschnitt ist leer.');

  const pieces = keepRanges(start, end, skip);
  if (pieces.length === 0) throw new Error('Der gewählte Abschnitt besteht nur aus Schnitten.');

  const Mp3Encoder = await loadEncoder();
  const info = wav.readInfo(wavPath);
  const channels = info.channels;
  const rate = info.sampleRate;
  // In Frames rechnen, damit aufeinanderfolgende Blöcke lückenlos und ohne Doppelungen aneinanderpassen.
  const frameRanges = pieces.map(([a, b]) => [Math.round(a * rate), Math.round(b * rate)]).filter(([a, b]) => b > a);
  const totalFrames = frameRanges.reduce((sum, [a, b]) => sum + (b - a), 0);

  // Lautheit: erst messen (etwa ein Drittel der Zeit), dann beim Codieren anheben und begrenzen.
  const share = loudness ? 0.35 : 0;
  const level = loudness
    ? await analyseLoudness(wavPath, info, frameRanges, totalFrames, loudness, onProgress && ((p) => onProgress(p * share)))
    : null;

  const encoder = new Mp3Encoder(channels >= 2 ? 2 : 1, rate, bitrate);
  const blockSize = 1152;
  const left = new Int16Array(blockSize);
  const right = new Int16Array(blockSize);

  /** Sample n des Ergebnisses mit Verstärkung und Begrenzer (linear zwischen den Blockgrenzen). */
  const shape = level
    ? (v, n) => {
      const k = Math.floor(n / PEAK_BLOCK);
      const t = (n - k * PEAK_BLOCK) / PEAK_BLOCK;
      const g = level.gain * (level.limits[k] + (level.limits[k + 1] - level.limits[k]) * t);
      const x = Math.round(v * g);
      return x > 32767 ? 32767 : (x < -32768 ? -32768 : x);
    }
    : (v) => v;

  const out = fs.createWriteStream(outPath);
  let streamError = null;
  out.on('error', (err) => { streamError = err; });
  const writeChunk = (chunk) => {
    if (streamError) throw streamError;
    if (chunk && chunk.length > 0) out.write(Buffer.from(chunk));
  };

  try {
    const id3 = buildId3v2(tags);
    if (id3.length > 0) out.write(id3);

    let blocks = 0;
    for (const { samples, frames, offset } of readPieces(wavPath, info, frameRanges)) {
      for (let i = 0; i < frames; i += blockSize) {
        const n = Math.min(blockSize, frames - i);
        for (let j = 0; j < n; j++) {
          const base = (i + j) * channels;
          const pos = offset + i + j;
          left[j] = shape(samples[base], pos);
          right[j] = channels >= 2 ? shape(samples[base + 1], pos) : left[j];
        }
        const l = n === blockSize ? left : left.subarray(0, n);
        const r = n === blockSize ? right : right.subarray(0, n);
        writeChunk(channels >= 2 ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l));

        blocks += 1;
        if (onProgress && blocks % 200 === 0) onProgress(share + (1 - share) * Math.min(0.99, (offset + i) / totalFrames));
        if (blocks % 400 === 0) await tick();
      }
    }

    writeChunk(encoder.flush());
    await new Promise((resolve, reject) => {
      if (streamError) return reject(streamError);
      out.once('error', reject);
      out.end(resolve);
    });
  } catch (err) {
    // Halbe Datei nicht liegen lassen (sonst landet der nächste Versuch unter "(2)").
    out.destroy();
    try { fs.unlinkSync(outPath); } catch { /* war nie angelegt */ }
    throw err;
  }

  if (onProgress) onProgress(1);
  const { size } = fs.statSync(outPath);
  const result = { outPath, bytes: size, duration: totalFrames / rate };
  if (level) result.loudness = { measured: level.measured, gainDb: level.gainDb, target: loudness.target };
  return result;
}

module.exports = { exportSegment, keepRanges, analyseLoudness };
