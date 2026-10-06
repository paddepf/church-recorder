'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setSettings, tmpDir, silence, src } = require('./helpers');

setSettings({ recordingsDir: tmpDir() });
const { Session } = require(src('main/session'));

/** Neue Session mit eigenem Ordner; nach jedem Test wird eine laufende Aufnahme beendet. */
async function withSession(fn) {
  setSettings({ recordingsDir: tmpDir() });
  const s = new Session();
  try {
    await fn(s);
  } finally {
    if (s.status === 'recording' || s.status === 'paused') s.stop();
    await s.whenWritten();
    s._stopAutosave();
    if (s._saveTimer) clearTimeout(s._saveTimer);
  }
}

const labels = (s) => s.placedSections().map((x) => `${x.label}:${x.start}-${x.end}`).join(' | ');

test('Abschnitte starten, beenden, N und Rückgängig', () => withSession(async (s) => {
  s.setAgenda([{ id: null, title: 'A' }, { id: null, title: 'B' }], 'plan');
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(5));
  s.toggleSection({});
  s.pushAudio(silence(5));
  s.toggleSection({});
  assert.equal(labels(s), 'Abschnitt 1:5-10');
  s.undo();
  assert.equal(labels(s), 'Abschnitt 1:5-null');
  s.redo();
  s.startNextPending();
  assert.match(labels(s), /A:10-null/);
}));

test('Ablegen in eine Lücke füllt sie genau', () => withSession(async (s) => {
  s.setAgenda([{ id: null, title: 'Lied' }], 'plan');
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(60));
  s.startSection({ time: 10, label: 'A' }); s.endSection(20);
  s.startSection({ time: 40, label: 'B' }); s.endSection(50);
  const id = s.pendingSections()[0].id;
  assert.equal(s.placePending(id, 30).ok, true);
  assert.equal(labels(s), 'A:10-20 | Lied:20-40 | B:40-50');
}));

test('Schnitte: umschalten, verschmelzen, beim Stop schließen', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(20));
  s.toggleCut(12); s.toggleCut(14);
  s.addCut(13, 16);
  assert.deepEqual(s.cuts.map((c) => [c.start, c.end]), [[12, 16]]);
  assert.equal(s.addCut(NaN, 3).ok, false);
  s.toggleCut(18);
  s.stop();
  assert.deepEqual(s.cuts.map((c) => [c.start, c.end]), [[12, 16], [18, 20]]);
}));

test('Datei wird sofort angelegt, Änderungen nach dem Stop werden gespeichert', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  assert.ok(fs.existsSync(s.sessionFilePath()));
  s.pushAudio(silence(10));
  s.stop();
  await s.whenWritten();
  s.startSection({ time: 2, label: 'Nachher' });
  s.endSection(5);
  await new Promise((r) => setTimeout(r, 1000));
  const saved = JSON.parse(fs.readFileSync(s.sessionFilePath(), 'utf8'));
  assert.deepEqual(saved.sections.map((x) => x.label), ['Nachher']);
}));

test('Vorlage zweimal laden erzeugt keine Doppelten', () => withSession(async (s) => {
  const items = [{ id: null, title: 'Predigt' }, { id: null, title: 'Segen' }];
  s.setAgenda(items, 'plan');
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(2));
  s.startNextPending();
  s.setAgenda(items, 'plan');
  assert.deepEqual(s.sections.map((x) => x.label).sort(), ['Predigt', 'Segen']);
}));

test('Interpreten aus der Dienstplanung werden zugeordnet', () => withSession(async (s) => {
  s.setService({ id: 1, name: 'Test', suggestions: [{ role: 'Predigt 2', name: 'Ben' }] });
  const n = s.setAgenda([{ id: null, title: 'Predigt' }, { id: null, title: 'Einleitung' }], 'plan');
  assert.equal(n, 1);
  assert.deepEqual(s.pendingSections().map((x) => x.artist), ['Ben', null]);
}));

test('Infotext des Termins landet im Predigt-Abschnitt, nur einmal', () => withSession(async (s) => {
  s.setService({ id: 1, name: 'Bibelstunde', date: '2026-10-07', info: 'Kolosser 2,6-7 Verwurzelt in Christus' });
  const items = [{ id: null, title: 'Einleitung' }, { id: null, title: 'Predigt' }];
  s.setAgenda(items, 'plan');
  assert.deepEqual(s.sections.map((x) => x.label), ['Einleitung', 'Predigt: Kolosser 2,6-7 Verwurzelt in Christus']);
  // Erneutes Laden: kein Doppelter, kein zweites Anhängen
  s.setAgenda(items, 'plan');
  assert.equal(s.sections.filter((x) => x.label.startsWith('Predigt')).length, 1);
  assert.equal(s.sections.find((x) => x.label.startsWith('Predigt')).label, 'Predigt: Kolosser 2,6-7 Verwurzelt in Christus');
  // Ohne Infotext bleibt alles wie es ist
  const t = new (require(src('main/session')).Session)();
  t.setService({ name: 'X' });
  t.setAgenda([{ id: null, title: 'Predigt' }], 'plan');
  assert.equal(t.sections[0].label, 'Predigt');
  t._stopAutosave();
}));

test('alte Sessions mit Einzelmarkern werden übernommen', () => withSession(async (s) => {
  const dir = tmpDir();
  const file = path.join(dir, 'alt.session.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, duration: 10,
    markers: [{ id: 'a', label: 'A', time: 1, placed: true, source: 'manual' }, { id: 'b', label: 'B', time: 3, placed: true, source: 'manual' }]
  }));
  s.loadFromFile(file);
  assert.deepEqual(s.sections.map((x) => [x.label, x.start, x.end]), [['A', 1, 3], ['B', 3, 10]]);
}));

test('Fortsetzen hängt an dieselbe Datei an', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(3));
  s.stop();
  await s.whenWritten();
  assert.equal(s.continueRecording().ok, true);
  s.pushAudio(silence(2));
  s.stop();
  await s.whenWritten();
  const { readInfo } = require(src('main/wav'));
  assert.equal(readInfo(s.wavPath).duration, 5);
}));
