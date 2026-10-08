'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setSettings, src } = require('./helpers');
const WebSocket = require('ws');

const PORT = 18000 + Math.floor(Math.random() * 1000);
setSettings({ networkEnabled: true, networkPort: PORT, networkPassword: 'geheim', monitorPassword: 'lesen' });
const { NetServer } = require(src('main/netserver'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(opts) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, opts);
    const msgs = [];
    ws.on('message', (m) => msgs.push(JSON.parse(m)));
    ws.on('open', () => resolve({ ws, msgs }));
  });
}

test('Anmeldung, Rollen, Schutz', async (t) => {
  const net = new NetServer();
  assert.equal(net.start().ok, true);
  t.after(() => net.stop());
  net.publishState({
    status: 'idle', wavPath: '/pfad.wav',
    service: { name: 'X', suggestions: [{ role: 'Predigt', name: 'Ben' }] },
    sections: [{ id: 'a', label: 'Predigt', artist: 'Ben' }], pending: [],
    exports: { seg_a: { file: '/x.mp3', at: 't' } }
  });

  // "null" ist gültiges JSON, aber keine Nachricht
  let c = await connect();
  c.ws.send('null');
  await sleep(100);
  assert.equal(c.msgs.find((m) => m.type === 'error').code, 'bad_json');
  c.ws.close();

  // Mitlesen: keine Pfade und Namen
  c = await connect();
  c.ws.send(JSON.stringify({ type: 'auth', password: 'lesen' }));
  await sleep(150);
  const st = c.msgs.find((m) => m.type === 'state').payload;
  assert.equal(st.wavPath, undefined);
  assert.equal(st.sections[0].artist, undefined);
  assert.equal(st.service.suggestions, undefined);
  assert.deepEqual(st.exports, { seg_a: { at: 't' } });
  c.ws.close();

  // Browser-Seiten dürfen nur mitlesen
  c = await connect({ origin: 'http://fremd.example' });
  c.ws.send(JSON.stringify({ type: 'auth', password: 'geheim' }));
  await sleep(150);
  assert.equal(c.msgs.find((m) => m.type === 'auth').role, 'monitor');
  c.ws.close();

  // Steuern: voller Zustand
  c = await connect();
  c.ws.send(JSON.stringify({ type: 'auth', password: 'geheim' }));
  await sleep(150);
  assert.equal(c.msgs.find((m) => m.type === 'auth').role, 'control');
  assert.equal(c.msgs.find((m) => m.type === 'state').payload.wavPath, '/pfad.wav');
  // Aufnahmeart umschalten (Companion): wird an die App weitergereicht, die Antwort kommt von dort
  const got = [];
  net.once('command', (cmd) => { got.push(cmd); cmd.reply({ ok: true, mode: 'multitrack' }); });
  c.ws.send(JSON.stringify({ type: 'command', id: 5, action: 'mode.set', params: { mode: 'toggle' } }));
  await sleep(100);
  assert.deepEqual(got.map((x) => [x.action, x.params.mode]), [['mode.set', 'toggle']]);
  assert.deepEqual(c.msgs.find((m) => m.type === 'result'), { type: 'result', id: 5, action: 'mode.set', ok: true, mode: 'multitrack' });
  c.ws.close();

  // Mitlesende dürfen nicht umschalten
  c = await connect();
  c.ws.send(JSON.stringify({ type: 'auth', password: 'lesen' }));
  await sleep(150);
  c.ws.send(JSON.stringify({ type: 'command', id: 6, action: 'mode.set', params: { mode: 'stereo' } }));
  await sleep(100);
  assert.equal(c.msgs.find((m) => m.type === 'error').code, 'read_only');
  c.ws.close();

  // nach 5 Fehlversuchen gesperrt
  for (let i = 0; i < 5; i++) {
    c = await connect();
    c.ws.send(JSON.stringify({ type: 'auth', password: 'falsch' }));
    await sleep(60);
  }
  c = await connect();
  c.ws.send(JSON.stringify({ type: 'auth', password: 'geheim' }));
  await sleep(150);
  assert.equal(c.msgs.find((m) => m.type === 'error').code, 'auth_locked');
  c.ws.close();
});

test('Ereignisse: Mitlesende ohne Dateipfade', async (t) => {
  const net = new NetServer();
  assert.equal(net.start().ok, true);
  t.after(() => net.stop());

  const mon = await connect();
  mon.ws.send(JSON.stringify({ type: 'auth', password: 'lesen' }));
  const ctl = await connect();
  ctl.ws.send(JSON.stringify({ type: 'auth', password: 'geheim' }));
  await sleep(150);

  net.publishEvent('recording.stopped', { wavPath: '/pfad.wav', duration: 12 });
  net.publishEvent('export.finished', { file: '/x.mp3', label: 'Predigt' });
  await sleep(150);

  const events = (c) => c.msgs.filter((m) => m.type === 'event');
  assert.deepEqual(events(mon).map((m) => m.payload), [{ duration: 12 }, { label: 'Predigt' }]);
  assert.deepEqual(events(ctl).map((m) => m.payload), [
    { wavPath: '/pfad.wav', duration: 12 }, { file: '/x.mp3', label: 'Predigt' }
  ]);
  mon.ws.close();
  ctl.ws.close();
});

test('Statusseite: feste Dateien ohne Anmeldung, sonst 404', async (t) => {
  const net = new NetServer();
  assert.equal(net.start().ok, true);
  t.after(() => net.stop());
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
    return { status: res.status, type: res.headers.get('content-type'), csp: res.headers.get('content-security-policy'), body: await res.text() };
  };
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /status\.js/);
  assert.match(page.csp, /default-src 'self'/);
  assert.equal((await get('/status.js')).status, 200);
  assert.match((await get('/status.css')).type, /text\/css/);
  assert.equal((await get('/../main/settings.js')).status, 404);
  assert.equal((await get('/index.html')).status, 404);
  assert.equal(JSON.parse((await get('/health')).body).app, 'ebbton');
});
