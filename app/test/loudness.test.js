'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir, src } = require('./helpers');
const wav = require(src('main/wav'));
const mp3 = require(src('main/mp3'));
const { LoudnessMeter, limiterGains, PEAK_BLOCK } = require(src('main/loudness'));

/** Stereo-Sinus (Int16, verschachtelt) mit Amplitude 0..1. */
function sine(seconds, amp, { rate = 48000, freq = 997 } = {}) {
  const frames = Math.round(seconds * rate);
  const s = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767);
    s[i * 2] = v;
    s[i * 2 + 1] = v;
  }
  return s;
}

test('Sinus 997 Hz mit −20 dBFS auf beiden Kanälen misst etwa −20 LUFS (48 und 44,1 kHz)', () => {
  for (const rate of [48000, 44100]) {
    const m = new LoudnessMeter(rate, 2);
    const s = sine(5, 0.1, { rate });
    m.push(s, s.length / 2);
    assert.ok(Math.abs(m.integrated() + 20) < 0.15, `${rate}: ${m.integrated()}`);
  }
});

test('Stille und Gating: leise Pausen ziehen die Lautheit nicht herunter', () => {
  const m = new LoudnessMeter(48000, 2);
  m.push(new Int16Array(48000 * 2 * 3), 48000 * 3);
  assert.equal(m.integrated(), -Infinity);
  const s = sine(5, 0.1);
  m.push(s, s.length / 2);
  m.push(new Int16Array(48000 * 2 * 10), 48000 * 10);
  // Nur die Messblöcke am Übergang zählen mit (sie liegen über dem relativen Gate), die Stille nicht.
  assert.ok(Math.abs(m.integrated() + 20) < 0.4, String(m.integrated()));
});

test('Begrenzer: keine Spitze über der Grenze, außerhalb der Spitze volle Verstärkung', () => {
  const peaks = new Float32Array(2000).fill(0.1);
  peaks[1000] = 0.9;
  const g = limiterGains(peaks, 4, 0.89, 48000);
  for (let k = 0; k < peaks.length; k++) {
    assert.ok(peaks[k] * 4 * Math.max(g[k], g[k + 1]) <= 0.89 + 1e-6, `Block ${k}`);
  }
  assert.equal(g[0], 1);
  assert.ok(g[998] < 1 && g[998] > g[999] && g[999] > g[1000]);   // schon vorher stufenweise abgesenkt
  assert.ok(g[1002] < g[1100] && g[1100] < 1);   // langsam zurück
  assert.equal(PEAK_BLOCK, 64);
});

test('Export gleicht die Lautheit an und meldet Messwert und Anhebung', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'leise.wav');
  const w = new wav.WavWriter(p, 48000, 2);
  w.write(Buffer.from(sine(6, 0.02).buffer));     // etwa −34 LUFS
  await w.close();
  const res = await mp3.exportSegment({ wavPath: p, start: 0, end: 6, outPath: path.join(dir, 'x.mp3'), loudness: { target: -16 } });
  assert.ok(Math.abs(res.loudness.measured + 34) < 0.3, String(res.loudness.measured));
  assert.ok(Math.abs(res.loudness.gainDb - 18) < 0.3, String(res.loudness.gainDb));

  // Höchstens +20 dB, auch wenn das Ziel mehr verlangt
  const q = path.join(dir, 'sehr-leise.wav');
  const w2 = new wav.WavWriter(q, 48000, 2);
  w2.write(Buffer.from(sine(6, 0.002).buffer));
  await w2.close();
  const res2 = await mp3.exportSegment({ wavPath: q, start: 0, end: 6, outPath: path.join(dir, 'y.mp3'), loudness: { target: -16 } });
  assert.equal(res2.loudness.gainDb, 20);
});

test('Angehobene Samples bleiben unter der Grenze (Messung am Ergebnis der Formung)', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'a.wav');
  const w = new wav.WavWriter(p, 48000, 2);
  const s = sine(4, 0.05);
  for (let i = 96000; i < 96000 + 480; i++) s[i * 2] = s[i * 2 + 1] = (i % 2 ? 1 : -1) * 30000;   // kurzer, lauter Knall
  w.write(Buffer.from(s.buffer));
  await w.close();
  const info = wav.readInfo(p);
  const level = await mp3.analyseLoudness(p, info, [[0, info.frames]], info.frames, { target: -16, ceilingDb: -1 });
  const ceiling = 10 ** (-1 / 20) * 32768;
  let max = 0;
  for (let n = 0; n < info.frames; n++) {
    const k = Math.floor(n / PEAK_BLOCK);
    const t = (n - k * PEAK_BLOCK) / PEAK_BLOCK;
    const g = level.gain * (level.limits[k] + (level.limits[k + 1] - level.limits[k]) * t);
    max = Math.max(max, Math.abs(s[n * 2] * g));
  }
  assert.ok(level.gainDb > 3);
  assert.ok(max <= ceiling + 1, `${max} > ${ceiling}`);
});

const Loudness = require(src('shared/loudness-curve'));

test('Kurve: Momentary, Short-term und integrierte Lautheit aus den 100-ms-Werten', () => {
  const c = new Loudness.Curve([]);
  c.push(Array(50).fill(-20));
  c.push(Array(50).fill(-30));
  assert.ok(Math.abs(c.momentary() + 30) < 0.01);
  assert.ok(Math.abs(c.shortTerm() + 30) < 0.01);
  assert.ok(Math.abs(c.shortTerm(Loudness.Curve.stepAt(4.9)) + 20) < 0.01, 'bei 4,9 s noch die lauten 3 s');
  assert.ok(Math.abs(c.integrated(0, 50) + 20) < 0.01, 'Bereich');
  // Gesamt: beide Teile über dem relativen Gate (−10 LU unter dem Mittel), also Mittel der Leistung
  const both = c.integrated();
  assert.ok(both > -24 && both < -22.5, String(both));
  c.push(Array(50).fill(null));
  assert.ok(Math.abs(c.integrated() - both) < 0.6, 'Stille zählt nicht mit');
  assert.equal(c.momentary(), -Infinity);
  assert.equal(Loudness.stepValue(0), null);
  assert.equal(Loudness.stepValue(Loudness.toPower(-23.04)), -23);
});

test('Session misst die Lautheit während der Aufnahme, speichert sie und rechnet sie für alte Aufnahmen nach', async () => {
  const { setSettings, tmpDir: dir } = require('./helpers');
  setSettings({ recordingsDir: dir() });
  const { Session } = require(src('main/session'));
  const s = new Session();
  const seen = [];
  s.on('levels', (l) => seen.push(l.loudness));
  assert.equal(s.start({ sampleRate: 48000, channels: 2 }).ok, true);
  const block = sine(0.25, 0.1);                       // etwa −20 LUFS
  for (let i = 0; i < 20; i++) s.pushAudio(Buffer.from(block.buffer));
  const last = seen[seen.length - 1];
  assert.ok(Math.abs(last.shortTerm + 20) < 0.3, String(last.shortTerm));
  assert.ok(Math.abs(last.momentary + 20) < 0.3);
  assert.equal(s.loudness.length, 50);
  s.stop();
  await s.whenWritten();
  s._stopAutosave();
  s.flushSave();
  const file = s.sessionFilePath();

  const s2 = new Session();
  s2.loadFromFile(file);
  assert.equal(s2.loudness.length, 50, 'aus der Session-Datei');

  // Ältere Session ohne Lautheit: wird im Hintergrund aus der WAV gemessen
  const fs2 = require('fs');
  const data = JSON.parse(fs2.readFileSync(file, 'utf8'));
  delete data.loudness;
  fs2.writeFileSync(file, JSON.stringify(data));
  const s3 = new Session();
  const ready = new Promise((r) => s3.once('loudness', r));
  s3.loadFromFile(file);
  assert.equal(s3.loudness.length, 0);
  const { loudness } = await ready;
  assert.equal(loudness.length, 50);
  assert.ok(Math.abs(new Loudness.Curve(loudness).integrated() + 20) < 0.3);
  s3.flushSave();
});
