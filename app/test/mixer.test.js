'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { src } = require('./helpers');
const osc = require(src('main/mixer/osc'));
const M32 = require(src('main/mixer/m32'));
const { MixerClient, discover } = require(src('main/mixer/client'));
const { MixerSimulator, ROUTING_STEREO, ROUTING_MULTITRACK } = require(src('main/mixer/simulator'));
const { MixerLink } = require(src('main/mixer/link'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(20); }
  return false;
}

test('OSC kodieren und lesen', () => {
  const buf = osc.encode('/ch/01/config/name', ['Predigt']);
  assert.equal(buf.length % 4, 0);
  assert.deepEqual(osc.decode(buf), { address: '/ch/01/config/name', args: ['Predigt'] });
  const all = osc.decode(osc.encode('/x', [7, { type: 'f', value: 0.5 }, 'Wört', Buffer.from([1, 2, 3])]));
  assert.equal(all.args[0], 7);
  assert.equal(all.args[1], 0.5);
  assert.equal(all.args[2], 'Wört');
  assert.deepEqual([...all.args[3]], [1, 2, 3]);
  assert.deepEqual(osc.decode(osc.encode('/xinfo')), { address: '/xinfo', args: [] });
  // Länge genau auf der 4er-Grenze: trotzdem ein Nullbyte (8 Byte), dazu der Typ-String „,“ (4 Byte)
  assert.equal(osc.encode('/abc').length, 8 + 4);
});

test('Routing: Faustregel und Anlernen', () => {
  assert.equal(M32.routingKind(ROUTING_MULTITRACK).kind, 'multitrack');
  assert.equal(M32.routingKind(ROUTING_STEREO).kind, 'stereo');
  assert.equal(M32.routingKind(null).kind, 'unknown');
  assert.equal(M32.routingKind([99, 1, 2, 3]).kind, 'unknown');
  // Angelernt: Ein Routing, das die Faustregel als Mehrspur sähe, gilt als Stereo.
  const learned = { stereo: [4, 1, 2, 3], multitrack: [0, 1, 2, 3] };
  assert.deepEqual(M32.routingKind([4, 1, 2, 3], learned), { kind: 'stereo', learned: true });
  assert.deepEqual(M32.routingKind([0, 1, 2, 3], learned), { kind: 'multitrack', learned: true });
  assert.deepEqual(M32.routingKind([5, 1, 2, 3], learned), { kind: 'multitrack', learned: false });
  assert.equal(M32.routingLabel(20), 'OUT1-8');
  assert.equal(M32.colorName(9), 'red');
  assert.equal(M32.colorName(16), null);
});

test('Client liest Namen, Farben, Routing und bekommt Änderungen', async () => {
  const sim = new MixerSimulator();
  const port = await sim.start();
  const c = new MixerClient({ host: '127.0.0.1', port });
  c.start();
  try {
    assert.ok(await until(() => c.status === 'connected' && c.snapshot().routing && c.channels[31].name), 'verbunden und gelesen');
    const snap = c.snapshot();
    assert.equal(snap.channels[0].name, 'Predigt');
    assert.equal(snap.channels[0].color, 1);
    assert.deepEqual(snap.routing, ROUTING_MULTITRACK);
    assert.equal(snap.info.model, 'M32');
    sim.setName(5, 'Neuer Name');
    sim.setRouting(ROUTING_STEREO);
    assert.ok(await until(() => c.channels[4].name === 'Neuer Name' && c.routing[0] === 20), 'Änderung per /xremote');
  } finally {
    c.stop();
    sim.stop();
  }
});

test('Client bemerkt ein ausgeschaltetes Pult und liest danach neu', async () => {
  const sim = new MixerSimulator();
  sim.silent = true;                                   // Pult beim Start aus
  const port = await sim.start();
  const c = new MixerClient({ host: '127.0.0.1', port, timing: { keepalive: 100, alive: 400, retry: 100 } });
  c.start();
  try {
    await wait(400);
    assert.equal(c.status, 'connecting');
    sim.silent = false;                                // eingeschaltet
    assert.ok(await until(() => c.status === 'connected' && c.channels[0].name === 'Predigt'), 'nach dem Einschalten gelesen');
    sim.silent = true;                                 // wieder aus
    assert.ok(await until(() => c.status === 'lost'), 'weg');
    sim.values.set(M32.namePath(1), ['Andere Szene']);  // Szene gewechselt, während das Pult weg war
    sim.silent = false;
    assert.ok(await until(() => c.status === 'connected' && c.channels[0].name === 'Andere Szene', 5000), 'neu gelesen');
  } finally {
    c.stop();
    sim.stop();
  }
});

test('Pult suchen', async () => {
  const sim = new MixerSimulator({ name: 'Kirche' });
  const port = await sim.start();
  try {
    const found = await discover({ port, address: '127.0.0.1', timeout: 300 });
    assert.deepEqual(found.map((f) => [f.name, f.model]), [['Kirche', 'M32']]);
  } finally {
    sim.stop();
  }
});

test('Verbindung über die Einstellungen, Simulator und Routing-Bewertung', async () => {
  const link = new MixerLink();
  try {
    assert.equal(link.evaluate('multitrack').status, 'off');
    await link.configure({ simulate: true });
    assert.ok(await until(() => link.state().routing && link.channel(0).name === 'Predigt'));
    assert.equal(link.state().simulated, true);
    assert.equal(link.evaluate('multitrack').status, 'ok');
    assert.equal(link.evaluate('stereo').status, 'mismatch');
    link.simulateRouting('stereo');
    assert.ok(await until(() => link.evaluate('multitrack').status === 'mismatch'));
    assert.match(link.evaluate('stereo').labels[0], /OUT1-8/);
    // Angelernt gilt vor der Faustregel.
    assert.equal(link.evaluate('stereo', { multitrack: ROUTING_STEREO }).status, 'mismatch');
    // Mit Adresse wird nicht simuliert.
    await link.configure({ host: '127.0.0.1', simulate: true });
    assert.equal(link.state().simulated, false);
    await link.configure({});
    assert.equal(link.state().configured, false);
  } finally {
    link.stop();
  }
});
