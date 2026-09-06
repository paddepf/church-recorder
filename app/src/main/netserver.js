'use strict';

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const settings = require('./settings');

const PROTOCOL_VERSION = 1;
const LEVEL_INTERVAL_MS = 200;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Stellt den Aufnahmestatus im Netzwerk bereit und nimmt Steuerbefehle
 * entgegen. Es gibt zwei Rollen:
 *   - "control": Vollzugriff (Bitfocus Companion) – Passwort aus networkPassword
 *   - "monitor": nur lesen (Dashboard)          – Passwort aus monitorPassword
 * Ist kein Monitor-Passwort gesetzt, ist die Monitor-Rolle deaktiviert.
 */
class NetServer extends EventEmitter {
  constructor() {
    super();
    this.wss = null;
    this.http = null;
    this.port = null;
    this.clients = new Map();       // ws -> {role, authed, ip}
    this.lastState = null;
    this.lastLevelSent = 0;
  }

  get running() {
    return Boolean(this.wss);
  }

  get clientCount() {
    return [...this.clients.values()].filter((c) => c.authed).length;
  }

  start() {
    const cfg = settings.load();
    if (!cfg.networkEnabled) return { ok: false, error: 'Die Netzwerkschnittstelle ist deaktiviert.' };
    if (!cfg.networkPassword) {
      return { ok: false, error: 'Es ist kein Netzwerk-Passwort gesetzt. Bitte in den Einstellungen vergeben.' };
    }
    this.stop();

    this.http = http.createServer((req, res) => {
      // Kleiner Health-Endpunkt, damit ein Dashboard die App auch ohne
      // WebSocket erreichen/erkennen kann.
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          app: 'church-recorder',
          protocol: PROTOCOL_VERSION,
          status: this.lastState?.status || 'idle'
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ChurchRecorder: bitte über WebSocket verbinden.');
    });

    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));

    try {
      this.http.listen(cfg.networkPort);
      this.port = cfg.networkPort;
    } catch (err) {
      this.stop();
      return { ok: false, error: 'Port konnte nicht geöffnet werden: ' + err.message };
    }

    this.http.on('error', (err) => {
      this.emit('error-notice', `Netzwerkschnittstelle: ${err.code === 'EADDRINUSE'
        ? `Port ${cfg.networkPort} ist belegt.`
        : err.message}`);
      this.stop();
      this.emit('status', this.statusInfo());
    });

    this._ping = setInterval(() => {
      this.wss?.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch { /* Verbindung wird ohnehin verworfen */ }
      });
    }, 20000);

    this.emit('status', this.statusInfo());
    return { ok: true, port: this.port };
  }

  stop() {
    if (this._ping) clearInterval(this._ping);
    this._ping = null;
    if (this.wss) {
      this.wss.clients.forEach((ws) => { try { ws.close(); } catch { /* egal */ } });
      this.wss.close();
      this.wss = null;
    }
    if (this.http) {
      try { this.http.close(); } catch { /* egal */ }
      this.http = null;
    }
    this.clients.clear();
    this.port = null;
  }

  restart() {
    this.stop();
    const result = this.start();
    this.emit('status', this.statusInfo());
    return result;
  }

  statusInfo() {
    return {
      running: this.running,
      port: this.port,
      clients: this.clientCount,
      passwordSet: Boolean(settings.get('networkPassword')),
      monitorRoleEnabled: Boolean(settings.get('monitorPassword'))
    };
  }

  _onConnection(ws, req) {
    const ip = req.socket.remoteAddress;
    this.clients.set(ws, { authed: false, role: null, ip });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const authTimer = setTimeout(() => {
      const info = this.clients.get(ws);
      if (info && !info.authed) {
        this._send(ws, { type: 'error', code: 'auth_timeout', message: 'Keine Anmeldung erhalten.' });
        ws.close();
      }
    }, 10000);

    this._send(ws, { type: 'hello', app: 'church-recorder', protocol: PROTOCOL_VERSION });

    // Anmeldung auch per Query-Parameter erlauben: ws://host:port/?password=...&role=monitor
    try {
      const url = new URL(req.url, 'http://localhost');
      const qp = url.searchParams.get('password');
      if (qp) this._authenticate(ws, qp, url.searchParams.get('role'));
    } catch { /* normale Anmeldung per Nachricht */ }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this._send(ws, { type: 'error', code: 'bad_json', message: 'Nachricht ist kein gültiges JSON.' });
      }
      this._handle(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(ws);
      this.emit('status', this.statusInfo());
    });
    ws.on('error', () => { /* Verbindungsfehler führen zum close-Event */ });
  }

  _authenticate(ws, password, requestedRole) {
    const info = this.clients.get(ws);
    if (!info || info.authed) return;
    const cfg = settings.load();

    let role = null;
    if (cfg.networkPassword && safeEqual(password, cfg.networkPassword)) role = 'control';
    else if (cfg.monitorPassword && safeEqual(password, cfg.monitorPassword)) role = 'monitor';

    if (!role) {
      this._send(ws, { type: 'error', code: 'auth_failed', message: 'Passwort ist falsch.' });
      setTimeout(() => ws.close(), 200);
      return;
    }
    // Wer das Vollzugriffs-Passwort nutzt, kann sich freiwillig beschränken.
    if (requestedRole === 'monitor') role = 'monitor';

    info.authed = true;
    info.role = role;
    this._send(ws, { type: 'auth', ok: true, role });
    if (this.lastState) this._send(ws, { type: 'state', payload: this.lastState });
    this.emit('status', this.statusInfo());
  }

  _handle(ws, msg) {
    const info = this.clients.get(ws);
    if (!info) return;

    if (msg.type === 'auth') return this._authenticate(ws, msg.password, msg.role);
    if (!info.authed) {
      return this._send(ws, { type: 'error', code: 'unauthorized', message: 'Bitte zuerst anmelden.' });
    }
    if (msg.type === 'ping') return this._send(ws, { type: 'pong', id: msg.id ?? null });
    if (msg.type === 'get_state') {
      return this._send(ws, { type: 'state', payload: this.lastState, id: msg.id ?? null });
    }
    if (msg.type !== 'command') {
      return this._send(ws, { type: 'error', code: 'unknown_type', message: 'Unbekannter Nachrichtentyp.' });
    }
    if (info.role !== 'control') {
      return this._send(ws, { type: 'error', code: 'read_only', message: 'Diese Verbindung darf nur mitlesen.' });
    }

    const allowed = ['record.start', 'record.stop', 'record.pause', 'record.resume', 'record.toggle',
      'marker.add', 'marker.next'];
    if (!allowed.includes(msg.action)) {
      return this._send(ws, { type: 'error', code: 'unknown_action', message: `Unbekannter Befehl: ${msg.action}` });
    }

    this.emit('command', {
      action: msg.action,
      params: msg.params || {},
      reply: (result) => this._send(ws, { type: 'result', id: msg.id ?? null, action: msg.action, ...result })
    });
  }

  _send(ws, obj) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* Verbindung bricht ab */ }
  }

  broadcast(obj, { includeMonitors = true } = {}) {
    this.clients.forEach((info, ws) => {
      if (!info.authed) return;
      if (!includeMonitors && info.role === 'monitor') return;
      this._send(ws, obj);
    });
  }

  /** Vollständiger Zustand – wird bei jeder Änderung gesendet. */
  publishState(state) {
    this.lastState = state;
    this.broadcast({ type: 'state', payload: state });
  }

  /** Pegel – gedrosselt, damit das Netz nicht geflutet wird. */
  publishLevels(levels) {
    const now = Date.now();
    if (now - this.lastLevelSent < LEVEL_INTERVAL_MS) return;
    this.lastLevelSent = now;
    this.broadcast({ type: 'levels', payload: levels });
  }

  publishEvent(name, payload) {
    this.broadcast({ type: 'event', event: name, payload });
  }
}

module.exports = { NetServer, PROTOCOL_VERSION };
