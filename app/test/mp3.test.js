'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, tone, src } = require('./helpers');
const wav = require(src('main/wav'));
const mp3 = require(src('main/mp3'));

test('keepRanges zerlegt um die Schnitte herum', () => {
  assert.deepEqual(mp3.keepRanges(0, 10, [{ start: 2, end: 3 }, { start: 2.5, end: 4 }, { start: 9, end: 12 }]), [[0, 2], [4, 9]]);
});

test('Export mit Schnitten und ID3-Tags', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'a.wav');
  const w = new wav.WavWriter(p, 48000, 2);
  w.write(tone(10));
  await w.close();
  const out = path.join(dir, 'a.mp3');
  const res = await mp3.exportSegment({
    wavPath: p, start: 0, end: 10, outPath: out,
    skip: [{ start: 2, end: 4 }, { start: 6, end: 7 }],
    tags: { title: 'Predigt: Größe', artist: 'Müller', album: '2026-10-05', year: '2026' }
  });
  assert.equal(res.duration, 7);
  const file = fs.readFileSync(out);
  assert.equal(file.toString('ascii', 0, 3), 'ID3');
  const size = (file[6] << 21) | (file[7] << 14) | (file[8] << 7) | file[9];
  assert.equal(file[10 + size], 0xff);    // danach beginnt das MP3-Audio
});

test('Fehlschlag hinterlässt keine halbe Datei', async () => {
  const dir = tmpDir();
  await assert.rejects(mp3.exportSegment({ wavPath: path.join(dir, 'fehlt.wav'), start: 0, end: 1, outPath: path.join(dir, 'x.mp3') }));
  assert.equal(fs.existsSync(path.join(dir, 'x.mp3')), false);
});
