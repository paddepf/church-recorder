'use strict';

const fs = require('fs');
const wav = require('./wav');
const { buildId3v2 } = require('./id3');

let cachedEncoder = null;

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
 * Exportiert einen Zeitausschnitt der Masteraufnahme als MP3.
 * @param {object} opts
 * @param {string} opts.wavPath  Pfad zur Masteraufnahme
 * @param {number} opts.start    Startzeit in Sekunden
 * @param {number} opts.end      Endzeit in Sekunden
 * @param {string} opts.outPath  Zieldatei
 * @param {number} [opts.bitrate=192]
 * @param {{title?:string, artist?:string, album?:string, year?:string}} [opts.tags] ID3-Angaben
 * @param {{start:number,end:number}[]} [opts.skip] Stellen, die ausgelassen werden (Schnitte)
 * @param {(p:number)=>void} [opts.onProgress] 0..1
 */
async function exportSegment({ wavPath, start, end, outPath, bitrate = 192, tags, skip, onProgress }) {
  if (!fs.existsSync(wavPath)) throw new Error('Die Masteraufnahme wurde nicht gefunden.');
  if (!(end > start)) throw new Error('Der gewählte Abschnitt ist leer.');

  const pieces = keepRanges(start, end, skip);
  if (pieces.length === 0) throw new Error('Der gewählte Abschnitt besteht nur aus Schnitten.');

  const Mp3Encoder = await loadEncoder();
  const info = wav.readInfo(wavPath);
  const channels = info.channels;
  const encoder = new Mp3Encoder(channels >= 2 ? 2 : 1, info.sampleRate, bitrate);
  const totalFrames = pieces.reduce((sum, [a, b]) => sum + Math.round((b - a) * info.sampleRate), 0);

  const blockSize = 1152;
  const out = fs.createWriteStream(outPath);
  const id3 = buildId3v2(tags);
  if (id3.length > 0) out.write(id3);

  const writeChunk = (chunk) => {
    if (chunk && chunk.length > 0) out.write(Buffer.from(chunk));
  };

  const left = new Int16Array(blockSize);
  const right = new Int16Array(blockSize);
  const fadeFrames = Math.round(info.sampleRate * 0.006);    // 6 ms, damit Schnittstellen nicht knacken
  let framesDone = 0;
  let blocks = 0;

  for (let p = 0; p < pieces.length; p++) {
    // Teilstücke werden einzeln gelesen: so bleibt der Speicherbedarf klein.
    const { samples } = wav.readSlice(wavPath, pieces[p][0], pieces[p][1]);
    const frames = samples.length / channels;
    if (pieces.length > 1) {
      for (let f = 0; f < Math.min(fadeFrames, frames); f++) {
        const gain = f / fadeFrames;
        for (let c = 0; c < channels; c++) {
          if (p > 0) samples[f * channels + c] *= gain;                           // Einblenden nach einem Schnitt
          if (p < pieces.length - 1) samples[(frames - 1 - f) * channels + c] *= gain;   // Ausblenden vor einem Schnitt
        }
      }
    }

    for (let i = 0; i < frames; i += blockSize) {
      const n = Math.min(blockSize, frames - i);
      for (let j = 0; j < n; j++) {
        const base = (i + j) * channels;
        left[j] = samples[base];
        right[j] = channels >= 2 ? samples[base + 1] : samples[base];
      }
      const l = n === blockSize ? left : left.subarray(0, n);
      const r = n === blockSize ? right : right.subarray(0, n);
      writeChunk(channels >= 2 ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l));

      blocks += 1;
      if (onProgress && blocks % 200 === 0) onProgress(Math.min(0.99, (framesDone + i) / totalFrames));
      if (blocks % 400 === 0) await new Promise((r2) => setImmediate(r2));
    }
    framesDone += frames;
  }

  writeChunk(encoder.flush());
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
    out.on('error', reject);
  });

  if (onProgress) onProgress(1);
  const { size } = fs.statSync(outPath);
  return { outPath, bytes: size, duration: totalFrames / info.sampleRate };
}

module.exports = { exportSegment, keepRanges };
