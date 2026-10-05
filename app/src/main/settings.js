'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

const LEGACY_FILE_PATTERN = '{datum}_{gottesdienst}_{abschnitt}';

const DEFAULTS = {
  // Audio
  inputDeviceId: '',
  inputDeviceLabel: '',
  outputDeviceId: '',           // Wiedergabe/Mithören; leer = Systemstandard
  outputDeviceLabel: '',
  sampleRate: 48000,

  // Ablage
  recordingsDir: '',            // wird beim ersten Start gesetzt
  fileNamePattern: '{interpret}_{abschnitt}_{gottesdienst}_{datum}',
  exportDir: '',                // Oberordner für MP3-Exporte; leer = beim Export nachfragen
  mp3Bitrate: 192,
  defaultArtist: '',            // Interpret in den ID3-Tags, wenn ein Abschnitt keinen eigenen hat
  keepMasterWavDays: 0,         // 0 = nie automatisch löschen

  // ChurchTools
  churchToolsUrl: '',           // z. B. https://meinegemeinde.church.tools
  churchToolsToken: '',         // verschlüsselt abgelegt (siehe unten)
  churchToolsCalendarIds: [],   // leer = alle
  autoLoadTodaysService: true,

  // Netzwerk
  networkEnabled: true,
  networkPort: 8765,
  networkPassword: '',          // Vollzugriff (Companion)
  monitorPassword: '',          // optional: nur lesen (Dashboard). Leer = deaktiviert.

  // Updates
  autoUpdateCheck: true,

  // UI
  theme: 'dark',                // 'dark' | 'light' | 'system'
  waveformZoom: 12              // Pixel pro Sekunde
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'settings.json');
  return filePath;
}

function defaultRecordingsDir() {
  const docs = app.getPath('documents') || os.homedir();
  return path.join(docs, 'Gottesdienst-Aufnahmen');
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...stored };
  // Wer das alte Standardmuster nie geändert hat, bekommt das neue Standardmuster.
  if (stored.fileNamePattern === LEGACY_FILE_PATTERN) cache.fileNamePattern = DEFAULTS.fileNamePattern;
  if (!cache.recordingsDir) cache.recordingsDir = defaultRecordingsDir();
  try {
    fs.mkdirSync(cache.recordingsDir, { recursive: true });
  } catch { /* Ordner wird beim Aufnahmestart erneut geprüft */ }
  return cache;
}

function save(patch) {
  const current = load();
  Object.assign(current, patch || {});
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(current, null, 2), 'utf8');
  } catch (err) {
    console.error('Einstellungen konnten nicht gespeichert werden:', err);
  }
  return current;
}

/* --- Token-Verschlüsselung -------------------------------------------------
   Der ChurchTools-Token wird, wenn das Betriebssystem es unterstützt, über
   Electrons safeStorage verschlüsselt abgelegt. Fällt das aus, wird er als
   Klartext gespeichert und die UI weist darauf hin.                          */

function encryptSecret(value) {
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(value).toString('base64');
    }
  } catch { /* Fallback unten */ }
  return 'plain:' + Buffer.from(value, 'utf8').toString('base64');
}

function decryptSecret(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8');
    }
  } catch (err) {
    console.error('Token konnte nicht entschlüsselt werden:', err);
    return '';
  }
  return stored; // Alt-Format
}

/** Einstellungen für die UI – Geheimnisse werden nur als "gesetzt/nicht gesetzt" gemeldet. */
function forRenderer() {
  const s = load();
  return {
    ...s,
    churchToolsToken: undefined,
    churchToolsTokenSet: Boolean(s.churchToolsToken),
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  };
}

module.exports = {
  DEFAULTS,
  load,
  save,
  forRenderer,
  encryptSecret,
  decryptSecret,
  get: (key) => load()[key],
  churchToolsToken: () => decryptSecret(load().churchToolsToken)
};
