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
