'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, tone, src } = require('./helpers');
const wav = require(src('main/wav'));

test('schreiben, lesen, anhängen', async () => {
  const p = path.join(tmpDir(), 'a.wav');
  const w = new wav.WavWriter(p, 48000, 2);
  w.write(tone(1)); w.write(tone(1));
  await w.close();
  let info = wav.readInfo(p);
  assert.equal(info.duration, 2);
  assert.equal(info.dataOffset, wav.HEADER_BYTES);
  const w2 = new wav.WavWriter(p, 48000, 2, { append: true });
  w2.write(tone(1));
  await w2.close();
  info = wav.readInfo(p);
  assert.equal(info.duration, 3);
  assert.equal(fs.readFileSync(p).toString('ascii', 12, 16), 'JUNK');
});

test('ältere Dateien mit 44-Byte-Kopf', async () => {
  const p = path.join(tmpDir(), 'alt.wav');
  const data = tone(1);
  fs.writeFileSync(p, Buffer.concat([wav.buildHeader('legacy', 48000, 2, data.length), data]));
  assert.equal(wav.readInfo(p).dataOffset, 44);
  const w = new wav.WavWriter(p, 48000, 2, { append: true });
  w.write(tone(1));
  await w.close();
  assert.equal(wav.readInfo(p).duration, 2);
});

test('über 4 GB wird der Kopf zu RF64', () => {
  const big = 5 * 1024 ** 3;
  const h = wav.buildHeader('ds64', 48000, 2, big);
  assert.equal(h.toString('ascii', 0, 4), 'RF64');
  assert.equal(h.toString('ascii', 12, 16), 'ds64');
  assert.equal(h.readBigUInt64LE(28), BigInt(big));
  assert.equal(h.readUInt32LE(76), 0xFFFFFFFF);
  // kleiner Datei mit RF64-Kopf: Lesen findet die Daten trotzdem
  const p = path.join(tmpDir(), 'rf64.wav');
  const data = tone(0.5);
  const head = wav.buildHeader('ds64', 48000, 2, big);
  fs.writeFileSync(p, Buffer.concat([head, data]));
  const info = wav.readInfo(p);
  assert.equal(info.dataOffset, 80);
  assert.equal(info.duration, 0.5);
});

test('Schreibfehler des Threads werden als Ereignis gemeldet, nur einmal', async () => {
  const p = path.join(tmpDir(), 'f.wav');
  const w = new wav.WavWriter(p, 48000, 2);
  const errors = [];
  w.on('error', (e) => errors.push(e));
  // So meldet der Schreib-Thread z. B. eine volle Platte (ENOSPC).
  w._onMessage({ type: 'error', message: 'no space left on device', code: 'ENOSPC' });
  w._onMessage({ type: 'error', message: 'no space left on device', code: 'ENOSPC' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ENOSPC');
  assert.equal(w.failed, true);
  await w.close();
});

test('Cue-Marker hinter den Audiodaten: Länge bleibt, Anhängen entfernt sie, neu schreiben ersetzt sie', async () => {
  const p = path.join(tmpDir(), 'cue.wav');
  const w = new wav.WavWriter(p, 48000, 2);
  w.write(tone(2));
  await w.close();
  const dataBytes = wav.readInfo(p).dataBytes;

  assert.equal(wav.writeCues(p, [
    { frame: 48000, label: 'Predigt (Müller)', length: 48000 },
    { frame: 0, label: 'Einleitung' }
  ]), true);
  let info = wav.readInfo(p);
  assert.equal(info.dataBytes, dataBytes);
  assert.equal(info.duration, 2);
  const buf = fs.readFileSync(p);
  assert.equal(buf.readUInt32LE(4), buf.length - 8);
  assert.ok(buf.includes(Buffer.from('cue ')) && buf.includes(Buffer.from('adtl')));
  assert.ok(buf.includes(Buffer.from('Predigt (M\xfcller)', 'latin1')));
  assert.equal(wav.readFrames(p, 0, 10).samples.length, 20);

  // Neu schreiben ersetzt, leere Liste entfernt
  wav.writeCues(p, [{ frame: 100, label: 'x' }]);
  assert.equal(wav.readInfo(p).dataBytes, dataBytes);
  wav.writeCues(p, []);
  assert.equal(fs.statSync(p).size, wav.HEADER_BYTES + dataBytes);

  // Anhängen schneidet die Marker ab und hängt die Daten direkt an die Audiodaten
  wav.writeCues(p, [{ frame: 0, label: 'a' }]);
  const w2 = new wav.WavWriter(p, 48000, 2, { append: true });
  w2.write(tone(1));
  await w2.close();
  info = wav.readInfo(p);
  assert.equal(info.duration, 3);
  assert.equal(fs.statSync(p).size, wav.HEADER_BYTES + info.dataBytes);
});
