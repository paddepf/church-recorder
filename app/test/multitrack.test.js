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

/* ---------------------------------------------------------------- Session im Mehrspur-Modus */

const { setSettings } = require('./helpers');
const { EventEmitter } = require('events');
const { TrackWriterProxy } = require(src('main/multitrack/manager'));

/** Wie der MultitrackManager, aber mit der Engine im selben Prozess. */
class InProcessManager extends EventEmitter {
  constructor(engine) {
    super();
    this.engine = engine;
    for (const ev of ['levels', 'stall', 'gap', 'write-error', 'slow']) engine.on(ev, (d) => this.emit(ev, d));
  }
  async start(o) { return this.engine.start(o); }
  async pause() { return this.engine.pause(); }
  async resume() { return this.engine.resume(); }
  async stop() { return this.engine.stop(); }
  writer(info) { return new TrackWriterProxy(this, info); }
}

test('Session nimmt im Mehrspur-Modus auf, pausiert, lädt und hängt an', async () => {
  setSettings({ recordingsDir: tmpDir() });
  const { Session } = require(src('main/session'));
  const s = new Session();
  const m = new InProcessManager(new MultitrackEngine());
  m.on('levels', (l) => s.pushTrackLevels(l));
  const levels = [];
  s.on('levels', (l) => levels.push(l));

  const dir = tmpDir();
  const { folder, base } = s.multitrackTarget(dir);
  assert.equal(path.dirname(folder), dir);
  assert.notEqual(s.multitrackTarget(dir).folder, folder, 'zweiter Ordner bekommt einen anderen Namen');
  const tracks = [0, 1, 7].map((c) => ({ channel: c, name: `Kanal ${c + 1}`, file: path.join(folder, `${c + 1}.wav`) }));
  const info = await m.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks });
  const res = s.start({ multitrack: { writer: m.writer(info), tracks, base, folder } });
  assert.equal(res.ok, true);
  assert.equal(s.mode, 'multitrack');
  assert.equal(s.wavPath, null);
  assert.equal(s.sampleRate, 48000);
  assert.deepEqual(s.snapshot().tracks.map((t) => t.name), ['Kanal 1', 'Kanal 2', 'Kanal 8']);

  await wait(600);
  s.toggleSection({ label: 'Predigt' });
  await wait(400);
  s.pause();
  const atPause = s.peaks.length;
  await wait(500);
  assert.ok(s.peaks.length <= atPause + 2, 'in der Pause wächst die Wellenform nicht');
  s.resume();
  await wait(400);
  s.stop();
  await s.whenWritten();
  s._stopAutosave();

  const secs = s.duration;
  assert.ok(secs > 1.2 && secs < 1.7, `Dauer ${secs} (ohne Pause)`);
  assert.ok(Math.abs(s.peaks.length - secs * 20) < 6, `Wellenform ${s.peaks.length} Werte`);
  assert.ok(levels.some((l) => l.l > 0.3 && l.tracks.peaks.length === 32));
  const sizes = tracks.map((t) => fs.statSync(t.file).size);
  assert.equal(new Set(sizes).size, 1);
  const predigt = s.placedSections()[0];
  // Beim Stopp gilt die zuletzt gemeldete Dauer (Pegelmeldung, höchstens etwa 50 ms vor dem Dateiende).
  assert.ok(predigt.start > 0.4 && Math.abs(predigt.end - secs) < 0.1, `Abschnitt ${predigt.start}-${predigt.end}, beim Stopp geschlossen`);
  assert.ok(fs.existsSync(`${base}.session.json`));

  // Laden: Spuren werden neben der Session-Datei gesucht, Dauer aus der ersten Spur.
  const s2 = new Session();
  s2.loadFromFile(`${base}.session.json`);
  assert.equal(s2.mode, 'multitrack');
  assert.equal(s2.trackDir, folder);
  assert.equal(s2.wavPath, null);
  assert.ok(Math.abs(s2.duration - secs) < 0.06, `geladen ${s2.duration} statt ${secs}`);
  assert.equal(s2.placedSections()[0].label, 'Predigt');
  assert.deepEqual(s2.trackFiles().map((t) => t.file), tracks.map((t) => t.file));
  assert.equal(s2.continueRecording().ok, false, 'Mehrspur nur mit Stellvertreter fortsetzen');

  // Anhängen: dieselben Dateien wachsen weiter.
  const info2 = await m.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks: s2.trackFiles(), append: true });
  assert.ok(Math.abs(info2.seconds - s2.duration) < 0.01);
  assert.equal(s2.continueRecording({ writer: m.writer(info2) }).ok, true);
  await wait(500);
  s2.stop();
  await s2.whenWritten();
  s2._stopAutosave();
  assert.ok(s2.duration > secs + 0.35, `nach Anhängen ${s2.duration}`);
  assert.equal(new Set(tracks.map((t) => fs.statSync(t.file).size)).size, 1);
  assert.ok(Math.abs(wav.readInfo(tracks[0].file).duration - s2.duration) < 0.06);
});

test('Anhängen scheitert bei anderer Abtastrate, ohne die Spuren anzufassen', async () => {
  const dir = tmpDir();
  const file = path.join(dir, '1.wav');
  const w = new MultiWavWriter({ sampleRate: 48000, deviceChannels: 1, tracks: [{ channel: 0, file }] });
  w.write(block(4800, 1));
  await w.close();
  const before = fs.readFileSync(file);
  assert.throws(() => new MultiWavWriter({ sampleRate: 44100, deviceChannels: 1, tracks: [{ channel: 0, file }], append: true }), /44100 Hz/);
  assert.throws(() => new MultiWavWriter({ sampleRate: 48000, deviceChannels: 1, tracks: [{ channel: 0, file }, { channel: 0, file: path.join(dir, 'fehlt.wav') }], append: true }));
  assert.deepEqual(fs.readFileSync(file), before);
});
