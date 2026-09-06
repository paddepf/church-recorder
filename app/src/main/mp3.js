'use strict';

const fs = require('fs');
const wav = require('./wav');

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
 * Exportiert einen Zeitausschnitt der Masteraufnahme als MP3.
 * @param {object} opts
 * @param {string} opts.wavPath  Pfad zur Masteraufnahme
 * @param {number} opts.start    Startzeit in Sekunden
 * @param {number} opts.end      Endzeit in Sekunden
 * @param {string} opts.outPath  Zieldatei
 * @param {number} [opts.bitrate=192]
 * @param {(p:number)=>void} [opts.onProgress] 0..1
 */
async function exportSegment({ wavPath, start, end, outPath, bitrate = 192, onProgress }) {
  if (!fs.existsSync(wavPath)) throw new Error('Die Masteraufnahme wurde nicht gefunden.');
  if (!(end > start)) throw new Error('Der gewählte Abschnitt ist leer.');

  const Mp3Encoder = await loadEncoder();
  const { sampleRate, channels, samples } = wav.readSlice(wavPath, start, end);
  const encoder = new Mp3Encoder(channels >= 2 ? 2 : 1, sampleRate, bitrate);

  const frames = samples.length / channels;
  const blockSize = 1152;
  const out = fs.createWriteStream(outPath);

  const writeChunk = (chunk) => {
    if (chunk && chunk.length > 0) out.write(Buffer.from(chunk));
  };

  const left = new Int16Array(blockSize);
  const right = new Int16Array(blockSize);

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

    if (onProgress && (i / blockSize) % 200 === 0) onProgress(Math.min(0.99, i / frames));
    if ((i / blockSize) % 400 === 0) await new Promise((r2) => setImmediate(r2));
  }

  writeChunk(encoder.flush());
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
    out.on('error', reject);
  });

  if (onProgress) onProgress(1);
  const { size } = fs.statSync(outPath);
  return { outPath, bytes: size, duration: end - start };
}

module.exports = { exportSegment };
