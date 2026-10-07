'use strict';

/* Hilfen für die Tests: Die Module des Hauptprozesses laden "./settings", das wiederum Electron
   braucht. Hier wird es durch ein einfaches Objekt ersetzt, damit die Tests ohne Electron laufen. */

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const values = {};
const fakeSettings = {
  get: (key) => values[key],
  load: () => values,
  save: (patch) => Object.assign(values, patch),
  churchToolsToken: () => values.churchToolsToken || 'token'
};

const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === './settings' && parent && /[\\/]src[\\/]main[\\/]/.test(parent.filename)) return fakeSettings;
  return originalLoad.call(this, request, parent, ...rest);
};

/** Setzt Einstellungen (vorher alles leeren). */
function setSettings(patch) {
  Object.keys(values).forEach((k) => delete values[k]);
  Object.assign(values, { sampleRate: 48000 }, patch);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ebbton-test-'));
}

/** Stille als Audioblock (Int16 Stereo). */
function silence(seconds, rate = 48000) {
  return Buffer.alloc(Math.round(seconds * rate) * 4);
}

/** Sinuston als Audioblock (Int16 Stereo). */
function tone(seconds, rate = 48000) {
  const frames = Math.round(seconds * rate);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin(i / 10) * 8000);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

const src = (rel) => path.join(__dirname, '..', 'src', rel);

module.exports = { setSettings, tmpDir, silence, tone, src };
