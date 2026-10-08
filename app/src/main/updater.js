'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const RELEASES_URL = 'https://github.com/paddepf/ebbton/releases/latest';
const CHECK_INTERVAL = 2 * 60 * 60 * 1000;   // alle zwei Stunden erneut prüfen (Kirchen-PC läuft oft lange)
const INSTALL_DELAY = 2500;                   // so lange steht „Wird installiert …“, bevor die App beendet wird

/**
 * Updates über GitHub Releases (öffentliches Repository, kein Token zum Herunterladen nötig).
 *
 * Ablauf – jeder Schritt nur mit Zustimmung:
 *   Suche (automatisch oder per Knopf) → „Version X verfügbar, herunterladen?“ → Download mit Fortschritt
 *   → „Jetzt installieren und neu starten?“ → Installation ohne weitere Fenster → Neustart → Hinweis „aktualisiert“.
 *
 * Wichtigste Regel: Während einer laufenden oder pausierten Aufnahme wird weder heruntergeladen noch
 * installiert oder neu gestartet. Beim Beenden der App wird nie ungefragt installiert.
 */
class Updater extends EventEmitter {
  /**
   * @param {() => boolean} isBusy  läuft gerade eine Aufnahme?
   * @param {{ autoUpdater?: object, version?: string, logFile?: string }} [opts]  für Tests
   */
  constructor(isBusy, opts = {}) {
    super();
    this.isBusy = isBusy || (() => false);
    this.opts = opts;
    this.autoUpdater = null;
    this.currentVersion = opts.version || null;
    this.state = 'idle';   // idle | checking | current | available | downloading | ready | installing | error | manual | unavailable
    this.available = null; // { version, releaseDate, notes }
    this.downloaded = false;
    this.progress = null;  // { percent, transferred, total, bytesPerSecond }
    this.error = null;
    this.errorDuring = null; // check | download | install
    this.manual = false;   // letzte Suche per Knopf (dann wird auch „aktuell“ bzw. ein Fehler gemeldet)
    this.lastCheck = null;
    this.justUpdated = null;
    this.timers = [];
  }

  init() {
    let au = this.opts.autoUpdater;
    if (!au) {
      // Nicht gepackt (npm run dev): Es gibt nichts zu aktualisieren.
      try { if (!require('electron').app.isPackaged) { this.state = 'unavailable'; return; } } catch { /* außerhalb von Electron */ }
      try {
        au = require('electron-updater').autoUpdater;
      } catch {
        this.state = 'unavailable';
        return;
      }
    }
    this.autoUpdater = au;
    if (!this.currentVersion) {
      try { this.currentVersion = require('electron').app.getVersion(); } catch { this.currentVersion = null; }
    }
    this._rememberVersion();

    au.autoDownload = false;           // erst nach Rückfrage herunterladen
    au.autoInstallOnAppQuit = false;   // beim Beenden nie ungefragt installieren
    au.allowPrerelease = false;
    au.fullChangelog = true;           // Hinweise aller übersprungenen Versionen, nicht nur der neuesten
    au.logger = this._logger();

    au.on('checking-for-update', () => this._set('checking'));
    au.on('update-available', (info) => {
      this.available = { version: info.version, releaseDate: info.releaseDate || null, notes: releaseNotesText(info.releaseNotes) };
      this._set('available');
    });
    au.on('update-not-available', () => this._set('current'));
    au.on('download-progress', (p) => {
      this.progress = {
        percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))),
        transferred: p.transferred || 0,
        total: p.total || 0,
        bytesPerSecond: p.bytesPerSecond || 0
      };
      this._set('downloading');
    });
    au.on('update-downloaded', (info) => {
      this.downloaded = true;
      this.progress = this.progress ? { ...this.progress, percent: 100 } : null;
      if (info?.version && this.available) this.available.version = info.version;
      this._set('ready');
    });
    au.on('error', (err) => this._fail(err));

    // Die Einstellung wird bei jedem Termin neu gelesen: Wer sie später einschaltet, bekommt die Suche ohne Neustart.
    this.timers.push(setTimeout(() => this._autoCheck(), 8000));
    this.timers.push(setInterval(() => this._autoCheck(), CHECK_INTERVAL));
  }

  dispose() {
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.timers = [];
  }

  /** Merkt die laufende Version; nach einem Update meldet `status().justUpdated` den Wechsel. */
  _rememberVersion() {
    if (!this.currentVersion) return;
    const prev = settings.get('lastVersion');
    if (prev && prev !== this.currentVersion) this.justUpdated = { from: prev, to: this.currentVersion };
    if (prev !== this.currentVersion) settings.save({ lastVersion: this.currentVersion });
  }

  _autoCheck() {
    if (!settings.get('autoUpdateCheck')) return;
    // Was schon gefunden, geladen oder gerade in Arbeit ist, nicht erneut suchen.
    if (['checking', 'available', 'downloading', 'ready', 'installing', 'manual'].includes(this.state)) return;
    this.check({ manual: false });
  }

  _set(state) {
    this.state = state;
    if (state !== 'error' && state !== 'manual') { this.error = null; this.errorDuring = null; }
    this.emit('status', this.status());
  }

  _fail(err) {
    const message = String(err?.message || err || 'Unbekannter Fehler');
    const during = this.state === 'downloading' ? 'download'
      : this.state === 'installing' ? 'install'
        : this.state === 'checking' ? 'check' : (this.errorDuring || 'check');
    // macOS ohne Entwicklerzertifikat: Updates lassen sich nicht automatisch einspielen. Das ist kein
    // Fehler im Betrieb – stattdessen einen klaren Hinweis und den Weg zur Download-Seite geben.
    if (process.platform === 'darwin' && /signature|signed|codesign|ShipIt|code object/i.test(message)) {
      this.error = 'Auf dem Mac ohne Entwicklerzertifikat lassen sich Updates nicht automatisch einspielen – neue Version bitte von GitHub laden.';
      this.errorDuring = during;
      this._set('manual');
      return;
    }
    // Bei der automatischen Suche ist „kein Netz“ normal (Kirchen-PC offline): merken, aber nicht als Problem melden.
    if (during === 'check' && !this.manual) {
      this.error = message;
      this.errorDuring = during;
      this.state = this.available ? 'available' : 'idle';
      this.emit('status', this.status());
      return;
    }
    // Nach einem fehlgeschlagenen Download bleibt die gefundene Version bekannt, damit „Erneut versuchen“ geht.
    if (during === 'download') this.progress = null;
    this.error = message;
    this.errorDuring = during;
    this._set('error');
  }

  check({ manual = false } = {}) {
    if (!this.autoUpdater) return { ok: false, error: 'Die Update-Funktion ist in dieser Umgebung nicht verfügbar (nur in der installierten App).' };
    if (['downloading', 'installing'].includes(this.state)) return { ok: true, status: this.status() };
    if (this.state === 'ready') { this.emit('status', this.status()); return { ok: true, status: this.status() }; }
    // Während einer Aufnahme keine Netz- und Plattenlast durch die automatische Suche.
    if (!manual && this.isBusy()) return { ok: false, error: 'Während einer Aufnahme wird nicht nach Updates gesucht.' };
    this.manual = manual;
    this.lastCheck = Date.now();
    this.state = 'checking';
    Promise.resolve()
      .then(() => this.autoUpdater.checkForUpdates())
      .then((res) => {
        // Ohne Ergebnis (z. B. in der Entwicklungsumgebung) kommt kein Ereignis – sonst hinge „Suche läuft“.
        if (res == null && this.state === 'checking') this._set('current');
      })
      .catch((err) => { if (this.state === 'checking') this._fail(err); });
    return { ok: true };
  }

  /** Lädt die gefundene Version herunter – nur auf ausdrücklichen Wunsch und nicht während einer Aufnahme. */
  download() {
    if (!this.autoUpdater) return { ok: false, error: 'Die Update-Funktion ist nicht verfügbar.' };
    if (this.state === 'downloading') return { ok: true };
    if (this.downloaded) return { ok: true };
    if (!this.available) return { ok: false, error: 'Es wurde noch keine neue Version gefunden.' };
    if (this.isBusy()) return { ok: false, error: 'Während einer Aufnahme wird nicht heruntergeladen. Erst die Aufnahme beenden.' };
    this.progress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };
    this._set('downloading');
    Promise.resolve()
      .then(() => this.autoUpdater.downloadUpdate())
      .catch((err) => { if (this.state === 'downloading') this._fail(err); });
    return { ok: true };
  }

  /** Installiert und startet neu – nur wenn keine Aufnahme aktiv ist. */
  install() {
    if (!this.downloaded) return { ok: false, error: 'Es liegt kein fertig heruntergeladenes Update bereit.' };
    if (this.state === 'installing') return { ok: true };
    if (this.isBusy()) {
      return { ok: false, error: 'Während einer laufenden Aufnahme wird nicht aktualisiert. Erst die Aufnahme beenden.' };
    }
    this._set('installing');
    // Kurz warten, damit die Oberfläche „Wird installiert …“ zeigt. Dann still installieren (keine Fragen des
    // Installers, gleicher Ordner) und die App danach selbst wieder starten.
    const t = setTimeout(() => {
      if (this.isBusy()) { this._set('ready'); return; }
      try {
        this.autoUpdater.quitAndInstall(true, true);
      } catch (err) {
        this._fail(err);
      }
    }, this.opts.installDelay ?? INSTALL_DELAY);
    this.timers.push(t);
    return { ok: true };
  }

  status() {
    return {
      state: this.state,
      currentVersion: this.currentVersion,
      version: this.available?.version || null,
      releaseDate: this.available?.releaseDate || null,
      notes: this.available?.notes || '',
      downloaded: this.downloaded,
      progress: this.progress,
      error: this.error,
      errorDuring: this.errorDuring,
      manual: this.manual,
      lastCheck: this.lastCheck,
      justUpdated: this.justUpdated,
      busy: this.isBusy(),
      blockedByRecording: (this.downloaded || Boolean(this.available)) && this.isBusy(),
      releasesUrl: RELEASES_URL
    };
  }

  /** Protokoll in `<userData>/logs/updater.log`, damit sich Probleme am Kirchen-PC nachvollziehen lassen. */
  _logger() {
    let file = this.opts.logFile;
    if (file === undefined) {
      try { file = path.join(require('electron').app.getPath('userData'), 'logs', 'updater.log'); } catch { file = null; }
    }
    const write = (level, args) => {
      const line = `${new Date().toISOString()} [${level}] ${args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
      if (level !== 'info') console.warn('Updater:', ...args);
      if (!file) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Nicht endlos wachsen lassen.
        try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1'); } catch { /* noch keine Datei */ }
        fs.appendFileSync(file, line, 'utf8');
      } catch { /* Protokoll ist nur Hilfe */ }
    };
    return {
      info: (...a) => write('info', a),
      warn: (...a) => write('warn', a),
      error: (...a) => write('error', a),
      debug: () => {}
    };
  }
}

/** Versionshinweise aus GitHub (HTML oder Liste je Version) als schlichten Text. */
function releaseNotesText(notes) {
  if (!notes) return '';
  if (Array.isArray(notes)) {
    // fullChangelog: eine Liste aller neueren Versionen, neueste zuerst
    return notes
      .map((n) => ({ version: n?.version, text: releaseNotesText(n?.note) }))
      .filter((n) => n.text)
      .map((n) => (notes.length > 1 && n.version ? `Version ${n.version}\n${n.text}` : n.text))
      .join('\n\n');
  }
  return String(notes)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|li|h\d|div)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .split('\n')
    // Ohne Beschreibung setzt GitHub die Tag-Nachricht ein („Version 1.0.3“, „Co-Authored-By: …“) – das ist kein Inhalt.
    .filter((line) => !/^\s*(Version\s+v?\d+(\.\d+)*\s*|Co-Authored-By:.*|No content\.?\s*)$/i.test(line))
    .join('\n')
    .replace(/^- /gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { Updater, releaseNotesText, RELEASES_URL };
