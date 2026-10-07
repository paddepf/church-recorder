'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, systemPreferences, powerSaveBlocker } = require('electron');

const settings = require('./settings');
const { Session, slug, dateStamp } = require('./session');
const { NetServer } = require('./netserver');
const { Updater } = require('./updater');
const churchtools = require('./churchtools');
const mp3 = require('./mp3');
const RoleLogic = require('../shared/roles');

let win = null;
const session = new Session();
const net = new NetServer();
const updater = new Updater(() => session.status === 'recording' || session.status === 'paused');

const isDev = process.argv.includes('--dev');

// Unbehandelte Fehler nur protokollieren und melden: Electrons Standard ist ein Fehlerdialog, der den
// Hauptprozess blockiert – und damit das Schreiben der Aufnahme.
process.on('uncaughtException', (err) => {
  console.error('Unbehandelter Fehler im Hauptprozess:', err);
  try { toast('error', `Interner Fehler: ${err.message}`); } catch { /* Fenster noch nicht da */ }
});
process.on('unhandledRejection', (err) => {
  console.error('Unbehandelte Ablehnung im Hauptprozess:', err);
});

/* -------------------------------------------------------------- Hilfsfunktionen */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(level, message) {
  send('toast', { level, message });
}

/* ------------------------------------------------------ Zustand für Netzwerk-Clients */

const health = { inputLost: false, silent: false, disk: null };
let silentSince = null;
const SILENT_LEVEL = 0.001;        // etwa -60 dBFS
const SILENT_AFTER_MS = 20000;

/** Freier Platz auf dem Laufwerk der Aufnahmen (Stunden bezogen auf die aktuelle Abtastrate). */
function diskInfo() {
  // Der Ordner kann noch nicht existieren: vom nächsten vorhandenen Elternordner messen.
  let dir = settings.get('recordingsDir');
  while (dir && !fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const st = fs.statfsSync(dir);
  const freeBytes = Number(st.bavail) * Number(st.bsize);
  const totalBytes = Number(st.blocks) * Number(st.bsize);
  const bytesPerHour = (settings.get('sampleRate') || 48000) * 2 * 2 * 3600;   // 16 Bit, Stereo
  return { freeBytes, totalBytes, hoursLeft: freeBytes / bytesPerHour, dir };
}

function currentHealth() {
  const input = health.inputLost || health.chunksStale ? 'lost' : (health.silent ? 'silent' : 'ok');
  const write = health.writeError ? 'error' : (health.writeSlow ? 'slow' : 'ok');
  const d = health.disk;
  const diskLevel = !d ? 'ok' : (d.hoursLeft < 0.5 ? 'low' : (d.hoursLeft < 3 ? 'warn' : 'ok'));
  return {
    input,
    write,
    writeMessage: health.writeError || null,
    disk: d ? { freeBytes: d.freeBytes, hoursLeft: d.hoursLeft, level: diskLevel } : null
  };
}

/** Meldet geänderte Gesundheitswerte an Oberfläche und Netzwerk. */
let lastHealthJson = '';
function publishHealth() {
  const h = currentHealth();
  const json = JSON.stringify(h);
  if (json === lastHealthJson) return;
  lastHealthJson = json;
  send('health', h);
  net.publishState({ ...session.snapshot(), health: h });
}

/* Wächter im Hauptprozess: kommen während der Aufnahme keine Audioblöcke mehr an (Oberfläche hängt,
   wurde neu geladen, Erfassung steht), wird das als ausgefallener Eingang gemeldet – auch an Companion. */
let lastChunkAt = 0;
const CHUNK_TIMEOUT_MS = 5000;
setInterval(() => {
  const stale = session.status === 'recording' && Date.now() - lastChunkAt > CHUNK_TIMEOUT_MS;
  if (stale !== Boolean(health.chunksStale)) {
    health.chunksStale = stale;
    publishHealth();
  }
}, 1000);

// Während der Aufnahme regelmäßig den vollständigen Zustand senden (Dauer, offene Abschnitte, Export-Liste),
// auch wenn gerade niemand etwas ändert.
setInterval(() => {
  if (session.status === 'recording') pushState(session.snapshot());
}, 5000);

function refreshDisk() {
  try { health.disk = diskInfo(); } catch { health.disk = null; }
  publishHealth();
}

function stateThrottle() {
  let pending = null;
  let timer = null;
  return (state) => {
    pending = state;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const s = pending;
      pending = null;
      send('state', s);
      net.publishState({ ...s, health: currentHealth() });
    }, 100);
  };
}
const pushState = stateThrottle();

function buildFileName(segmentLabel, artist) {
  const pattern = settings.get('fileNamePattern') || '{interpret}_{abschnitt}_{gottesdienst}_{datum}';
  const name = pattern
    .replace(/\{datum\}/g, session.service.date || dateStamp())
    .replace(/\{gottesdienst\}/g, slug(session.service.name, 'Gottesdienst'))
    .replace(/\{abschnitt\}/g, slug(segmentLabel, 'Abschnitt'))
    .replace(/\{interpret\}/g, artist ? slug(artist, '') : '')
    .replace(/\{zeit\}/g, recordingTime());
  // Ein leerer Platzhalter (z. B. ohne Interpret) soll keine doppelten oder führenden Trennzeichen hinterlassen.
  // Zu lange Namen kürzen: Viele Dateisysteme erlauben höchstens 255 Zeichen.
  const base = slug(name).replace(/-+/g, '-').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  return base.slice(0, 150).replace(/[_-]+$/g, '') + '.mp3';
}

/** Uhrzeit des Aufnahmebeginns als HHMM (für den Platzhalter {zeit}). */
function recordingTime() {
  const d = session.startedAt ? new Date(session.startedAt) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Fragt nach, wenn beim Schließen oder Beenden noch aufgenommen wird.
 * @returns {boolean} true, wenn fortgefahren werden darf
 */
let allowClose = false;      // nach bestätigtem Beenden nicht erneut fragen
let closePending = false;

function isBusy() {
  return session.status === 'recording' || session.status === 'paused';
}

/**
 * Fragt – ohne den Hauptprozess zu blockieren –, ob eine laufende Aufnahme beendet werden soll,
 * beendet sie dann und wartet, bis der Schreib-Thread alles auf der Platte hat.
 * @returns {Promise<boolean>} true, wenn geschlossen werden darf
 */
async function confirmAndFinishRecording() {
  if (isBusy()) {
    const parent = win && !win.isDestroyed() ? win : undefined;
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      buttons: ['Weiter aufnehmen', 'Aufnahme beenden und schließen'],
      defaultId: 0,
      cancelId: 0,
      title: 'Aufnahme läuft',
      message: 'Es läuft noch eine Aufnahme.',
      detail: 'Beim Schließen wird die Aufnahme gestoppt und gespeichert.'
    });
    if (response === 0) return false;
    if (isBusy()) session.stop();
  }
  await session.whenWritten();
  session.flushSave();
  return true;
}

/** Gemeinsamer Ablauf für Fenster schließen und App beenden. */
function guardClose(e, finish) {
  if (allowClose) return false;
  if (!isBusy() && !session.writing) return false;
  e.preventDefault();
  if (closePending) return true;
  closePending = true;
  confirmAndFinishRecording().then((go) => {
    closePending = false;
    if (go) {
      allowClose = true;
      finish();
    }
  });
  return true;
}

/**
 * Unter Windows und Linux stört die Menüleiste nur. Unter macOS liegt sie
 * oben am Bildschirm und trägt die Standardkürzel (Cmd+Q, Cmd+C, …), die
 * ohne Menü nicht funktionieren würden.
 */
function setupApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const template = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about', label: `Über ${app.getName()}` },
        { type: 'separator' },
        {
          label: 'Einstellungen …',
          accelerator: 'Cmd+,',
          click: () => send('menu', { action: 'settings' })
        },
        { type: 'separator' },
        { role: 'hide', label: 'Ausblenden' },
        { role: 'hideOthers', label: 'Andere ausblenden' },
        { role: 'unhide', label: 'Alle einblenden' },
        { type: 'separator' },
        { role: 'quit', label: 'Beenden' }
      ]
    },
    {
      label: 'Aufnahme',
      submenu: [
        {
          label: 'Aufnahme starten / beenden',
          accelerator: 'Cmd+R',
          click: () => send('menu', { action: 'toggle-record' })
        },
        {
          label: 'Abschnitt starten / beenden',
          accelerator: 'Cmd+M',
          click: () => send('menu', { action: 'marker' })
        },
        {
          label: 'Nächster Ablaufpunkt',
          accelerator: 'Cmd+Alt+N',
          click: () => send('menu', { action: 'next-item' })
        },
        { type: 'separator' },
        {
          label: 'Ordner mit Aufnahmen öffnen',
          click: () => shell.openPath(settings.get('recordingsDir'))
        }
      ]
    },
    {
      label: 'Bearbeiten',
      submenu: [
        // Eigene Einträge: in Textfeldern wirkt das Rückgängig dort, sonst auf Abschnitte und Schnitte.
        { label: 'Widerrufen', accelerator: 'Cmd+Z', click: () => send('menu', { action: 'undo' }) },
        { label: 'Wiederholen', accelerator: 'Shift+Cmd+Z', click: () => send('menu', { action: 'redo' }) },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einsetzen' },
        { role: 'selectAll', label: 'Alles auswählen' }
      ]
    },
    {
      label: 'Fenster',
      submenu: [
        // Ohne Tastenkürzel: Cmd+M gehört "Abschnitt starten / beenden".
        { label: 'Minimieren', click: () => win?.minimize() },
        { label: 'Mini-Fenster ein/aus', accelerator: 'Cmd+Shift+M', click: () => setCompact(!compact) },
        { role: 'zoom', label: 'Zoomen' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' }
        // Kein "Neu laden": Das beendete die Audioerfassung einer laufenden Aufnahme (und lag auf Cmd+R).
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------- Fenster */

// Nur im Dev-Modus: Renderer-Änderungen laden das Fenster neu, Änderungen an
// Main/Preload starten die App neu (nicht während einer laufenden Aufnahme).
function setupLiveReload() {
  const srcDir = path.join(__dirname, '..');
  let timer = null;
  fs.watch(srcDir, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const inRenderer = filename.split(path.sep)[0] === 'renderer';
      const busy = session.status === 'recording' || session.status === 'paused';
      if (inRenderer && busy) {
        // Die Audioerfassung läuft in der Oberfläche: nie während einer Aufnahme neu laden.
        toast('warn', 'Oberfläche geändert – Neuladen nach der Aufnahme nötig.');
      } else if (inRenderer) {
        if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
      } else if (busy) {
        toast('warn', 'Main-Prozess geändert – Neustart nach der Aufnahme nötig.');
      } else {
        app.relaunch({ args: process.argv.slice(1) });
        app.exit(0);
      }
    }, 200);
  });
}

/* ------------------------------------------------------------- Mini-Fenster */

// Kleines Fenster mit den nötigsten Knöpfen, damit nebenher am PC gearbeitet werden kann. Es ist dasselbe
// Fenster, nur verkleinert (die Oberfläche blendet den Rest per CSS aus): Die Audioerfassung läuft in der
// Oberfläche und darf dafür nicht neu geladen werden.
const NORMAL_MIN = { width: 1024, height: 680 };
// Größen des Mini-Fensters als Inhaltsgröße (ohne Titelleiste und Rahmen, die je System verschieden sind).
// 266 px Höhe genügen für alle Zeilen; erscheint der rote Warnbalken, scrollt der Inhalt.
const COMPACT_MIN = { width: 400, height: 266 };
const COMPACT_DEFAULT = { width: 480, height: 270 };
let compact = null;            // Lage des großen Fensters ({ bounds, maximized }), solange das Mini-Fenster aktiv ist

/** Platz für Titelleiste und Rahmen (Fenstergröße minus Inhaltsgröße). */
function frameSize() {
  const [w, h] = win.getSize();
  const [cw, ch] = win.getContentSize();
  return { width: w - cw, height: h - ch };
}

/** Zuletzt benutzte Lage des Mini-Fensters, wenn sie noch auf einem Bildschirm liegt; sonst unten rechts. */
function compactBounds() {
  const frame = frameSize();
  const minW = COMPACT_MIN.width + frame.width;
  const minH = COMPACT_MIN.height + frame.height;
  const defW = COMPACT_DEFAULT.width + frame.width;
  const defH = COMPACT_DEFAULT.height + frame.height;
  const saved = settings.get('compactBounds');
  if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      saved.x < a.x + a.width - 60 && saved.x + saved.width > a.x + 60
      && saved.y >= a.y - 10 && saved.y < a.y + a.height - 60);
    if (visible) {
      return {
        x: saved.x,
        y: saved.y,
        width: Math.max(saved.width, minW),
        height: Math.max(saved.height, minH)
      };
    }
  }
  const a = screen.getDisplayMatching(win.getBounds()).workArea;
  return {
    x: a.x + a.width - defW - 16,
    y: a.y + a.height - defH - 16,
    width: defW,
    height: defH
  };
}

const compactOnTop = () => settings.get('compactOnTop') !== false;

/** Das Mini-Fenster bleibt (abschaltbar) über anderen Programmen, das große nie. */
function applyOnTop() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(Boolean(compact) && compactOnTop(), 'floating');
}

/** Schaltet zwischen großem Fenster und Mini-Fenster um; die Oberfläche erfährt es über 'compact'. */
function setCompact(on) {
  if (!win || win.isDestroyed()) return false;
  if (on && !compact) {
    if (win.isFullScreen()) {
      // Im Vollbild lässt sich die Größe nicht ändern: erst verlassen, dann verkleinern.
      win.once('leave-full-screen', () => setCompact(true));
      win.setFullScreen(false);
      return false;
    }
    compact = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    if (compact.maximized) win.unmaximize();
    const frame = frameSize();
    win.setMinimumSize(COMPACT_MIN.width + frame.width, COMPACT_MIN.height + frame.height);
    win.setBounds(compactBounds());
  } else if (!on && compact) {
    settings.save({ compactBounds: win.getBounds() });
    const prev = compact;
    compact = null;
    win.setMinimumSize(NORMAL_MIN.width, NORMAL_MIN.height);
    win.setBounds(prev.bounds);
    if (prev.maximized) win.maximize();
  }
  applyOnTop();
  send('compact', { on: Boolean(compact), onTop: compactOnTop() });
  return Boolean(compact);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: NORMAL_MIN.width,
    minHeight: NORMAL_MIN.height,
    backgroundColor: '#101419',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    title: 'Ebbton',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (isDev) {
    // Die DevTools stören bei jedem Neustart (sie holen sich den Fokus). Daher nur
    // auf Wunsch: per F12 / Strg+Umschalt+I, oder dauerhaft mit "npm run dev:tools".
    if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach', activate: false });
    win.webContents.on('before-input-event', (event, input) => {
      const toggle = input.type === 'keyDown' && (input.key === 'F12'
        || (input.key.toLowerCase() === 'i' && input.shift && (input.control || input.meta)));
      if (toggle) {
        event.preventDefault();
        win.webContents.toggleDevTools();
      }
    });
    setupLiveReload();
  }

  // Mikrofon-/Eingangszugriff im Renderer erlauben.
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture');
  });

  win.on('close', (e) => {
    if (guardClose(e, () => { if (win && !win.isDestroyed()) win.close(); })) return;
    if (compact) settings.save({ compactBounds: win.getBounds() });
    session.flushSave();
    net.stop();
  });

  // Stürzt die Oberfläche ab, fehlt die Audioerfassung: neu laden – sie verbindet sich bei laufender
  // Aufnahme selbst wieder mit dem Eingang und schreibt in dieselbe Datei weiter.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Oberfläche beendet:', details.reason);
    if (details.reason === 'clean-exit') return;
    setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reload(); }, 500);
  });

  win.on('closed', () => { win = null; });
}

/* ------------------------------------------------------------- Verdrahtungen */

session.on('state', (s) => pushState(s));

session.on('levels', (levels) => {
  send('levels', levels);
  net.publishLevels(levels);

  // Stille: lange fast kein Pegel, obwohl aufgenommen wird (z. B. Mischpult stumm).
  const quiet = Math.max(levels.l, levels.r) < SILENT_LEVEL;
  if (!quiet) silentSince = null;
  else if (silentSince == null) silentSince = Date.now();
  const silent = quiet && silentSince != null && Date.now() - silentSince > SILENT_AFTER_MS;
  if (silent !== health.silent) {
    health.silent = silent;
    publishHealth();
  }
});

// Während der Aufnahme darf der Rechner nicht in den Ruhezustand: Beim Aufwachen
// liefert der Audioeingang sonst keine Daten mehr.
let sleepBlockerId = null;
function preventSleep(on) {
  if (on && sleepBlockerId == null) {
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!on && sleepBlockerId != null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

session.on('recording-started', () => {
  preventSleep(true);
  silentSince = null;
  health.silent = false;
  health.writeError = null;
  health.writeSlow = false;
  refreshDisk();
  net.publishEvent('recording.started', { wavPath: session.wavPath });
});

session.on('recording-stopped', (info) => {
  preventSleep(false);
  silentSince = null;
  health.silent = false;
  health.inputLost = false;
  refreshDisk();
  net.publishEvent('recording.stopped', info);
});

session.on('error-notice', (message) => toast('error', message));

// Schreib-Thread: Platte voll, Laufwerk entfernt, zu langsam … – sofort sichtbar machen, auch für Companion.
session.on('write-error', (err) => {
  health.writeError = `${err.code ? err.code + ': ' : ''}${err.message}`;
  toast('error', `Audio kann nicht gespeichert werden (${err.code || err.message}). Bitte Laufwerk prüfen!`);
  publishHealth();
});
session.on('write-slow', (slow) => {
  health.writeSlow = slow;
  if (slow) toast('warn', 'Das Laufwerk kommt mit dem Schreiben nicht hinterher – die Aufnahme wird im Speicher gepuffert.');
  publishHealth();
});

net.on('status', (info) => send('network-status', info));
net.on('error-notice', (message) => toast('error', message));

/* Rückmeldung für Fernbefehle: Start und Stopp laufen über die Oberfläche (dort ist die Audioerfassung).
   Die Antwort kommt erst, wenn die Aufnahme wirklich läuft bzw. beendet ist – oder mit Fehler. */
const remoteWaiters = new Map();
function waitForRemote(kind, eventName, ms = 8000) {
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      session.off(eventName, onEvent);
      remoteWaiters.delete(kind);
      resolve(result);
    };
    const onEvent = () => finish({ ok: true });
    const timer = setTimeout(() => finish({ ok: false, error: 'Keine Rückmeldung von der Aufnahme – bitte am Aufnahmerechner prüfen.' }), ms);
    session.once(eventName, onEvent);
    remoteWaiters.set(kind, finish);
  });
}
ipcMain.on('remote:result', (_e, { kind, ok: success, error } = {}) => {
  const finish = remoteWaiters.get(kind);
  if (finish && !success) finish({ ok: false, error: error || 'Die Aufnahme konnte nicht gestartet werden.' });
});

net.on('command', ({ action, params, reply }) => {
  const done = (result) => {
    reply(result);
    net.publishState({ ...session.snapshot(), health: currentHealth() });
  };
  switch (action) {
    case 'record.start':
      // Die Audioaufnahme selbst läuft im Renderer. Per Fernsteuerung ohne Rückfrage am PC starten:
      // eine angezeigte, beendete Aufnahme ist ohnehin als Datei gespeichert.
      if (session.status === 'recording') return done({ ok: false, error: 'Es läuft bereits eine Aufnahme.' });
      if (session.status === 'paused') return done(session.resume());
      waitForRemote('start', 'recording-started').then(done);
      send('command', { action: 'record.start', remote: true });
      return;
    case 'record.stop':
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      waitForRemote('stop', 'recording-stopped').then(done);
      send('command', { action: 'record.stop', remote: true });
      return;
    case 'record.pause':
      return done(session.pause());
    case 'record.resume':
      return done(session.resume());
    case 'record.toggle':
      // Auch eine pausierte Aufnahme wird beendet ("starten bzw. beenden").
      if (session.status === 'recording' || session.status === 'paused') {
        waitForRemote('stop', 'recording-stopped').then(done);
        send('command', { action: 'record.stop', remote: true });
        return;
      }
      waitForRemote('start', 'recording-started').then(done);
      send('command', { action: 'record.start', remote: true });
      return;
    case 'marker.add': {
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      // Abschnitt beginnen bzw. – wenn einer läuft – beenden.
      return done(session.toggleSection({ label: params.label, category: params.category }));
    }
    case 'marker.next': {
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      return done(session.startNextPending());
    }
    case 'cut.toggle': {
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      return done(session.toggleCut());
    }
    case 'undo':
      return done(session.undo());
    case 'redo':
      return done(session.redo());
    case 'template.apply': {
      const tpl = findTemplate(params.name || params.id);
      if (!tpl) return done({ ok: false, error: 'Vorlage nicht gefunden.' });
      session.setAgenda(templateItems(tpl), 'plan', tpl.name);
      return done({ ok: true, template: tpl.name });
    }
    default:
      return done({ ok: false, error: 'Unbekannter Befehl.' });
  }
});

updater.on('status', (s) => send('update-status', { ...s, ...updater.status() }));

/* ------------------------------------------------------------------- IPC-API */

function ok(data) { return { ok: true, ...(data || {}) }; }
function fail(error) { return { ok: false, error: String(error?.message || error) }; }

ipcMain.handle('app:info', () => ok({
  version: app.getVersion(),
  name: app.getName(),
  platform: process.platform,
  recordingsDir: settings.get('recordingsDir'),
  update: updater.status(),
  network: net.statusInfo(),
  compact: Boolean(compact),
  compactOnTop: compactOnTop()
}));

ipcMain.handle('window:compact', (_e, { on, onTop } = {}) => {
  if (typeof onTop === 'boolean') {
    settings.save({ compactOnTop: onTop });
    applyOnTop();
  }
  if (typeof on === 'boolean') setCompact(on);
  return ok({ on: Boolean(compact), onTop: compactOnTop() });
});

/** Freier Platz auf dem Laufwerk der Aufnahmen und was das in Aufnahmestunden bedeutet. */
ipcMain.handle('disk:free', () => {
  try { return ok(diskInfo()); } catch (err) { return fail(err); }
});

ipcMain.handle('settings:get', () => ok({ settings: settings.forRenderer() }));

ipcMain.handle('settings:set', (_e, patch) => {
  try {
    const clean = { ...patch };
    if (Object.prototype.hasOwnProperty.call(clean, 'churchToolsToken')) {
      clean.churchToolsToken = clean.churchToolsToken
        ? settings.encryptSecret(clean.churchToolsToken)
        : '';
    }
    // Nur bei tatsächlich geänderten Werten neu starten – sonst fliegen Companion und Dashboards bei
    // jedem Speichern kurz raus, auch mitten in der Aufnahme.
    const networkKeys = ['networkEnabled', 'networkPort', 'networkPassword', 'monitorPassword'];
    const networkChanged = networkKeys.some((k) => k in clean && clean[k] !== settings.get(k));
    if (('churchToolsUrl' in clean && clean.churchToolsUrl !== settings.get('churchToolsUrl')) || 'churchToolsToken' in clean) {
      churchtools.resetCache();
    }
    settings.save(clean);
    if (clean.recordingsDir) fs.mkdirSync(clean.recordingsDir, { recursive: true });
    if (networkChanged) {
      const result = settings.get('networkEnabled') ? net.restart() : (net.stop(), { ok: true });
      if (!result.ok) toast('warn', result.error);
      send('network-status', net.statusInfo());
    }
    return ok({ settings: settings.forRenderer() });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('settings:chooseFolder', async (_e, { title, defaultPath } = {}) => {
  // Nur auswählen – gespeichert wird erst mit "Einstellungen speichern" (der Dialog dient für mehrere Ordner).
  // Startordner immer setzen: Ohne defaultPath öffnet Electron (ab 43) den Downloads-Ordner.
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Ordner wählen',
    defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return ok({ canceled: true });
  return ok({ path: res.filePaths[0] });
});

ipcMain.handle('settings:chooseFile', async (_e, { title, filters }) => {
  const res = await dialog.showOpenDialog(win, { title, filters, properties: ['openFile'] });
  if (res.canceled || !res.filePaths[0]) return ok({ canceled: true });
  return ok({ path: res.filePaths[0] });
});

/* --- ChurchTools --- */

ipcMain.handle('ct:test', async () => {
  try { return ok(await churchtools.test()); } catch (err) { return fail(err); }
});

ipcMain.handle('ct:calendars', async () => {
  try { return ok({ calendars: await churchtools.listCalendars() }); } catch (err) { return fail(err); }
});

ipcMain.handle('ct:services', async (_e, { from, to } = {}) => {
  try {
    const today = churchtools.isoDate(new Date());
    return ok({ services: await churchtools.listServices(from || today, to || from || today) });
  } catch (err) { return fail(err); }
});

/* --- Vorlagen für Programmpunkte --- */

function templates() {
  const list = settings.get('agendaTemplates');
  return Array.isArray(list) ? list : [];
}

/** Vorlage nach Id oder Name; ohne Angabe die Standardvorlage. */
function findTemplate(key) {
  const list = templates();
  if (key) {
    const k = String(key).trim().toLowerCase();
    return list.find((t) => t.id === key) || list.find((t) => String(t.name).trim().toLowerCase() === k) || null;
  }
  return list.find((t) => t.id === settings.get('defaultTemplateId')) || list[0] || null;
}

/** Vorlage zum Titel eines Gottesdienstes (siehe `RoleLogic.templateForTitle`), sonst die Standardvorlage. */
function templateForTitle(title) {
  return RoleLogic.templateForTitle(templates(), title) || findTemplate();
}

/** Programmpunkte einer Vorlage (leere Einträge entfallen). */
function templateItems(tpl) {
  return (tpl && Array.isArray(tpl.items) ? tpl.items : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .map((title) => ({ id: null, title }));
}

ipcMain.handle('agenda:applyTemplate', (_e, { templateId } = {}) => {
  const tpl = findTemplate(templateId);
  if (!tpl) return fail('Vorlage nicht gefunden.');
  const items = templateItems(tpl);
  session.setAgenda(items, 'plan', tpl.name);
  return ok({ count: items.length, name: tpl.name });
});

ipcMain.handle('ct:agenda', async (_e, { eventId, name, date } = {}) => {
  try {
    let plan;
    try {
      plan = await churchtools.agenda(eventId);
    } catch (err) {
      // Für den Termin ist kein Ablaufplan gepflegt (404): mit den Standardpunkten weiterarbeiten.
      if (err.status !== 404) throw err;
      plan = { name: null, items: [] };
    }

    // Personen aus der Dienstplanung (Leitung, Predigt …) als Interpret-Vorschläge; Fehler stören nicht.
    const wanted = String(settings.get('artistServices') || '').split(',').map((x) => x.trim()).filter(Boolean);
    // Dienste mit fester Zuordnung (z. B. „Geschichte“ → Kinderbeitrag, „Leitung“ → Einleitung/Abschluss) werden immer mitgelesen.
    Object.keys(RoleLogic.ALIASES).forEach((w) => {
      if (!wanted.some((x) => RoleLogic.words(x).includes(w))) wanted.push(w);
    });
    let suggestions = [];
    let info = null;
    let suggestionError = null;
    try {
      const es = await churchtools.eventServices(eventId, wanted);
      suggestions = es.suggestions;
      info = es.info;
    } catch (err) {
      suggestionError = String(err?.message || err);
    }
    session.setService({ id: eventId, name: name || plan.name || 'Gottesdienst', date, suggestions, info });
    const usedDefaults = plan.items.length === 0;
    // Ohne Ablaufplan: die Vorlage, die zum Titel passt (sonst die Standardvorlage).
    const tpl = usedDefaults ? templateForTitle(session.service.name) : null;
    const items = usedDefaults ? templateItems(tpl) : plan.items;
    const autoFilled = session.setAgenda(items, usedDefaults ? 'plan' : 'churchtools', tpl ? tpl.name : null);
    return ok({ items, count: items.length, usedDefaults, templateName: tpl ? tpl.name : null, info, suggestions, suggestionError, wanted, autoFilled });
  } catch (err) { return fail(err); }
});

/* --- Session / Aufnahme --- */

ipcMain.handle('session:service', (_e, service) => {
  session.setService(service);
  // Ohne ChurchTools gibt es keinen Ablaufplan: Standardpunkte anbieten, solange noch nichts da ist.
  if (session.sections.length === 0) {
    const tpl = templateForTitle(session.service.name);
    session.setAgenda(templateItems(tpl), 'plan', tpl.name);
  }
  return ok({ state: session.snapshot() });
});

ipcMain.handle('rec:start', (_e, { sampleRate, channels } = {}) => {
  try { return session.start({ sampleRate, channels }); } catch (err) { return fail(err); }
});
ipcMain.handle('rec:continue', async () => {
  try {
    await session.whenWritten();      // die Datei der eben beendeten Aufnahme erst fertig schreiben lassen
    return session.continueRecording();
  } catch (err) { return fail(err); }
});
ipcMain.handle('rec:pause', () => {
  try { return session.pause(); } catch (err) { return fail(err); }
});
ipcMain.handle('rec:resume', () => {
  try { return session.resume(); } catch (err) { return fail(err); }
});
ipcMain.handle('rec:stop', () => {
  try { return session.stop(); } catch (err) { return fail(err); }
});

ipcMain.handle('audio:read', (_e, { start, seconds } = {}) => {
  try {
    const slice = session.readAudio(start, seconds);
    if (!slice) return fail('Keine Aufnahme zum Anhören vorhanden.');
    return ok({
      sampleRate: slice.sampleRate,
      channels: slice.channels,
      buffer: slice.samples.buffer
    });
  } catch (err) { return fail(err); }
});

let lastWriteErrorToast = 0;
ipcMain.on('audio:chunk', (_e, arrayBuffer) => {
  lastChunkAt = Date.now();
  try {
    session.pushAudio(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Audioblock konnte nicht geschrieben werden:', err);
    // Nicht alle 100 ms eine Meldung: höchstens alle 10 Sekunden.
    if (Date.now() - lastWriteErrorToast > 10000) {
      lastWriteErrorToast = Date.now();
      toast('error', `Audio konnte nicht auf die Festplatte geschrieben werden: ${err.code || err.message}`);
    }
  }
});

/* --- Rückgängig, Schnitte, Eingangsstatus --- */

ipcMain.handle('edit:undo', () => session.undo());
ipcMain.handle('edit:redo', () => session.redo());
ipcMain.handle('cut:add', (_e, { start, end }) => session.addCut(start, end));
ipcMain.handle('cut:toggle', (_e, { time } = {}) => session.toggleCut(time));
ipcMain.handle('cut:move', (_e, { id, edge, time }) => session.moveCutEdge(id, edge, time));
ipcMain.handle('cut:remove', (_e, { id }) => session.removeCut(id));

// Die Oberfläche meldet, wenn der Audioeingang ausfällt bzw. wieder da ist.
ipcMain.on('health:input', (_e, { lost }) => {
  health.inputLost = Boolean(lost);
  publishHealth();
});

/* --- Abschnitte (je zwei Marker: Anfang und Ende) --- */

ipcMain.handle('section:toggle', (_e, params) => session.toggleSection(params || {}));
ipcMain.handle('section:start', (_e, { id, time } = {}) => session.startPending(id, time));
ipcMain.handle('section:add', (_e, params) => session.addPending(params || {}));
ipcMain.handle('section:reorder', (_e, { id, beforeId } = {}) => session.reorderPending(id, beforeId));
ipcMain.handle('section:place', (_e, { id, time } = {}) => session.placePending(id, time));
ipcMain.handle('section:next', (_e, { time } = {}) => session.startNextPending(time));
const found = (section) => (section ? ok({ section }) : fail('Abschnitt nicht gefunden.'));
ipcMain.handle('section:edge', (_e, { id, edge, time } = {}) => found(session.moveEdge(id, edge, time)));
ipcMain.handle('section:update', (_e, { id, ...patch } = {}) => found(session.updateSection(id, patch)));
ipcMain.handle('section:delete', (_e, { id } = {}) => (session.removeSection(id) ? ok({ removed: true }) : fail('Abschnitt nicht gefunden.')));

/* --- Export --- */

/** Unterordner je Gottesdienst im Export-Oberordner: "Datum_Gottesdienstname". */
function exportSubfolderName() {
  return `${session.service.date || dateStamp()}_${slug(session.service.name, 'Gottesdienst')}`;
}

/** Hängt " (2)", " (3)" … an, damit ein früherer Export nie überschrieben wird. */
function freeFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const { dir, name, ext } = path.parse(filePath);
  for (let n = 2; ; n++) {
    const candidate = path.join(dir, `${name} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** Zielordner für Exporte bei gesetztem Oberordner, sonst null (dann wird gefragt). */
function exportTargetFolder() {
  const base = settings.get('exportDir');
  return base ? path.join(base, exportSubfolderName()) : null;
}

ipcMain.handle('export:target', () => ok({ folder: exportTargetFolder() }));

/** Ausgewählte Abschnitte nacheinander als MP3 speichern und als gesichert vermerken. */
ipcMain.handle('export:batch', async (_e, { items } = {}) => {
  try {
    if (!session.wavPath || !fs.existsSync(session.wavPath)) {
      return fail('Es ist keine Masteraufnahme vorhanden.');
    }
    if (!Array.isArray(items) || items.length === 0) return fail('Es ist kein Abschnitt ausgewählt.');
    await session.whenWritten();         // die gerade beendete Aufnahme muss vollständig auf der Platte sein

    let folder = exportTargetFolder();
    if (!folder) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Zielordner für die MP3-Dateien wählen',
        defaultPath: settings.get('recordingsDir'),
        properties: ['openDirectory', 'createDirectory']
      });
      if (res.canceled || !res.filePaths[0]) return ok({ canceled: true });
      folder = res.filePaths[0];
    }
    fs.mkdirSync(folder, { recursive: true });

    const files = [];
    const failed = [];
    for (let i = 0; i < items.length; i++) {
      const { id, start, end, label } = items[i];
      const cuts = session.cutsWithin(start, end);
      const section = session.sections.find((x) => `seg_${x.id}` === id);
      const tags = {
        title: label,
        artist: section?.artist || settings.get('defaultArtist') || '',
        album: session.service.date || '',
        year: String(session.service.date || '').slice(0, 4)
      };
      try {
        const result = await mp3.exportSegment({
          wavPath: session.wavPath,
          start,
          end,
          outPath: freeFilePath(path.join(folder, buildFileName(label, tags.artist))),
          bitrate: settings.get('mp3Bitrate') || 192,
          tags,
          skip: cuts,
          onProgress: (p) => send('export-progress', { progress: (i + p) / items.length, index: i + 1, total: items.length })
        });
        files.push(result.outPath);
        revealable.add(path.resolve(result.outPath));
        if (id) session.recordExport(id, { file: result.outPath, start, end, cuts });
        net.publishEvent('export.finished', { file: result.outPath, label });
      } catch (err) {
        failed.push({ id, label, error: String(err?.message || err) });
      }
    }
    send('export-progress', { progress: 1, index: items.length, total: items.length });
    return ok({ folder, files, failed });
  } catch (err) {
    return fail(err);
  }
});

/* "Im Ordner zeigen" nur für Dateien in Aufnahme- oder Exportordner bzw. eben exportierte Dateien. */
const revealable = new Set();
function isInside(file, dir) {
  if (!dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
ipcMain.handle('file:reveal', (_e, { filePath } = {}) => {
  if (!filePath || !fs.existsSync(filePath)) return fail('Datei nicht gefunden.');
  const allowed = revealable.has(path.resolve(filePath))
    || isInside(filePath, settings.get('recordingsDir'))
    || isInside(filePath, settings.get('exportDir'));
  if (!allowed) return fail('Dieser Ort wird nicht angezeigt.');
  shell.showItemInFolder(filePath);
  return ok();
});

ipcMain.handle('folder:open', () => {
  shell.openPath(settings.get('recordingsDir'));
  return ok();
});

/* --- Aufnahmenliste / Wiederherstellung --- */

function listSessions() {
  const dir = settings.get('recordingsDir');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.session.json'));
  } catch { return []; }
  return files.map((f) => {
    const full = path.join(dir, f);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      return {
        path: full,
        name: data.service?.name || f,
        date: data.service?.date || '',
        startedAt: data.startedAt || null,
        duration: data.duration || 0,
        finalized: data.finalized !== false,
        sectionCount: Array.isArray(data.sections)
          ? data.sections.filter((x) => x.start != null).length
          : (data.markers || []).filter((m) => m.placed).length,
        // Wie beim Öffnen: verschobene Aufnahmen über den Namen neben der Session-Datei finden.
        wavExists: (data.wavPath && fs.existsSync(data.wavPath)) || fs.existsSync(full.replace(/\.session\.json$/, '.wav'))
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

ipcMain.handle('session:list', () => ok({ sessions: listSessions() }));

ipcMain.handle('session:open', (_e, { path: p }) => {
  try {
    if (session.status === 'recording' || session.status === 'paused') {
      return fail('Während einer laufenden Aufnahme kann keine andere Session geöffnet werden.');
    }
    return ok({ state: session.loadFromFile(p) });
  } catch (err) { return fail(err); }
});

ipcMain.handle('session:recoverable', () => {
  const unfinished = listSessions().filter((s) => !s.finalized && s.wavExists);
  return ok({ sessions: unfinished });
});

ipcMain.handle('session:new', () => {
  if (session.status === 'recording' || session.status === 'paused') {
    return fail('Es läuft noch eine Aufnahme.');
  }
  session.reset();
  session.emit('state', session.snapshot());
  return ok({ state: session.snapshot() });
});

ipcMain.handle('session:state', () => ok({ state: session.snapshot(), peaks: session.peaks }));

/* --- Netzwerk & Updates --- */

ipcMain.handle('net:status', () => ok(net.statusInfo()));
ipcMain.handle('net:restart', () => {
  const result = settings.get('networkEnabled') ? net.restart() : (net.stop(), { ok: true });
  return result.ok ? ok(net.statusInfo()) : fail(result.error);
});

ipcMain.handle('update:check', () => updater.check({ manual: true }));
ipcMain.handle('update:install', () => {
  const result = updater.install();
  return result.ok ? ok() : fail(result.error);
});
ipcMain.handle('update:status', () => ok(updater.status()));

/* --------------------------------------------------------------- App-Start */

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    settings.load();
    setupApplicationMenu();
    createWindow();
    updater.init();
    refreshDisk();
    setInterval(refreshDisk, 30000);   // Speicherplatz regelmäßig prüfen und an Netzwerk-Clients melden

    // macOS verlangt zusätzlich zur Chromium-Freigabe eine Systemfreigabe.
    if (process.platform === 'darwin') {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) {
          toast('warn', 'macOS verweigert den Zugriff auf den Audioeingang. Freigabe unter „Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon“.');
        }
      } catch (err) {
        console.warn('Mikrofonfreigabe konnte nicht abgefragt werden:', err);
      }
    }

    if (settings.get('networkEnabled') && settings.get('networkPassword')) {
      const result = net.start();
      if (!result.ok) console.warn('Netzwerkschnittstelle:', result.error);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      createWindow();
      // Beim Schließen des Fensters wurde die Netzwerkschnittstelle gestoppt (macOS: App läuft weiter).
      if (settings.get('networkEnabled') && settings.get('networkPassword') && !net.statusInfo().running) {
        const result = net.start();
        if (!result.ok) console.warn('Netzwerkschnittstelle:', result.error);
      }
    });
  });

  app.on('window-all-closed', () => {
    net.stop();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (e) => {
    // Greift vor allem unter macOS, wo Cmd+Q das Fenster umgeht.
    if (guardClose(e, () => app.quit())) return;
    session.flushSave();
    net.stop();
  });
}
