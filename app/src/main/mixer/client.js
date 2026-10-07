'use strict';

/**
 * Verbindung zum M32 per OSC (UDP 10023): liest Kanalnamen, -farben und das Routing der
 * Kartenausgänge und bleibt mit `/xremote` angemeldet, damit Änderungen am Pult sofort ankommen.
 * Nur lesend – Ebbton stellt am Pult nichts um.
 *
 * Zustand (`snapshot()`): status 'connecting' | 'connected' | 'lost', info ({ip, name, model, version}),
 * channels ([{name, color}] × 32, Farbe als Zahl), routing ([4 Zahlen] oder null).
 * Ereignisse: 'change' (Zustand, gebündelt), 'error'.
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');
const osc = require('./osc');
const M32 = require('./m32');

const KEEPALIVE_MS = 8000;          // /xremote gilt 10 s
const ALIVE_MS = 12000;             // so lange ohne Antwort gilt das Pult als weg
const RETRY_MS = 5000;              // solange es weg ist, so oft nachfragen

class MixerClient extends EventEmitter {
  /** @param {{host:string, port?:number, timing?:{keepalive?:number, alive?:number, retry?:number}}} o timing: nur für Tests */
  constructor({ host, port = M32.PORT, timing = {} }) {
    super();
    this.host = host;
    this.port = port;
    this.timing = { keepalive: KEEPALIVE_MS, alive: ALIVE_MS, retry: RETRY_MS, ...timing };
    this.status = 'connecting';
    this.info = null;
    this.channels = Array.from({ length: M32.CHANNELS }, () => ({ name: '', color: null }));
    this.routing = new Array(M32.CARD_BLOCKS.length).fill(null);
    this.lastSeen = 0;
    this._waiters = new Map();     // Adresse → [resolve]
    this._needRead = true;         // Namen/Routing noch nicht (oder seit dem Verbindungsverlust nicht) gelesen
    this._epoch = 0;               // zählt Verbindungsverluste: ein Lesevorgang über einen Verlust hinweg zählt nicht
  }

  start() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg) => this._onMessage(msg));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.bind(0, () => {
      this._hello();
      this._timer = setInterval(() => this._tick(), Math.min(1000, this.timing.retry));
    });
  }

  stop() {
    clearInterval(this._timer);
    clearTimeout(this._changeTimer);
    try { this.socket.close(); } catch { /* schon zu */ }
    for (const list of this._waiters.values()) list.forEach((r) => r(null));
    this._waiters.clear();
  }

  send(address, args) {
    try {
      this.socket.send(osc.encode(address, args), this.port, this.host);
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Fragt einen Wert ab; erfüllt sich mit den Argumenten der Antwort oder null nach `timeout`. */
  query(address, timeout = 1500) {
    return new Promise((resolve) => {
      const list = this._waiters.get(address) || [];
      const timer = setTimeout(() => {
        const l = this._waiters.get(address);
        if (l) l.splice(l.indexOf(done), 1);
        resolve(null);
      }, timeout);
      const done = (args) => { clearTimeout(timer); resolve(args); };
      list.push(done);
      this._waiters.set(address, list);
      this.send(address);
    });
  }

  /** Anmelden, alles einmal lesen. */
  _hello() {
    this.send('/xinfo');
    this.send('/xremote');
    this._lastKeepalive = Date.now();
    this.refresh();
  }

  /** Liest Namen, Farben und Routing (Antworten kommen über `_onMessage`). */
  async refresh() {
    if (this._reading) return this._reading;
    const epoch = this._epoch;
    this._reading = (async () => {
      const channelAsks = [];
      for (let ch = 1; ch <= M32.CHANNELS; ch++) channelAsks.push(this.query(M32.namePath(ch)), this.query(M32.colorPath(ch)));
      // Routing-Antworten zählen nicht mit: Die Adressen sind am echten Pult ungeprüft und sollen kein
      // Dauer-Nachlesen auslösen, falls es sie dort nicht gibt.
      const routingAsks = M32.CARD_BLOCKS.map((b) => this.query(M32.routingPath(b)));
      const answers = await Promise.all(channelAsks);
      await Promise.all(routingAsks);
      if (epoch === this._epoch && answers.every(Boolean)) this._needRead = false;
      return this.snapshot();
    })();
    try { return await this._reading; } finally { this._reading = null; }
  }

  _tick() {
    const now = Date.now();
    const alive = now - this.lastSeen < this.timing.alive;
    if (this.status === 'connected' && !alive) {
      this._needRead = true;           // nach dem Wiederkommen alles neu lesen (Szene könnte gewechselt sein)
      this._epoch++;
      this._setStatus('lost');
    }
    if (this.status !== 'connected') {
      // Pult (noch) nicht da: regelmäßig nachfragen; antwortet es, wird alles neu gelesen.
      if (now - (this._lastRetry || 0) >= this.timing.retry) {
        this._lastRetry = now;
        this.send('/xinfo');
      }
    } else if (this._needRead && !this._reading) {
      // Verbunden, aber noch nichts gelesen (das Pult kam, während die ersten Abfragen noch liefen).
      this._hello();
    } else if (now - this._lastKeepalive >= this.timing.keepalive) {
      this._lastKeepalive = now;
      this.send('/xremote');
      this.send('/xinfo');     // nebenbei: Lebenszeichen, falls am Pult gerade nichts geändert wird
    }
  }

  _setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this._changed();
  }

  _onMessage(buf) {
    let msg;
    try { msg = osc.decode(buf); } catch { return; }
    this.lastSeen = Date.now();
    if (this.status !== 'connected') {
      this._setStatus('connected');
      // Pult war beim Start aus oder zwischendurch weg: anmelden und alles lesen.
      if (this._needRead && !this._reading) this._hello();
    }
    const { address, args } = msg;
    let m;
    if (address === '/xinfo' && args.length >= 4) {
      this.info = { ip: String(args[0]), name: String(args[1]), model: String(args[2]), version: String(args[3]) };
      this._changed();
    } else if ((m = /^\/ch\/(\d\d)\/config\/(name|color)$/.exec(address)) && args.length) {
      const ch = this.channels[Number(m[1]) - 1];
      if (ch) {
        if (m[2] === 'name') ch.name = String(args[0]).trim();
        else ch.color = Number(args[0]);
        this._changed();
      }
    } else if ((m = /^\/config\/routing\/CARD\/(\d+-\d+)$/.exec(address)) && args.length) {
      const i = M32.CARD_BLOCKS.indexOf(m[1]);
      if (i >= 0) {
        this.routing[i] = Number(args[0]);
        this._changed();
      }
    }
    const list = this._waiters.get(address);
    if (list && list.length) {
      this._waiters.delete(address);
      list.forEach((r) => r(args));
    }
  }

  /** Änderungen bündeln (beim Lesen kommen 68 Antworten fast gleichzeitig). */
  _changed() {
    clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => this.emit('change', this.snapshot()), 100);
  }

  snapshot() {
    return {
      host: this.host,
      status: this.status,
      info: this.info,
      channels: this.channels.map((c) => ({ ...c })),
      routing: this.routing.every((r) => Number.isInteger(r)) ? [...this.routing] : null
    };
  }
}

/**
 * Sucht Pulte im lokalen Netz: `/xinfo` an alle (Broadcast), Antworten sammeln.
 * @returns {Promise<{ip, name, model, version}[]>}
 */
function discover({ timeout = 1500, port = M32.PORT, address = '255.255.255.255' } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket('udp4');
    const finish = () => {
      try { socket.close(); } catch { /* schon zu */ }
      resolve([...found.values()]);
    };
    socket.on('error', finish);
    socket.on('message', (buf, rinfo) => {
      try {
        const { address: a, args } = osc.decode(buf);
        if (a === '/xinfo' && args.length >= 4) {
          found.set(rinfo.address, { ip: rinfo.address, name: String(args[1]), model: String(args[2]), version: String(args[3]) });
        }
      } catch { /* keine OSC-Nachricht */ }
    });
    socket.bind(0, () => {
      try { socket.setBroadcast(true); } catch { /* egal */ }
      socket.send(osc.encode('/xinfo'), port, address);
      setTimeout(finish, timeout);
    });
  });
}

module.exports = { MixerClient, discover };
