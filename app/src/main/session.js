'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { WavWriter, readInfo } = require('./wav');
const settings = require('./settings');

const PEAK_BUCKET_MS = 50;   // Auflösung der Wellenform
const AUTOSAVE_MS = 3000;

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
 * Eine Session ist eine Aufnahme: eine durchgehende WAV-Masterdatei plus
 * Marker, Transkript und Metadaten. Marker sind reine Metadaten – die
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
    this.markers = [];                  // {id,label,category,time|null,source,placed}
    this.transcript = [];               // {start,end,text}
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

  /** Marker mit Position, chronologisch sortiert. */
  placedMarkers() {
    return this.markers.filter((m) => m.placed && m.time != null).sort((a, b) => a.time - b.time);
  }

  /** Offene Ablaufplan-Punkte, die noch nicht auf der Zeitachse liegen. */
  pendingMarkers() {
    return this.markers.filter((m) => !m.placed);
  }

  /**
   * Aus den Markern abgeleitete Abschnitte. Vor dem ersten Marker entsteht
   * automatisch ein Abschnitt "Vorspann".
   */
  segments() {
    const placed = this.placedMarkers();
    const end = this.duration;
    const out = [];
    if (placed.length === 0) {
      if (end > 0) out.push({ id: 'seg_full', label: 'Gesamte Aufnahme', category: null, start: 0, end, markerId: null });
      return out;
    }
    if (placed[0].time > 0.05) {
      out.push({ id: 'seg_vorspann', label: 'Vorspann', category: null, start: 0, end: placed[0].time, markerId: null });
    }
    placed.forEach((m, i) => {
      const next = placed[i + 1];
      out.push({
        id: 'seg_' + m.id,
        label: m.label,
        category: m.category || null,
        start: m.time,
        end: next ? next.time : end,
        markerId: m.id
      });
    });
    return out;
  }

  /** Der Abschnitt, in dem die Aufnahme gerade läuft. */
  currentSegment() {
    const segs = this.segments();
    const t = this.duration;
    return segs.find((s) => t >= s.start && t <= s.end) || segs[segs.length - 1] || null;
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
      markers: this.markers,
      pending: this.pendingMarkers(),
      segments: this.segments(),
      currentSegment: this.currentSegment(),
      wavPath: this.wavPath,
      transcriptCount: this.transcript.length
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

  /** Übernimmt Ablaufplan-Punkte als noch nicht positionierte Platzhalter. */
  setAgenda(items) {
    const manual = this.markers.filter((m) => m.source === 'manual');
    const placedFromPlan = this.markers.filter((m) => m.source === 'churchtools' && m.placed);
    const keepIds = new Set(placedFromPlan.map((m) => m.ctId));
    const fresh = (items || [])
      .filter((it) => !keepIds.has(it.id))
      .map((it, i) => ({
        id: newId('mk'),
        ctId: it.id ?? null,
        label: it.title || `Punkt ${i + 1}`,
        category: it.category || null,
        plannedDuration: it.duration || null,
        order: i,
        time: null,
        placed: false,
        source: 'churchtools'
      }));
    this.markers = [...placedFromPlan, ...fresh, ...manual];
    this._changed();
  }

  addMarker({ label, category, time, source = 'manual' } = {}) {
    const t = time == null ? this.duration : Math.max(0, time);
    const marker = {
      id: newId('mk'),
      ctId: null,
      label: label || `Marker ${this.placedMarkers().length + 1}`,
      category: category || null,
      plannedDuration: null,
      order: this.markers.length,
      time: t,
      placed: true,
      source
    };
    this.markers.push(marker);
    this._changed();
    return marker;
  }

  /** Setzt einen bisher offenen Ablaufplan-Punkt auf die Zeitachse. */
  placeMarker(id, time) {
    const m = this.markers.find((x) => x.id === id);
    if (!m) return null;
    m.time = Math.max(0, time == null ? this.duration : time);
    m.placed = true;
    this._changed();
    return m;
  }

  /** Nächsten offenen Ablaufplan-Punkt an der aktuellen Position setzen. */
  placeNextPending(time) {
    const pending = this.pendingMarkers().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (pending.length === 0) return null;
    return this.placeMarker(pending[0].id, time);
  }

  moveMarker(id, time) {
    const m = this.markers.find((x) => x.id === id);
    if (!m || !m.placed) return null;
    m.time = Math.max(0, Math.min(time, Math.max(this.duration, 0)));
    this._changed();
    return m;
  }

  updateMarker(id, patch) {
    const m = this.markers.find((x) => x.id === id);
    if (!m) return null;
    if (patch.label != null) m.label = patch.label;
    if (patch.category !== undefined) m.category = patch.category;
    this._changed();
    return m;
  }

  removeMarker(id) {
    const before = this.markers.length;
    const m = this.markers.find((x) => x.id === id);
    if (!m) return false;
    // Ablaufplan-Punkte werden nicht gelöscht, sondern nur von der Zeitachse genommen.
    if (m.source === 'churchtools' && m.placed) {
      m.placed = false;
      m.time = null;
    } else {
      this.markers = this.markers.filter((x) => x.id !== id);
    }
    this._changed();
    return this.markers.length !== before || !m.placed;
  }

  /* ----------------------------------------------------------------- Aufnahme */

  start({ sampleRate, channels } = {}) {
    if (this.status === 'recording') return { ok: false, error: 'Es läuft bereits eine Aufnahme.' };
    if (this.status === 'paused') return this.resume();

    this.sampleRate = sampleRate || this.sampleRate;
    this.channels = channels || 2;

    const dir = settings.get('recordingsDir');
    fs.mkdirSync(dir, { recursive: true });

    const stamp = `${dateStamp()}_${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
    const base = path.join(dir, `${stamp}_${slug(this.service.name, 'Gottesdienst')}`);
    this.basePath = base;
    this.wavPath = `${base}.wav`;
    this.writer = new WavWriter(this.wavPath, this.sampleRate, this.channels);
    this.startedAt = new Date().toISOString();
    this.status = 'recording';
    this.finalized = false;
    this.peaks = [];
    this.transcript = [];
    this._restoredDuration = 0;

    this._startAutosave();
    this._changed();
    this.emit('recording-started', { wavPath: this.wavPath, sampleRate: this.sampleRate, channels: this.channels });
    return { ok: true, wavPath: this.wavPath };
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
    const startFrame = this.writer.frames;
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

    this.emit('audio', {
      buffer,
      startFrame,
      sampleRate: this.sampleRate,
      channels: this.channels,
      startTime: startFrame / this.sampleRate
    });
    this.emit('levels', { ...this.levels, duration: this.duration });
  }

  addTranscript(segment) {
    this.transcript.push(segment);
    if (this.transcript.length > 5000) this.transcript.shift();
    this._dirty = true;
    this.emit('transcript', segment);
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
      version: 1,
      app: 'church-recorder',
      service: this.service,
      status: this.status,
      finalized: this.finalized,
      startedAt: this.startedAt,
      sampleRate: this.sampleRate,
      channels: this.channels,
      duration: this.duration,
      wavPath: this.wavPath,
      markers: this.markers,
      transcript: this.transcript,
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
    this.markers = data.markers || [];
    this.transcript = data.transcript || [];
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

    this._changed();
    return this.snapshot();
  }
}

module.exports = { Session, slug, dateStamp, PEAK_BUCKET_MS };
