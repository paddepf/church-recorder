'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { setSettings } = require('./helpers');
const { Updater, releaseNotesText } = require('../src/main/updater');

/** Nachgebauter electron-updater: Ereignisse lösen die Tests selbst aus. */
function fakeAutoUpdater() {
  const au = new EventEmitter();
  au.calls = [];
  au.checkForUpdates = () => { au.calls.push('check'); au.emit('checking-for-update'); return Promise.resolve({}); };
  au.downloadUpdate = () => { au.calls.push('download'); return Promise.resolve([]); };
  au.quitAndInstall = (silent, run) => { au.calls.push(`install:${silent}:${run}`); };
  return au;
}

function makeUpdater(busy = { v: false }) {
  const au = fakeAutoUpdater();
  const up = new Updater(() => busy.v, { autoUpdater: au, version: '1.0.1', logFile: null, installDelay: 0 });
  up.init();
  up.dispose();   // keine Zeitgeber im Test
  return { up, au, busy };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('lädt nicht von selbst herunter und installiert nicht beim Beenden', () => {
  setSettings({ autoUpdateCheck: true });
  const { au } = makeUpdater();
  assert.equal(au.autoDownload, false);
  assert.equal(au.autoInstallOnAppQuit, false);
});

test('Ablauf: gefunden → Download auf Wunsch → bereit → Installation still mit Neustart', async () => {
  setSettings({ autoUpdateCheck: true });
  const { up, au } = makeUpdater();
  const states = [];
  up.on('status', (s) => states.push(s.state));

  assert.equal(up.check({ manual: true }).ok, true);
  await tick();
  au.emit('update-available', { version: '1.0.2', releaseNotes: '<p>Neu: <b>Updates</b></p>' });
  assert.equal(up.status().state, 'available');
  assert.equal(up.status().notes, 'Neu: Updates');
  assert.ok(!au.calls.includes('download'));

  assert.equal(up.download().ok, true);
  await tick();
  assert.ok(au.calls.includes('download'));
  au.emit('download-progress', { percent: 41.6, transferred: 40e6, total: 96e6, bytesPerSecond: 5e6 });
  assert.equal(up.status().progress.percent, 42);
  au.emit('update-downloaded', { version: '1.0.2' });
  assert.equal(up.status().state, 'ready');

  assert.equal(up.install().ok, true);
  assert.equal(up.status().state, 'installing');
  await tick();
  assert.ok(au.calls.includes('install:true:true'));
  assert.deepEqual(states, ['checking', 'available', 'downloading', 'downloading', 'ready', 'installing']);
});

test('während einer Aufnahme: keine automatische Suche, kein Download, keine Installation', async () => {
  setSettings({ autoUpdateCheck: true });
  const { up, au, busy } = makeUpdater();
  busy.v = true;
  assert.equal(up.check().ok, false);
  au.emit('update-available', { version: '1.0.2' });
  assert.equal(up.download().ok, false);
  busy.v = false;
  up.download();
  au.emit('update-downloaded', { version: '1.0.2' });
  busy.v = true;
  assert.equal(up.install().ok, false);
  assert.equal(up.status().blockedByRecording, true);
  assert.ok(!au.calls.some((c) => c.startsWith('install')));
});

test('Aufnahme beginnt zwischen Klick und Installation: nicht installieren', async () => {
  setSettings({ autoUpdateCheck: true });
  const { up, au, busy } = makeUpdater();
  au.emit('update-available', { version: '1.0.2' });
  up.download();
  au.emit('update-downloaded', { version: '1.0.2' });
  up.install();
  busy.v = true;
  await tick();
  assert.equal(up.status().state, 'ready');
  assert.ok(!au.calls.some((c) => c.startsWith('install')));
});

test('Fehler der automatischen Suche (offline) sind kein Fehlerzustand, bei manueller Suche schon', async () => {
  setSettings({ autoUpdateCheck: true });
  const { up, au } = makeUpdater();
  au.checkForUpdates = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'));
  up.check();
  await tick();
  assert.equal(up.status().state, 'idle');
  assert.match(up.status().error, /DISCONNECTED/);

  up.check({ manual: true });
  await tick();
  assert.equal(up.status().state, 'error');
  assert.equal(up.status().errorDuring, 'check');
});

test('Downloadfehler: Version bleibt bekannt, erneuter Download möglich', async () => {
  setSettings({ autoUpdateCheck: true });
  const { up, au } = makeUpdater();
  au.emit('update-available', { version: '1.0.2' });
  up.download();
  au.emit('error', new Error('ECONNRESET'));
  assert.equal(up.status().state, 'error');
  assert.equal(up.status().errorDuring, 'download');
  assert.equal(up.status().version, '1.0.2');
  assert.equal(up.download().ok, true);
  assert.equal(up.status().state, 'downloading');
});

test('meldet nach einem Update die alte und neue Version', () => {
  setSettings({ autoUpdateCheck: true, lastVersion: '1.0.0' });
  const { up } = makeUpdater();
  assert.deepEqual(up.status().justUpdated, { from: '1.0.0', to: '1.0.1' });
  const again = makeUpdater().up;
  assert.equal(again.status().justUpdated, null);
});

test('Versionshinweise als Text', () => {
  assert.equal(releaseNotesText('<ul><li>Eins</li><li>Zwei</li></ul>'), '• Eins\n• Zwei');
  assert.equal(releaseNotesText([{ note: 'A &amp; B' }]), 'A & B');
  assert.equal(releaseNotesText(null), '');
});

test('Ersatztext von GitHub (Tag-Nachricht) gilt als leer, Notizen mehrerer Versionen mit Überschrift', () => {
  const tagOnly = '<p>Version 1.0.3</p>\n\n<p>Co-Authored-By: Claude Opus 5.5 &lt;noreply@anthropic.com&gt;</p>';
  assert.equal(releaseNotesText(tagOnly), '');
  assert.equal(releaseNotesText([{ version: '1.0.4', note: tagOnly }]), '');
  assert.equal(
    releaseNotesText([{ version: '1.0.5', note: '<ul><li>Neu A</li></ul>' }, { version: '1.0.4', note: tagOnly }]),
    'Version 1.0.5\n• Neu A');
  assert.equal(releaseNotesText('- Erstens\n- Zweitens'), '• Erstens\n• Zweitens');
});
