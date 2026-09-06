'use strict';

const { EventEmitter } = require('events');
const settings = require('./settings');

/**
 * Updates über GitHub Releases (privates Repository).
 *
 * Wichtigste Regel: Während einer laufenden oder pausierten Aufnahme wird
 * niemals installiert oder neu gestartet. Ein heruntergeladenes Update wartet,
 * bis die Aufnahme beendet ist – oder bis zum nächsten regulären Beenden.
 */
class Updater extends EventEmitter {
  constructor(isBusy) {
    super();
    this.isBusy = isBusy || (() => false);
    this.available = null;
    this.downloaded = false;
    this.state = 'idle';   // idle | checking | available | downloading | ready | error | current
    this.autoUpdater = null;
  }

  init() {
    try {
      const { autoUpdater } = require('electron-updater');
      this.autoUpdater = autoUpdater;
    } catch {
      this.state = 'unavailable';
      return;
    }
    const au = this.autoUpdater;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.allowPrerelease = false;

    au.on('checking-for-update', () => this._set('checking'));
    au.on('update-available', (info) => {
      this.available = { version: info.version, releaseDate: info.releaseDate };
      this._set('downloading', { version: info.version });
    });
    au.on('update-not-available', () => this._set('current'));
    au.on('download-progress', (p) => {
      this.emit('status', { state: 'downloading', percent: Math.round(p.percent), version: this.available?.version });
    });
    au.on('update-downloaded', (info) => {
      this.downloaded = true;
      this._set('ready', { version: info.version });
    });
    au.on('error', (err) => {
      this._set('error', { message: String(err?.message || err) });
    });

    if (settings.get('autoUpdateCheck')) {
      setTimeout(() => this.check(), 8000);
      // Während langer Sessions gelegentlich erneut prüfen.
      setInterval(() => this.check(), 6 * 60 * 60 * 1000);
    }
  }

  _set(state, extra) {
    this.state = state;
    this.emit('status', { state, ...extra });
  }

  check() {
    if (!this.autoUpdater) return { ok: false, error: 'Update-Funktion ist in dieser Umgebung nicht verfügbar.' };
    this.autoUpdater.checkForUpdates().catch((err) => this._set('error', { message: String(err?.message || err) }));
    return { ok: true };
  }

  /** Installiert und startet neu – nur wenn keine Aufnahme aktiv ist. */
  install() {
    if (!this.downloaded) return { ok: false, error: 'Es liegt kein fertiges Update bereit.' };
    if (this.isBusy()) {
      return { ok: false, error: 'Während einer laufenden Aufnahme wird nicht aktualisiert. Erst Aufnahme beenden.' };
    }
    setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  }

  status() {
    return {
      state: this.state,
      version: this.available?.version || null,
      downloaded: this.downloaded,
      blockedByRecording: this.downloaded && this.isBusy()
    };
  }
}

module.exports = { Updater };
