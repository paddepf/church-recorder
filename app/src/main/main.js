'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, systemPreferences } = require('electron');

const settings = require('./settings');
const { Session, slug, dateStamp } = require('./session');
const { NetServer } = require('./netserver');
const { Transcriber } = require('./transcribe');
const { Updater } = require('./updater');
const churchtools = require('./churchtools');
const mp3 = require('./mp3');

let win = null;
const session = new Session();
const net = new NetServer();
const transcriber = new Transcriber();
const updater = new Updater(() => session.status === 'recording' || session.status === 'paused');

const isDev = process.argv.includes('--dev');

/* -------------------------------------------------------------- Hilfsfunktionen */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(level, message) {
  send('toast', { level, message });
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
      net.publishState(s);
    }, 100);
  };
}
const pushState = stateThrottle();

function buildFileName(segmentLabel) {
  const pattern = settings.get('fileNamePattern') || '{datum}_{gottesdienst}_{abschnitt}';
  const name = pattern
    .replace(/\{datum\}/g, session.service.date || dateStamp())
    .replace(/\{gottesdienst\}/g, slug(session.service.name, 'Gottesdienst'))
    .replace(/\{abschnitt\}/g, slug(segmentLabel, 'Abschnitt'))
    .replace(/\{zeit\}/g, new Date().toTimeString().slice(0, 5).replace(':', ''));
  return slug(name).replace(/-+/g, '-') + '.mp3';
}

/**
 * Fragt nach, wenn beim Schließen oder Beenden noch aufgenommen wird.
 * @returns {boolean} true, wenn fortgefahren werden darf
 */
function confirmLeavingWhileRecording() {
  if (session.status !== 'recording' && session.status !== 'paused') return true;

  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Weiter aufnehmen', 'Aufnahme beenden und schließen'],
    defaultId: 0,
    cancelId: 0,
    title: 'Aufnahme läuft',
    message: 'Es läuft noch eine Aufnahme.',
    detail: 'Beim Schließen wird die Aufnahme gestoppt und gespeichert.'
  });
  if (choice === 0) return false;

  session.stop();
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
          label: 'Marker setzen',
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
        { role: 'undo', label: 'Widerrufen' },
        { role: 'redo', label: 'Wiederholen' },
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
        { role: 'minimize', label: 'Minimieren' },
        { role: 'zoom', label: 'Zoomen' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
        { role: 'reload', label: 'Neu laden' }
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
      if (inRenderer) {
        if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
      } else if (session.status === 'recording' || session.status === 'paused') {
        toast('warn', 'Main-Prozess geändert – Neustart nach der Aufnahme nötig.');
      } else {
        app.relaunch({ args: process.argv.slice(1) });
        app.exit(0);
      }
    }, 200);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#101419',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    title: 'ChurchRecorder',
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
    win.webContents.openDevTools({ mode: 'detach' });
    setupLiveReload();
  }

  // Mikrofon-/Eingangszugriff im Renderer erlauben.
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture');
  });

  win.on('close', (e) => {
    if (!confirmLeavingWhileRecording()) {
      e.preventDefault();
      return;
    }
    net.stop();
  });

  win.on('closed', () => { win = null; });
}

/* ------------------------------------------------------------- Verdrahtungen */

session.on('state', (s) => pushState(s));

session.on('levels', (levels) => {
  send('levels', levels);
  net.publishLevels(levels);
});

session.on('audio', ({ buffer, startTime }) => {
  transcriber.push(buffer, startTime);
});

session.on('recording-started', ({ sampleRate, channels }) => {
  const result = transcriber.start(sampleRate, channels);
  if (!result.ok && result.reason !== 'disabled') {
    toast('warn', `Transkription nicht gestartet: ${result.message}`);
  }
  net.publishEvent('recording.started', { wavPath: session.wavPath });
});

session.on('recording-stopped', (info) => {
  transcriber.stop();
  net.publishEvent('recording.stopped', info);
});

session.on('transcript', (segment) => send('transcript', segment));
session.on('error-notice', (message) => toast('error', message));

transcriber.on('segment', (seg) => session.addTranscript(seg));
transcriber.on('status', (s) => send('transcription-status', s));
transcriber.on('failure', (message) => toast('warn', 'Transkription gestoppt: ' + message));

net.on('status', (info) => send('network-status', info));
net.on('error-notice', (message) => toast('error', message));

net.on('command', ({ action, params, reply }) => {
  const done = (result) => {
    reply(result);
    net.publishState(session.snapshot());
  };
  switch (action) {
    case 'record.start':
      // Die Audioaufnahme selbst läuft im Renderer – dieser meldet zurück.
      send('command', { action: 'record.start' });
      return done({ ok: true, accepted: true });
    case 'record.stop':
      send('command', { action: 'record.stop' });
      return done({ ok: true, accepted: true });
    case 'record.pause':
      return done(session.pause());
    case 'record.resume':
      return done(session.resume());
    case 'record.toggle':
      if (session.status === 'recording') {
        send('command', { action: 'record.stop' });
        return done({ ok: true, accepted: true });
      }
      send('command', { action: 'record.start' });
      return done({ ok: true, accepted: true });
    case 'marker.add': {
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      const m = session.addMarker({ label: params.label, category: params.category, source: 'manual' });
      return done({ ok: true, marker: m });
    }
    case 'marker.next': {
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      const m = session.placeNextPending();
      return done(m ? { ok: true, marker: m } : { ok: false, error: 'Keine offenen Ablaufplan-Punkte mehr.' });
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
  transcription: Transcriber.check()
}));

ipcMain.handle('settings:get', () => ok({ settings: settings.forRenderer() }));

ipcMain.handle('settings:set', (_e, patch) => {
  try {
    const clean = { ...patch };
    if (Object.prototype.hasOwnProperty.call(clean, 'churchToolsToken')) {
      clean.churchToolsToken = clean.churchToolsToken
        ? settings.encryptSecret(clean.churchToolsToken)
        : '';
    }
    const networkKeys = ['networkEnabled', 'networkPort', 'networkPassword', 'monitorPassword'];
    const networkChanged = networkKeys.some((k) => k in clean);
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

ipcMain.handle('settings:chooseFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Ordner für Aufnahmen wählen',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return ok({ canceled: true });
  settings.save({ recordingsDir: res.filePaths[0] });
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

ipcMain.handle('ct:services', async (_e, { from, to } = {}) => {
  try {
    const today = churchtools.isoDate(new Date());
    return ok({ services: await churchtools.listServices(from || today, to || from || today) });
  } catch (err) { return fail(err); }
});

ipcMain.handle('ct:agenda', async (_e, { eventId, name, date }) => {
  try {
    const plan = await churchtools.agenda(eventId);
    session.setService({ id: eventId, name: name || plan.name || 'Gottesdienst', date });
    session.setAgenda(plan.items);
    return ok({ items: plan.items, count: plan.items.length });
  } catch (err) { return fail(err); }
});

/* --- Session / Aufnahme --- */

ipcMain.handle('session:service', (_e, service) => {
  session.setService(service);
  return ok({ state: session.snapshot() });
});

ipcMain.handle('rec:start', (_e, { sampleRate, channels } = {}) => {
  try { return session.start({ sampleRate, channels }); } catch (err) { return fail(err); }
});
ipcMain.handle('rec:pause', () => session.pause());
ipcMain.handle('rec:resume', () => session.resume());
ipcMain.handle('rec:stop', () => {
  try { return session.stop(); } catch (err) { return fail(err); }
});

ipcMain.on('audio:chunk', (_e, arrayBuffer) => {
  try {
    session.pushAudio(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Audioblock konnte nicht geschrieben werden:', err);
    toast('error', 'Audio konnte nicht auf die Festplatte geschrieben werden.');
  }
});

/* --- Marker --- */

ipcMain.handle('marker:add', (_e, params) => ok({ marker: session.addMarker(params || {}) }));
ipcMain.handle('marker:place', (_e, { id, time }) => ok({ marker: session.placeMarker(id, time) }));
ipcMain.handle('marker:next', (_e, { time } = {}) => {
  const m = session.placeNextPending(time);
  return m ? ok({ marker: m }) : fail('Keine offenen Ablaufplan-Punkte mehr.');
});
ipcMain.handle('marker:move', (_e, { id, time }) => ok({ marker: session.moveMarker(id, time) }));
ipcMain.handle('marker:update', (_e, { id, ...patch }) => ok({ marker: session.updateMarker(id, patch) }));
ipcMain.handle('marker:delete', (_e, { id }) => ok({ removed: session.removeMarker(id) }));

/* --- Export --- */

ipcMain.handle('export:segment', async (_e, { start, end, label }) => {
  try {
    if (!session.wavPath || !fs.existsSync(session.wavPath)) {
      return fail('Es ist keine Masteraufnahme vorhanden.');
    }
    const suggested = path.join(settings.get('recordingsDir'), buildFileName(label));
    const res = await dialog.showSaveDialog(win, {
      title: 'Abschnitt als MP3 speichern',
      defaultPath: suggested,
      filters: [{ name: 'MP3-Audio', extensions: ['mp3'] }]
    });
    if (res.canceled || !res.filePath) return ok({ canceled: true });

    const result = await mp3.exportSegment({
      wavPath: session.wavPath,
      start,
      end,
      outPath: res.filePath,
      bitrate: settings.get('mp3Bitrate') || 192,
      onProgress: (p) => send('export-progress', { progress: p })
    });
    net.publishEvent('export.finished', { file: result.outPath, label });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('file:reveal', (_e, { filePath }) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
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
        markerCount: (data.markers || []).filter((m) => m.placed).length,
        wavExists: data.wavPath ? fs.existsSync(data.wavPath) : false
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

ipcMain.handle('session:state', () => ok({ state: session.snapshot(), transcript: session.transcript, peaks: session.peaks }));

/* --- Netzwerk & Updates --- */

ipcMain.handle('net:status', () => ok(net.statusInfo()));
ipcMain.handle('net:restart', () => {
  const result = settings.get('networkEnabled') ? net.restart() : (net.stop(), { ok: true });
  return result.ok ? ok(net.statusInfo()) : fail(result.error);
});

ipcMain.handle('update:check', () => ok(updater.check()));
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

    // macOS verlangt zusätzlich zur Chromium-Freigabe eine Systemfreigabe.
    if (process.platform === 'darwin') {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) {
          toast('warn', 'macOS verweigert den Zugriff auf den Audioeingang. Freigabe unter „Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon".');
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
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    net.stop();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (e) => {
    // Greift vor allem unter macOS, wo Cmd+Q das Fenster umgeht.
    if (!confirmLeavingWhileRecording()) {
      e.preventDefault();
      return;
    }
    net.stop();
  });
}
