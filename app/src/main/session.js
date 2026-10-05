'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { WavWriter, readInfo, readSlice } = require('./wav');
const settings = require('./settings');
const SectionLogic = require('../shared/sections');

const PEAK_BUCKET_MS = 50;   // Auflösung der Wellenform
const AUTOSAVE_MS = 3000;
const MIN_SECTION = SectionLogic.MIN_SECTION;

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

function slug(text, fallback) {
  const s = String(text || '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return s || fallback || 'Aufnahme';
}

function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Liest die Abschnitte einer gespeicherten Session. Ältere Sessions kennen nur
 * einzelne Marker; sie werden zu Abschnitten bis zum jeweils nächsten Marker.
 */
function migrateSections(data, duration) {
  let list;
  if (Array.isArray(data.sections)) {
    list = data.sections.map((x) => ({ ...x }));
  } else {
    const old = data.markers || [];
    const placed = old.filter((m) => m.placed && m.time != null).sort((a, b) => a.time - b.time);
    list = old.map((m) => {
      const idx = placed.indexOf(m);
      const next = idx >= 0 ? placed[idx + 1] : null;
      return {
        id: m.id, ctId: m.ctId ?? null, label: m.label, category: m.category || null,
        plannedDuration: m.plannedDuration || null, order: m.order || 0, source: m.source || 'manual',
        start: idx >= 0 ? m.time : null,
        end: idx >= 0 ? (next ? next.time : duration) : null
      };
    });
  }
  let color = 0;
  list.forEach((x) => {
    if (x.color == null) { x.color = color; }
    color = Math.max(color, x.color) + 1;
    // Unterbrochene Aufnahme: ein offener Abschnitt reicht bis zum Ende der Datei.
    if (x.start != null && x.end == null) x.end = Math.max(duration, x.start + MIN_SECTION);
  });
  return list;
}

/**
 * Eine Session ist eine Aufnahme: eine durchgehende WAV-Masterdatei plus
 * Abschnitte und Metadaten. Abschnitte sind reine Metadaten – die
 * Audiodatei wird davon nie verändert.
 */
class Session extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.status = 'idle';               // idle | recording | paused | stopped
    this.service = { id: null, name: '', date: dateStamp() };
    this.sections = [];                 // {id,label,category,color,start|null,end|null,source}
    this.exports = {};                  // Segment-ID -> {file,start,end,at}: bereits als MP3 gesichert
    this._colorSeq = 0;
    this.peaks = [];                    // 0..255 je 50 ms
    this.writer = null;
    this.basePath = null;               // ohne Endung
    this.wavPath = null;
    this.sampleRate = settings.get('sampleRate') || 48000;
    this.channels = 2;
    this.levels = { l: 0, r: 0, clip: false };
    this.startedAt = null;
    this.finalized = false;
    this._bucketAcc = 0;
    this._bucketFrames = 0;
    this._clipUntil = 0;
    this._dirty = false;
  }

  /* ------------------------------------------------------------------ Zustand */

  get duration() {
    return this.writer ? this.writer.durationSeconds : (this._restoredDuration || 0);
  }

  /** Abschnitte mit gesetztem Anfang, chronologisch sortiert. */
  placedSections() {
    return this.sections.filter((x) => x.start != null).sort((a, b) => a.start - b.start);
  }

  /** Offene Ablaufplan-Punkte, deren Anfang noch nicht gesetzt ist. */
  pendingSections() {
    return this.sections.filter((x) => x.start == null);
  }

  /** Der Abschnitt, der gerade läuft (Anfang gesetzt, Ende noch offen). */
  openSection() {
    return this.sections.find((x) => x.start != null && x.end == null) || null;
  }

  _segmentOf(x) {
    return {
      id: 'seg_' + x.id,
      label: x.label,
      category: x.category || null,
      start: x.start,
      end: x.end != null ? x.end : this.duration,
      markerId: x.id,
      open: x.end == null
    };
  }

  /**
   * Exportierbare Abschnitte: jeder Abschnitt aus Anfang und Ende, dazu immer
   * die gesamte Aufnahme.
   */
  segments() {
    const out = this.placedSections().map((x) => this._segmentOf(x));
    if (this.duration > 0) {
      out.push({ id: 'seg_full', label: 'Gesamte Aufnahme', category: null, start: 0, end: this.duration, markerId: null });
    }
    return out;
  }

  /** Der Abschnitt, in dem die Aufnahme gerade läuft. */
  currentSegment() {
    const open = this.openSection();
    return open ? this._segmentOf(open) : null;
  }

  snapshot() {
    return {
      status: this.status,
      service: this.service,
      duration: this.duration,
      startedAt: this.startedAt,
      sampleRate: this.sampleRate,
      channels: this.channels,
      levels: this.levels,
      sections: this.sections,
      exports: this.exports,
      pending: this.pendingSections(),
      segments: this.segments(),
      currentSegment: this.currentSegment(),
      wavPath: this.wavPath
    };
  }

  _changed() {
    this._dirty = true;
    this.emit('state', this.snapshot());
  }

  /* ------------------------------------------------------- Ablaufplan / Marker */

  setService(service) {
    this.service = {
      id: service?.id ?? null,
      name: service?.name || 'Gottesdienst',
      date: service?.date || dateStamp()
    };
    this._changed();
  }

  _nextColor() {
    const c = this._colorSeq;
    this._colorSeq += 1;
    return c;
  }

  /** Übernimmt Ablaufplan-Punkte als noch nicht gesetzte Abschnitte. */
  setAgenda(items) {
    const manual = this.sections.filter((x) => x.source === 'manual');
    const placedFromPlan = this.sections.filter((x) => x.source === 'churchtools' && x.start != null);
    const keepIds = new Set(placedFromPlan.map((x) => x.ctId));
    const fresh = (items || [])
      .filter((it) => !keepIds.has(it.id))
      .map((it, i) => ({
        id: newId('sec'),
        ctId: it.id ?? null,
        label: it.title || `Punkt ${i + 1}`,
        category: it.category || null,
        plannedDuration: it.duration || null,
        order: i,
        color: this._nextColor(),
        start: null,
        end: null,
        source: 'churchtools'
      }));
    this.sections = [...placedFromPlan, ...fresh, ...manual];
    this._changed();
  }

  _closeOpen(time) {
    const open = this.openSection();
    if (!open) return null;
    open.end = Math.max(open.start + MIN_SECTION, time);
    return open;
  }

  /** Beginnt einen neuen, selbst benannten Abschnitt. */
  startSection({ label, category, time, source = 'manual' } = {}) {
    if (this.openSection()) return { ok: false, error: 'Es läuft bereits ein Abschnitt – zuerst beenden.' };
    const t = time == null ? this.duration : Math.max(0, time);
    const section = {
      id: newId('sec'),
      ctId: null,
      label: label || `Abschnitt ${this.placedSections().length + 1}`,
      category: category || null,
      plannedDuration: null,
      order: this.sections.length,
      color: this._nextColor(),
      start: t,
      end: null,
      source
    };
    this.sections.push(section);
    this._changed();
    return { ok: true, section };
  }

  /** Beendet den laufenden Abschnitt. */
  endSection(time) {
    const open = this._closeOpen(time == null ? this.duration : time);
    if (!open) return { ok: false, error: 'Es läuft kein Abschnitt.' };
    this._changed();
    return { ok: true, section: open };
  }

  /** "Marker setzen": beendet den laufenden Abschnitt, sonst beginnt ein neuer. */
  toggleSection(params = {}) {
    return this.openSection() ? { ...this.endSection(params.time), change: 'ended' }
      : { ...this.startSection(params), change: 'started' };
  }

  /**
   * Beginnt einen Ablaufplan-Punkt. Ein gerade laufender Abschnitt endet dabei
   * an derselben Stelle. Außerhalb der Aufnahme (Nachbearbeiten) wird der
   * Abschnitt sofort mit Ende gesetzt.
   */
  startPending(id, time) {
    const x = this.sections.find((y) => y.id === id && y.start == null);
    if (!x) return { ok: false, error: 'Ablaufpunkt nicht gefunden.' };
    const t = Math.max(0, time == null ? this.duration : time);
    const live = this.status === 'recording' || this.status === 'paused';
    const open = this.openSection();
    const placed = this.placedSections().filter((o) => o !== x);

    // Prüfen, bevor etwas verändert wird: ein umschließender Abschnitt wird an dieser
    // Stelle beendet, darf dadurch aber nicht verschwinden.
    const cut = placed.filter((o) => o.end != null && o.start < t && o.end > t);
    if (cut.some((o) => t - o.start < MIN_SECTION)) {
      return { ok: false, error: 'Zu nah am Anfang eines bestehenden Abschnitts.' };
    }
    const next = placed.filter((o) => o.start >= t).sort((a, b) => a.start - b.start)[0];
    if (next && next.start - t < MIN_SECTION) {
      return { ok: false, error: 'Dort beginnt bereits ein anderer Abschnitt.' };
    }

    if (open && t > open.start) open.end = t;   // liegt die Stelle davor, bleibt der laufende unberührt
    cut.forEach((o) => { o.end = t; });
    x.start = t;
    if (next) {
      // Bis zum nächsten Abschnitt, höchstens die geplante Dauer.
      x.end = x.plannedDuration ? Math.min(t + x.plannedDuration, next.start) : next.start;
      x.end = Math.max(x.end, t + MIN_SECTION);
    } else if (!live) {
      const planned = x.plannedDuration ? t + x.plannedDuration : this.duration;
      x.end = Math.min(Math.max(planned, t + MIN_SECTION), Math.max(this.duration, t + MIN_SECTION));
    }
    this._changed();
    return { ok: true, section: x };
  }

  /**
   * Legt einen Ablaufpunkt per Drag & Drop an einer beliebigen Stelle ab.
   * - In einer Lücke zwischen zwei Abschnitten (oder vor dem ersten) füllt er genau diese Lücke.
   * - Hinter dem letzten Abschnitt beginnt er an der Ablagestelle.
   * - Mitten in einem bestehenden Abschnitt beginnt er dort und kürzt diesen.
   */
  placePending(id, time) {
    const x = this.sections.find((y) => y.id === id && y.start == null);
    if (!x) return { ok: false, error: 'Ablaufpunkt nicht gefunden.' };
    const t = Math.max(0, time == null ? this.duration : time);
    const placed = this.placedSections();
    const endOf = (o) => SectionLogic.endOf(o, this.duration);

    const inside = placed.some((o) => o.start <= t && endOf(o) > t);
    const next = placed.find((o) => o.start > t);
    if (inside || !next) return this.startPending(id, t);

    const prevEnds = placed.filter((o) => endOf(o) <= t).map(endOf);
    const gapStart = prevEnds.length ? Math.max(...prevEnds) : 0;
    if (next.start - gapStart < MIN_SECTION) return { ok: false, error: 'Die Lücke ist zu klein.' };
    x.start = gapStart;
    x.end = next.start;
    this._changed();
    return { ok: true, section: x };
  }

  /** Beendet einen laufenden Abschnitt und beginnt den nächsten offenen Ablaufpunkt. */
  startNextPending(time) {
    const pending = this.pendingSections().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (pending.length === 0) {
      const closed = this.openSection() ? this.endSection(time) : null;
      return closed || { ok: false, error: 'Keine offenen Ablaufplan-Punkte mehr.' };
    }
    return this.startPending(pending[0].id, time);
  }

  /** Verschiebt Anfang oder Ende eines Abschnitts; Nachbarn weichen aus, nichts überlappt. */
  moveEdge(id, edge, time) {
    const result = SectionLogic.moveEdge(this.sections, id, edge, time, this.duration);
    if (!result) return null;
    this._changed();
    return result.section;
  }

  /** Merkt, dass ein Abschnitt als MP3 gesichert wurde (mit Zeitraum, um spätere Änderungen zu erkennen). */
  recordExport(segmentId, { file, start, end }) {
    this.exports[segmentId] = { file, start, end, at: new Date().toISOString() };
    this._changed();
    this.save();
  }

  updateSection(id, patch) {
    const x = this.sections.find((y) => y.id === id);
    if (!x) return null;
    if (patch.label != null) x.label = patch.label;
    if (patch.category !== undefined) x.category = patch.category;
    this._changed();
    return x;
  }

  removeSection(id) {
    const x = this.sections.find((y) => y.id === id);
    if (!x) return false;
    // Ablaufplan-Punkte werden nicht gelöscht, sondern nur von der Zeitachse genommen.
    if (x.source === 'churchtools' && x.start != null) {
      x.start = null;
      x.end = null;
    } else {
      this.sections = this.sections.filter((y) => y.id !== id);
    }
    this._changed();
    return true;
  }

  /* ----------------------------------------------------------------- Aufnahme */

  start({ sampleRate, channels } = {}) {
    if (this.status === 'recording') return { ok: false, error: 'Es läuft bereits eine Aufnahme.' };
    if (this.status === 'paused') return this.resume();

    this.sampleRate = sampleRate || this.sampleRate;
    this.channels = channels || 2;

    const dir = settings.get('recordingsDir');
    fs.mkdirSync(dir, { recursive: true });

    // Eine frühere Aufnahme bleibt als Datei erhalten; die Abschnitte gehören aber
    // zu ihr und werden für die neue Aufnahme zurückgesetzt.
    if (this.status === 'stopped') this._resetSectionsForNewRecording();

    const stamp = `${dateStamp()}_${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
    const base = this._freeBasePath(path.join(dir, `${stamp}_${slug(this.service.name, 'Gottesdienst')}`));
    this.basePath = base;
    this.wavPath = `${base}.wav`;
    this.writer = new WavWriter(this.wavPath, this.sampleRate, this.channels);
    this.startedAt = new Date().toISOString();
    this.status = 'recording';
    this.finalized = false;
    this.peaks = [];
    this._restoredDuration = 0;
    this._bucketAcc = 0;
    this._bucketFrames = 0;
    this.levels = { l: 0, r: 0, clip: false };

    this._startAutosave();
    this._changed();
    this.emit('recording-started', { wavPath: this.wavPath, sampleRate: this.sampleRate, channels: this.channels });
    return { ok: true, wavPath: this.wavPath };
  }

  /** Hängt bei Namensgleichheit (gleiche Minute) eine Nummer an, damit nie eine Aufnahme überschrieben wird. */
  _freeBasePath(base) {
    let candidate = base;
    for (let n = 2; fs.existsSync(`${candidate}.wav`) || fs.existsSync(`${candidate}.session.json`); n++) {
      candidate = `${base}_${n}`;
    }
    return candidate;
  }

  /** Ablaufplan-Punkte werden wieder offen, selbst angelegte Abschnitte entfallen. */
  _resetSectionsForNewRecording() {
    this.exports = {};
    this.sections = this.sections
      .filter((x) => x.source === 'churchtools')
      .map((x) => ({ ...x, start: null, end: null }));
  }

  /** Setzt die beendete Aufnahme fort: neue Audiodaten werden an die WAV-Datei angehängt. */
  continueRecording() {
    if (this.status !== 'stopped') return { ok: false, error: 'Es gibt keine beendete Aufnahme zum Fortsetzen.' };
    if (!this.wavPath || !fs.existsSync(this.wavPath)) {
      return { ok: false, error: 'Die Audiodatei dieser Aufnahme wurde nicht gefunden.' };
    }
    const info = readInfo(this.wavPath);
    this.sampleRate = info.sampleRate;
    this.channels = info.channels;
    this.writer = new WavWriter(this.wavPath, this.sampleRate, this.channels, { append: true });
    this.status = 'recording';
    this.finalized = false;
    this._bucketAcc = 0;
    this._bucketFrames = 0;
    this.levels = { l: 0, r: 0, clip: false };
    // Wellenform bis zum Dateiende auffüllen, falls die Peak-Daten kürzer sind.
    const wanted = Math.floor((this.writer.durationSeconds * 1000) / PEAK_BUCKET_MS);
    while (this.peaks.length < wanted) this.peaks.push(0);
    this.peaks.length = Math.min(this.peaks.length, wanted);

    this._startAutosave();
    this._changed();
    this.emit('recording-started', { wavPath: this.wavPath, sampleRate: this.sampleRate, channels: this.channels });
    return { ok: true, wavPath: this.wavPath, sampleRate: this.sampleRate, channels: this.channels };
  }

  pause() {
    if (this.status !== 'recording') return { ok: false, error: 'Es läuft keine Aufnahme.' };
    this.status = 'paused';
    if (this.writer) this.writer.updateHeader();
    this.save();
    this._changed();
    return { ok: true };
  }

  resume() {
    if (this.status !== 'paused') return { ok: false, error: 'Die Aufnahme ist nicht pausiert.' };
    this.status = 'recording';
    this._changed();
    return { ok: true };
  }

  stop() {
    if (this.status !== 'recording' && this.status !== 'paused') {
      return { ok: false, error: 'Es läuft keine Aufnahme.' };
    }
    this._restoredDuration = this.duration;
    this._closeOpen(this._restoredDuration);
    if (this.writer) this.writer.close();
    this.status = 'stopped';
    this.finalized = true;
    this._stopAutosave();
    this.save();
    this._changed();
    this.emit('recording-stopped', { wavPath: this.wavPath, duration: this._restoredDuration });
    return { ok: true, wavPath: this.wavPath, duration: this._restoredDuration };
  }

  /**
   * Nimmt einen Audioblock aus dem Renderer entgegen (Int16LE, interleaved).
   * Berechnet nebenbei Pegel und Wellenform-Spitzenwerte.
   */
  pushAudio(buffer) {
    if (this.status !== 'recording' || !this.writer) return;
    this.writer.write(buffer);

    const ch = this.channels;
    const frames = buffer.length / (2 * ch);
    let peakL = 0;
    let peakR = 0;
    const bucketFrames = Math.round((this.sampleRate * PEAK_BUCKET_MS) / 1000);

    for (let f = 0; f < frames; f++) {
      const l = Math.abs(buffer.readInt16LE(f * ch * 2)) / 32768;
      const r = ch > 1 ? Math.abs(buffer.readInt16LE(f * ch * 2 + 2)) / 32768 : l;
      if (l > peakL) peakL = l;
      if (r > peakR) peakR = r;
      const m = Math.max(l, r);
      if (m > this._bucketAcc) this._bucketAcc = m;
      this._bucketFrames += 1;
      if (this._bucketFrames >= bucketFrames) {
        this.peaks.push(Math.round(this._bucketAcc * 255));
        this._bucketAcc = 0;
        this._bucketFrames = 0;
      }
    }

    const now = Date.now();
    if (peakL >= 0.999 || peakR >= 0.999) this._clipUntil = now + 2000;
    this.levels = { l: peakL, r: peakR, clip: now < this._clipUntil };

    this.emit('levels', { ...this.levels, duration: this.duration });
  }

  /**
   * Liest einen Ausschnitt der Aufnahme zum Mithören – auch während sie läuft.
   * Beim Schreiben wird jeder Block sofort in die Datei übergeben, daher
   * genügt ein separater Lesezugriff.
   */
  readAudio(startSec, seconds) {
    if (!this.wavPath || !fs.existsSync(this.wavPath)) return null;
    const start = Math.max(0, startSec || 0);
    const end = Math.min(start + Math.min(Math.max(seconds || 1, 0.1), 10), this.duration);
    if (end <= start) return { sampleRate: this.sampleRate, channels: this.channels, samples: new Int16Array(0) };
    return readSlice(this.wavPath, start, end);
  }

  /* -------------------------------------------------------- Speichern / Laden */

  _startAutosave() {
    this._stopAutosave();
    this._autosave = setInterval(() => {
      if (this._dirty) this.save();
    }, AUTOSAVE_MS);
  }

  _stopAutosave() {
    if (this._autosave) clearInterval(this._autosave);
    this._autosave = null;
  }

  sessionFilePath() {
    return this.basePath ? `${this.basePath}.session.json` : null;
  }

  save() {
    const target = this.sessionFilePath();
    if (!target) return;
    const data = {
      version: 2,
      app: 'church-recorder',
      service: this.service,
      status: this.status,
      finalized: this.finalized,
      startedAt: this.startedAt,
      sampleRate: this.sampleRate,
      channels: this.channels,
      duration: this.duration,
      wavPath: this.wavPath,
      sections: this.sections,
      exports: this.exports,
      peaks: this.peaks
    };
    try {
      fs.writeFileSync(target + '.tmp', JSON.stringify(data), 'utf8');
      fs.renameSync(target + '.tmp', target);
      this._dirty = false;
    } catch (err) {
      console.error('Session konnte nicht gespeichert werden:', err);
      this.emit('error-notice', 'Die Session-Datei konnte nicht gespeichert werden.');
    }
  }

  /** Lädt eine gespeicherte Session zum Nachbearbeiten/Exportieren. */
  loadFromFile(sessionPath) {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    this.reset();
    this.basePath = sessionPath.replace(/\.session\.json$/, '');
    this.wavPath = data.wavPath && fs.existsSync(data.wavPath) ? data.wavPath : `${this.basePath}.wav`;
    this.service = data.service || this.service;
    this.peaks = data.peaks || [];
    this.sampleRate = data.sampleRate || this.sampleRate;
    this.channels = data.channels || 2;
    this.startedAt = data.startedAt || null;
    this.status = 'stopped';
    this.finalized = true;
    this.writer = null;

    let duration = data.duration || 0;
    try {
      if (fs.existsSync(this.wavPath)) duration = readInfo(this.wavPath).duration;
    } catch { /* Dauer aus der Session-Datei verwenden */ }
    this._restoredDuration = duration;
    this.sections = migrateSections(data, duration);
    this.exports = data.exports || {};
    this._colorSeq = this.sections.reduce((m, x) => Math.max(m, (x.color ?? -1) + 1), 0);

    this._changed();
    return this.snapshot();
  }
}

module.exports = { Session, slug, dateStamp, PEAK_BUCKET_MS };
