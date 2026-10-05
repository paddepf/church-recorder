'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  app: {
    info: () => invoke('app:info'),
    openRecordingsFolder: () => invoke('folder:open'),
    reveal: (filePath) => invoke('file:reveal', { filePath })
  },

  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    chooseFolder: () => invoke('settings:chooseFolder'),
    chooseFile: (opts) => invoke('settings:chooseFile', opts)
  },

  churchtools: {
    test: () => invoke('ct:test'),
    services: (range) => invoke('ct:services', range),
    agenda: (params) => invoke('ct:agenda', params)
  },

  session: {
    state: () => invoke('session:state'),
    setService: (service) => invoke('session:service', service),
    list: () => invoke('session:list'),
    open: (path) => invoke('session:open', { path }),
    recoverable: () => invoke('session:recoverable'),
    reset: () => invoke('session:new')
  },

  record: {
    start: (params) => invoke('rec:start', params),
    continue: () => invoke('rec:continue'),
    pause: () => invoke('rec:pause'),
    resume: () => invoke('rec:resume'),
    stop: () => invoke('rec:stop'),
    /** Audioblock (Int16 interleaved) an den Hauptprozess übergeben. */
    /** Ausschnitt der (laufenden) Aufnahme zum Mithören lesen. */
    readAudio: (start, seconds) => invoke('audio:read', { start, seconds }),
    chunk: (arrayBuffer) => ipcRenderer.send('audio:chunk', arrayBuffer)
  },

  section: {
    /** Abschnitt beginnen bzw. den laufenden beenden. */
    toggle: (params) => invoke('section:toggle', params),
    /** Offenen Ablaufpunkt beginnen (time = null: jetzt). */
    start: (id, time) => invoke('section:start', { id, time }),
    /** Laufenden Abschnitt beenden und nächsten Ablaufpunkt beginnen. */
    next: (time) => invoke('section:next', { time }),
    moveEdge: (id, edge, time) => invoke('section:edge', { id, edge, time }),
    update: (id, patch) => invoke('section:update', { id, ...patch }),
    remove: (id) => invoke('section:delete', { id })
  },

  exportSegment: (params) => invoke('export:segment', params),

  net: {
    status: () => invoke('net:status'),
    restart: () => invoke('net:restart')
  },

  update: {
    check: () => invoke('update:check'),
    install: () => invoke('update:install'),
    status: () => invoke('update:status')
  },

  on: (channel, handler) => {
    const allowed = ['state', 'levels', 'transcript', 'toast', 'command', 'menu',
      'network-status', 'transcription-status', 'update-status', 'export-progress'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
