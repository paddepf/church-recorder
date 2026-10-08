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

// Scheitert ein Test, bevor er das Gerät schließt, liefe der Takt des Simulators weiter und der Testprozess
// endete nie (so auf Windows geschehen: der Lauf hing stundenlang). Deshalb nach jedem Test alle anhalten.
const runningSims = new Set();
const simStart = SimulatedAudio.prototype.start;
SimulatedAudio.prototype.start = function (...args) { runningSims.add(this); return simStart.apply(this, args); };
test.afterEach(() => { for (const s of runningSims) s.stop(); runningSims.clear(); });

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

// Unter Linux fehlt libpulse; Zielsysteme sind nur Windows und macOS (CI und Release testen nicht unter Linux).
test('audify lädt (unter Windows mit ASIO)', { skip: process.platform === 'linux' && 'kein Zielsystem' }, () => {
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

test('Abhören vor dem Start: Aufnahme übernimmt den offenen Strom, danach bleibt das Gerät offen', async () => {
  const dir = tmpDir();
  const sims = [];
  const engine = new MultitrackEngine({ createBackend: () => { const s = new SimulatedAudio({ channels: 4 }); sims.push(s); return s; } });
  const levels = [];
  engine.on('levels', (l) => levels.push(l));
  const info = engine.monitor({ simulate: true, deviceId: SIM_DEVICE_ID });
  assert.equal(info.recording, false);
  await wait(300);
  assert.ok(levels.some((l) => l.peaks[0] > 0), 'Pegel ohne Aufnahme');
  assert.ok(levels.every((l) => l.buckets.length === 0), 'keine Wellenform ohne Aufnahme');
  assert.deepEqual(fs.readdirSync(dir), [], 'keine Dateien beim Abhören');
  const opened = sims.length;

  const file = path.join(dir, '1.wav');
  engine.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks: [{ channel: 0, file }] });
  assert.equal(sims.length, opened, 'derselbe Strom (ASIO erlaubt nur einen)');
  await wait(400);
  const res = await engine.stop();
  assert.ok(res.seconds > 0.3 && res.seconds < 0.6, `aufgenommen ${res.seconds}`);
  assert.equal(engine.opened, true, 'nach dem Stopp weiter offen');
  const n = levels.length;
  await wait(200);
  assert.ok(levels.length > n, 'Pegel laufen weiter');

  // Andere Abtastrate (z. B. Anhängen an eine 44,1-kHz-Aufnahme): Gerät wird neu geöffnet.
  engine.open({ simulate: true, deviceId: SIM_DEVICE_ID, sampleRate: 44100 });
  assert.equal(engine.info().sampleRate, 44100);
  assert.equal(sims[opened - 1].isStreamOpen(), false);
  engine.unmonitor();
  assert.equal(engine.opened, false);
  assert.equal(sims[sims.length - 1].isStreamOpen(), false);
});

test('Aufnahme ohne Abhören schließt das Gerät beim Stopp; Wechsel während der Aufnahme wird abgelehnt', async () => {
  const dir = tmpDir();
  const engine = new MultitrackEngine();
  engine.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks: [{ channel: 0, file: path.join(dir, '1.wav') }] });
  assert.throws(() => engine.open({ simulate: true, deviceId: SIM_DEVICE_ID, sampleRate: 44100 }), /gewechselt/);
  await wait(200);
  await engine.stop();
  assert.equal(engine.opened, false);
});

/* ---------------------------------------------------------------- Zurückspielen */

const { Player } = require(src('main/multitrack/player'));

/** Zwei Spuren (Kanal 2 und 5) mit eindeutigen Werten je Frame: (Kanal+1)*65536 + Frame. */
async function writeTracks(dir, frames, rate = 1000) {
  const tracks = [{ channel: 1, file: path.join(dir, 'a.wav') }, { channel: 4, file: path.join(dir, 'b.wav') }];
  const w = new MultiWavWriter({ sampleRate: rate, deviceChannels: 8, tracks });
  w.write(block(frames, 8));
  await w.close();
  return tracks;
}

/** Wert auf Ausgang `ch` in Frame `i` eines Ausgabeblocks (oberste 3 Bytes des Int32). */
const outValue = (buf, outputs, i, ch) => buf.readInt32LE((i * outputs + ch) * 4) >> 8;

test('Abspieler legt jede Spur auf ihren Ausgang, mit Springen, Schleife und Ende', async () => {
  const tracks = await writeTracks(tmpDir(), 1000);
  const p = new Player({ tracks, outputs: 8, sampleRate: 1000, blockFrames: 300 });
  assert.equal(p.length, 1000);
  let b = p.nextBlock();
  assert.equal(b.startFrame, 0);
  for (const i of [0, 150, 299]) {
    assert.equal(outValue(b.buf, 8, i, 1), 2 * 65536 + i);
    assert.equal(outValue(b.buf, 8, i, 4), 5 * 65536 + i);
    assert.equal(outValue(b.buf, 8, i, 0), 0, 'Ausgang ohne Spur bleibt still');
  }
  b = p.nextBlock();
  assert.equal(outValue(b.buf, 8, 0, 1), 2 * 65536 + 300);

  p.seek(0.9);                                     // 100 Frames vor dem Ende
  b = p.nextBlock();
  assert.equal(outValue(b.buf, 8, 99, 4), 5 * 65536 + 999);
  assert.equal(outValue(b.buf, 8, 100, 4), 0, 'nach dem Ende Stille');
  assert.equal(p.ended, true);

  p.setLoop({ start: 0.2, end: 0.45 });            // 250 Frames Schleife
  assert.equal(p.ended, false);
  b = p.nextBlock();
  assert.equal(b.startFrame, 200);
  assert.equal(outValue(b.buf, 8, 249, 1), 2 * 65536 + 449);
  assert.equal(outValue(b.buf, 8, 250, 1), 2 * 65536 + 200, 'nahtlos zurück zum Schleifenanfang');
  assert.throws(() => p.setLoop({ start: 0.1, end: 0.2 }), /zu kurz/);
  p.close();

  assert.throws(() => new Player({ tracks, outputs: 8, sampleRate: 48000, blockFrames: 256 }), /1000 Hz/);
  assert.throws(() => new Player({ tracks, outputs: 1, sampleRate: 1000, blockFrames: 256 }), /Keine Spur/);   // Spuren auf Kanal 2 und 5
});

test('Engine spielt im Takt des Geräts ab und hält am Ende an', async () => {
  const dir = tmpDir();
  // 0,6 s bei 48 kHz auf Kanal 2 und 5
  const tracks = [{ channel: 1, file: path.join(dir, 'a.wav') }, { channel: 4, file: path.join(dir, 'b.wav') }];
  const w = new MultiWavWriter({ sampleRate: 48000, deviceChannels: 8, tracks });
  w.write(block(28800, 8));
  await w.close();

  const sim = new SimulatedAudio({ channels: 8 });
  const engine = new MultitrackEngine({ createBackend: () => sim });
  engine.monitor({ simulate: true, deviceId: SIM_DEVICE_ID });
  sim.captureOutput = [];
  const events = [];
  engine.on('playback', (p) => events.push(p.playing));
  const info = engine.play({ tracks, start: 0 });
  assert.equal(info.playing, true);
  // Vorlauf in Sekunden prüfen: Die Blockgröße hängt vom System ab (Windows öffnet mit 0 = Treiberwert,
  // der Simulator nimmt dann 256 statt 512 Frames, also doppelt so viele Blöcke).
  const ahead = (sim.outQueue.length * engine.frameSize) / 48000;
  assert.ok(sim.outQueue.length >= 2 && ahead >= 0.1 && ahead <= 0.3, `Vorlauf ${sim.outQueue.length} Blöcke = ${ahead.toFixed(3)} s`);
  assert.throws(() => engine.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks: [] }), /Keine Spur ausgewählt/);   // Aufnahme beendet das Abspielen
  assert.equal(engine.playInfo().playing, false);

  sim.captureOutput = [];
  engine.play({ tracks, start: 0.2 });
  await wait(800);
  assert.deepEqual(events.slice(-1), [false], 'am Ende angehalten');
  // Alles, was am Gerät ankam, hintereinander: Kanal 2 läuft lückenlos von Frame 9600 bis 28799.
  const got = [];
  for (const b of sim.captureOutput) for (let i = 0; i < b.length / 32; i++) got.push(outValue(b, 8, i, 1));
  const first = got.indexOf(2 * 65536 + 9600);
  assert.equal(first, 0, 'beginnt an der Sprungstelle');
  const played = got.slice(0, 28800 - 9600);
  assert.ok(played.every((v, i) => v === 2 * 65536 + 9600 + i), 'lückenlos und in der richtigen Reihenfolge');
  assert.ok(got.slice(played.length).every((v) => v === 0), 'danach Stille');
  engine.unmonitor();
});

test('Engine reicht die Kennung des Standardgeräts weiter und unterdrückt „no open stream to close“', () => {
  let errCb;
  const sim = new SimulatedAudio({ channels: 2 });
  const open = sim.openStream.bind(sim);
  sim.openStream = (...a) => { errCb = a[9]; return open(...a); };
  const engine = new MultitrackEngine({ createBackend: () => sim });
  assert.equal(engine.devices({ simulate: true }).devices[0].isDefault, true);
  const warnings = [];
  engine.on('device-warning', (w) => warnings.push(w.message));
  engine.monitor({ simulate: true, deviceId: SIM_DEVICE_ID });
  errCb(0, 'RtApiCore::closeStream(): no open stream to close!');
  errCb(0, 'etwas anderes');
  assert.deepEqual(warnings, ['etwas anderes']);
  engine.unmonitor();
});

test('Absturz des Mehrspur-Prozesses: neuer Prozess hängt an dieselben Spuren an, die Aufnahme läuft weiter', async () => {
  setSettings({ recordingsDir: tmpDir() });
  const { Session } = require(src('main/session'));
  const s = new Session();
  const m1 = new InProcessManager(new MultitrackEngine());
  m1.on('levels', (l) => s.pushTrackLevels(l));
  const { folder, base } = s.multitrackTarget(tmpDir());
  const tracks = [0, 3].map((c) => ({ channel: c, name: `Kanal ${c + 1}`, file: path.join(folder, `${c + 1}.wav`) }));
  const info = await m1.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks });
  const proxy1 = m1.writer(info);
  assert.equal(s.start({ multitrack: { writer: proxy1, tracks, base, folder } }).ok, true);
  await wait(500);
  s.toggleSection({ label: 'Predigt' });

  // „Absturz“: der alte Prozess schreibt nicht mehr, sein Stellvertreter wird aufgegeben
  await m1.engine.stop();
  proxy1.abandon();
  const frozen = s.duration;
  await wait(200);
  assert.equal(s.duration, frozen, 'Dauer bleibt stehen, solange kein Prozess schreibt');
  assert.equal(s.status, 'recording');

  const m2 = new InProcessManager(new MultitrackEngine());
  m2.on('levels', (l) => s.pushTrackLevels(l));
  const info2 = await m2.start({ simulate: true, deviceId: SIM_DEVICE_ID, tracks: s.trackFiles(), sampleRate: s.sampleRate, append: true });
  assert.equal(s.replaceWriter(m2.writer(info2)), true);
  await wait(500);
  s.stop();
  await s.whenWritten();
  s._stopAutosave();

  assert.ok(s.duration > frozen + 0.35, `weiter aufgenommen: ${s.duration} nach ${frozen}`);
  assert.equal(new Set(tracks.map((t) => fs.statSync(t.file).size)).size, 1, 'Spuren gleich lang');
  assert.ok(Math.abs(wav.readInfo(tracks[0].file).duration - s.duration) < 0.06);
  assert.ok(Math.abs(s.placedSections()[0].end - s.duration) < 0.1, 'Abschnitt lief über den Absturz hinweg');
  assert.equal(await proxy1.close(), null, 'aufgegebener Stellvertreter beendet nichts mehr');
  assert.equal(new Session().replaceWriter({}), false, 'ohne laufende Aufnahme nichts zu ersetzen');
});
