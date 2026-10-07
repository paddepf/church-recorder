'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, src } = require('./helpers');
const wav = require(src('main/wav'));
const { MultiWavWriter } = require(src('main/multitrack/writer'));
const { MultitrackEngine, SIM_DEVICE_ID } = require(src('main/multitrack/engine'));
const { SimulatedAudio } = require(src('main/multitrack/simulator'));
const { MultitrackManager } = require(src('main/multitrack/manager'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Block mit `frames` Frames, Kanal c hat in Frame i den Wert (c+1)*65536*256 + i*256 (obere 3 Bytes eindeutig). */
function block(frames, channels, offset = 0) {
  const buf = Buffer.alloc(frames * channels * 4);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) buf.writeInt32LE(((c + 1) * 65536 + i + offset) * 256, (i * channels + c) * 4);
  }
  return buf;
}

const read24 = (buf, i) => buf.readIntLE(wav.HEADER_BYTES + i * 3, 3);

test('24-Bit-Kopf', () => {
  const h = wav.buildHeader('ds64', 48000, 1, 300, 24);
  assert.equal(h.readUInt16LE(48 + 10), 1);          // Kanäle
  assert.equal(h.readUInt32LE(48 + 16), 48000 * 3);  // Bytes je Sekunde
  assert.equal(h.readUInt16LE(48 + 20), 3);          // Blockgröße
  assert.equal(h.readUInt16LE(48 + 22), 24);
  assert.equal(wav.buildHeader('ds64', 48000, 2, 0).readUInt16LE(48 + 22), 16);   // Standard bleibt 16 Bit
});

test('Schreiber zerlegt in Mono-Spuren mit 24 Bit', async () => {
  const dir = tmpDir();
  const tracks = [{ channel: 0, file: path.join(dir, 'a.wav') }, { channel: 5, file: path.join(dir, 'b.wav') }];
  const w = new MultiWavWriter({ sampleRate: 1000, deviceChannels: 8, tracks });
  // 1700 Frames in ungleichen Stücken (Sammelpuffer: 500 Frames)
  w.write(block(300, 8, 0)); w.write(block(900, 8, 300)); w.write(block(500, 8, 1200));
  const res = await w.close();
  assert.equal(res.frames, 1700);
  assert.equal(res.failed, false);
  for (const [k, t] of tracks.entries()) {
    const buf = fs.readFileSync(t.file);
    assert.equal(buf.length, wav.HEADER_BYTES + 1700 * 3);
    assert.equal(buf.readUInt32LE(76), 1700 * 3);    // Datenlänge im Kopf
    for (const i of [0, 299, 300, 1199, 1699]) assert.equal(read24(buf, i), (t.channel + 1) * 65536 + i, `Spur ${k}, Frame ${i}`);
  }
});

test('Schreiber überschreibt keine Dateien und legt bei Fehler keine an', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'b.wav'), 'alt');
  assert.throws(() => new MultiWavWriter({ sampleRate: 48000, deviceChannels: 2, tracks: [
    { channel: 0, file: path.join(dir, 'a.wav') }, { channel: 1, file: path.join(dir, 'b.wav') }] }));
  assert.equal(fs.existsSync(path.join(dir, 'a.wav')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'b.wav'), 'utf8'), 'alt');
  assert.throws(() => new MultiWavWriter({ sampleRate: 48000, deviceChannels: 2, tracks: [{ channel: 2, file: path.join(dir, 'c.wav') }] }), /Kanal 3/);
});

test('Engine nimmt mit dem simulierten Pult auf und meldet Pegel', async () => {
  const dir = tmpDir();
  const engine = new MultitrackEngine();
  const { devices } = engine.devices({ simulate: true });
  assert.equal(devices[0].inputs, 32);
  const tracks = Array.from({ length: 32 }, (_, c) => ({ channel: c, file: path.join(dir, `${String(c + 1).padStart(2, '0')}.wav`) }));
  const levels = [];
  engine.on('levels', (l) => levels.push(l));
  const info = engine.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks });
  assert.equal(info.sampleRate, 48000);
  await wait(1200);
  const res = await engine.stop();
  assert.ok(res.seconds > 0.9 && res.seconds < 1.4, `Dauer ${res.seconds}`);
  assert.deepEqual(res.gaps, []);
  const size = fs.statSync(tracks[0].file).size;
  for (const t of tracks) assert.equal(fs.statSync(t.file).size, size);
  assert.equal(size, wav.HEADER_BYTES + Math.round(res.seconds * 48000) * 3);
  const loud = levels.filter((l) => l.peaks[0] > 0);
  assert.ok(loud.length > 5);
  assert.ok(loud.every((l) => l.peaks[7] === 0), 'Kanal 8 ist stumm');
  assert.ok(loud.some((l) => l.clips[31]) && !loud.some((l) => l.clips[0]), 'nur Kanal 32 übersteuert');
});

test('Engine erkennt hängenden Eingang und meldet die Lücke', async () => {
  const dir = tmpDir();
  const sim = new SimulatedAudio({ channels: 4 });
  const engine = new MultitrackEngine({ createBackend: () => sim });
  const events = [];
  for (const ev of ['stall', 'gap', 'reopen']) engine.on(ev, (d) => events.push([ev, d]));
  engine.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks: [{ channel: 0, file: path.join(dir, '1.wav') }] });
  await wait(300);
  sim.stall(1600);
  await wait(2200);
  const res = await engine.stop();
  assert.deepEqual(events.map((e) => e[0]), ['stall', 'gap']);
  const gap = events[1][1];
  assert.ok(gap.seconds > 1.4 && gap.seconds < 2.1, `Lücke ${gap.seconds}`);
  assert.ok(gap.at > 0.1 && gap.at < 0.6, `Stelle ${gap.at}`);
  assert.equal(res.gaps.length, 1);
});

test('Engine öffnet das Gerät nach längerem Hängen neu', async () => {
  const dir = tmpDir();
  const sims = [];
  const engine = new MultitrackEngine({ createBackend: () => { const s = new SimulatedAudio({ channels: 2 }); sims.push(s); return s; } });
  const events = [];
  for (const ev of ['stall', 'gap', 'reopen']) engine.on(ev, (d) => events.push(ev));
  engine.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks: [{ channel: 1, file: path.join(dir, '2.wav') }] });
  await wait(200);
  sims[0].stall(60000);
  await wait(4600);
  await engine.stop();
  assert.deepEqual(events, ['stall', 'reopen', 'gap']);
  assert.equal(sims[0].isStreamOpen(), false);
});

test('Engine legt ohne funktionierendes Gerät keine Dateien an', () => {
  const dir = tmpDir();
  const engine = new MultitrackEngine();
  assert.throws(() => engine.start({ simulate: true, deviceId: 1, tracks: [{ channel: 0, file: path.join(dir, 'x.wav') }] }), /nicht gefunden/);
  const broken = new SimulatedAudio();
  broken.start = () => { throw new Error('Treiber kaputt'); };
  const e2 = new MultitrackEngine({ createBackend: () => broken });
  assert.throws(() => e2.start({ deviceId: SIM_DEVICE_ID, tracks: [{ channel: 0, file: path.join(dir, 'y.wav') }] }), /Treiber kaputt/);
  assert.equal(e2.running, false);
});

test('Manager spricht mit dem Prozess und meldet dessen Ende', async () => {
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.postMessage = ({ id, cmd }) => setImmediate(() => child.emit('message', cmd === 'start' ? { id, ok: true, result: { inputs: 32 } } : { id, ok: false, error: 'nein' }));
  child.kill = () => {};
  const m = new MultitrackManager({ fork: () => child });
  const levels = [];
  m.on('levels', (l) => levels.push(l));
  assert.deepEqual(await m.start({}), { inputs: 32 });
  await assert.rejects(m.devices(), /nein/);
  child.emit('message', { event: 'levels', data: { peaks: [1] } });
  assert.deepEqual(levels, [{ peaks: [1] }]);
  const exit = new Promise((r) => m.on('exit', r));
  child.emit('exit', 1);
  assert.deepEqual(await exit, { code: 1, wasRecording: true });
});

test('audify lädt (unter Windows mit ASIO)', () => {
  const { RtAudio, RtAudioApi } = require('audify');
  const rt = new RtAudio(process.platform === 'win32' ? RtAudioApi.WINDOWS_ASIO : RtAudioApi.UNSPECIFIED);
  if (process.platform === 'win32') assert.match(rt.getApi(), /ASIO/);
  assert.ok(Array.isArray(rt.getDevices()));
});
