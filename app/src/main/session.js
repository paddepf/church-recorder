'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { WavWriter, readInfo, readSlice } = require('./wav');
const settings = require('./settings');
const SectionLogic = require('../shared/sections');
const RoleLogic = require('../shared/roles');

const PEAK_BUCKET_MS = 50;   // Auflösung der Wellenform
const AUTOSAVE_MS = 3000;
const MIN_SECTION = SectionLogic.MIN_SECTION;
const MIN_CUT = 0.2;       // kürzester Schnitt in Sekunden
const UNDO_LIMIT = 60;     // so viele Schritte lassen sich zurücknehmen

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
    this.flushSave();                   // Änderungen der bisherigen Session nicht verlieren
    this.status = 'idle';               // idle | recording | paused | stopped
    this.service = { id: null, name: '', date: dateStamp() };
    this.sections = [];                 // {id,label,category,color,start|null,end|null,source}
    this.exports = {};                  // Segment-ID -> {file,start,end,cuts,at}: bereits als MP3 gesichert
    this.cuts = [];                     // {id,start,end|null}: beim MP3-Export ausgelassene Stellen
    this._undo = [];                    // frühere Bearbeitungsstände (Abschnitte + Schnitte) als JSON
    this._redo = [];
    this._lastEdit = this._editJson();
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
    // In der Reihenfolge des Ablaufplans (Umsortieren ändert nur "order", nicht die Lage im Array).
    return this.sections.filter((x) => x.start == null).sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /** Der Abschnitt, der gerade läuft (Anfang gesetzt, Ende noch offen). */
  openSection() {
    return this.sections.find((x) => x.start != null && x.end == null) || null;
  }

  _segmentOf(x) {
    const end = x.end != null ? x.end : this.duration;
    const cuts = this.cutsWithin(x.start, end);
    return {
      id: 'seg_' + x.id,
      label: x.label,
      category: x.category || null,
      start: x.start,
      end,
      cuts,
      cutSeconds: cuts.reduce((sum, c) => sum + (c.end - c.start), 0),
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
      const cuts = this.cutsWithin(0, this.duration);
      out.push({
        id: 'seg_full', label: 'Gesamte Aufnahme', category: null, start: 0, end: this.duration,
        cuts, cutSeconds: cuts.reduce((sum, c) => sum + (c.end - c.start), 0), markerId: null
      });
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
      cuts: this.cuts,
      pending: this.pendingSections(),
      segments: this.segments(),
      currentSegment: this.currentSegment(),
      wavPath: this.wavPath
    };
  }

  /**
   * Meldet eine Änderung. Hat sich dabei die Bearbeitung (Abschnitte oder Schnitte) geändert,
   * wird der vorherige Stand für "Rückgängig" gemerkt.
   */
  _changed({ undoable = true } = {}) {
    const now = this._editJson();
    if (undoable && now !== this._lastEdit) {
      this._undo.push(this._lastEdit);
      if (this._undo.length > UNDO_LIMIT) this._undo.shift();
      this._redo = [];
    }
    this._lastEdit = now;
    this._dirty = true;
    // Außerhalb der Aufnahme läuft kein Autosave: Änderungen (Abschnitte, Schnitte …) kurz gebündelt speichern.
    if (!this._autosave && this.basePath) this._scheduleSave();
    this.emit('state', this.snapshot());
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) this.save();
    }, 800);
  }

  /** Noch ausstehende Änderungen sofort speichern (vor dem Laden einer anderen Session, beim Beenden). */
  flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty && this.basePath) this.save();
  }

  _editJson() {
    return JSON.stringify({ sections: this.sections, cuts: this.cuts });
  }

  _resetUndo() {
    this._undo = [];
    this._redo = [];
    this._lastEdit = this._editJson();
  }

  _restoreEdit(json) {
    const data = JSON.parse(json);
    this.sections = data.sections;
    this.cuts = data.cuts || [];
    this._changed({ undoable: false });
  }

  /** Macht die letzte Änderung an Abschnitten oder Schnitten rückgängig. */
  undo() {
    if (this._undo.length === 0) return { ok: false, error: 'Nichts zum Rückgängigmachen.' };
    this._redo.push(this._editJson());
    this._restoreEdit(this._undo.pop());
    return { ok: true };
  }

  redo() {
    if (this._redo.length === 0) return { ok: false, error: 'Nichts zum Wiederholen.' };
    this._undo.push(this._editJson());
    this._restoreEdit(this._redo.pop());
    return { ok: true };
  }

  /* ----------------------------------------------------------------- Schnitte */

  /** Schnittbereiche innerhalb von [start, end], auf diesen Zeitraum begrenzt. */
  cutsWithin(start, end) {
    return this.cuts
      .map((c) => ({ start: Math.max(c.start, start), end: Math.min(c.end != null ? c.end : this.duration, end) }))
      .filter((c) => c.end - c.start > 0.001)
      .sort((a, b) => a.start - b.start);
  }

  /** Verschmilzt überlappende (beendete) Schnitte. */
  _mergeCuts() {
    const closed = this.cuts.filter((c) => c.end != null).sort((a, b) => a.start - b.start);
    const open = this.cuts.filter((c) => c.end == null);
    const merged = [];
    closed.forEach((c) => {
      const last = merged[merged.length - 1];
      if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
      else merged.push({ ...c });
    });
    this.cuts = [...merged, ...open];
  }

  /** Legt einen Schnitt an: diese Stelle fehlt in den MP3-Exporten. */
  addCut(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, error: 'Ungültige Zeitangabe.' };
    const max = Math.max(this.duration, 0);
    const a = Math.max(0, Math.min(start, end));
    const b = Math.min(max, Math.max(start, end));
    if (b - a < MIN_CUT) return { ok: false, error: 'Der Schnitt ist zu kurz.' };
    const cut = { id: newId('cut'), start: a, end: b };
    this.cuts.push(cut);
    this._mergeCuts();
    this._changed();
    return { ok: true, cut };
  }

  /** Taste X: beginnt einen Schnitt an der aktuellen Stelle bzw. beendet den offenen. */
  toggleCut(time) {
    const t = Math.max(0, time == null ? this.duration : time);
    const open = this.cuts.find((c) => c.end == null);
    if (!open) {
      this.cuts.push({ id: newId('cut'), start: t, end: null });
      this._changed();
      return { ok: true, change: 'started' };
    }
    if (t - open.start < MIN_CUT) {
      this.cuts = this.cuts.filter((c) => c !== open);
      this._changed();
      return { ok: true, change: 'discarded' };
    }
    open.end = t;
    this._mergeCuts();
    this._changed();
    return { ok: true, change: 'ended' };
  }

  moveCutEdge(id, edge, time) {
    const cut = this.cuts.find((c) => c.id === id);
    if (!cut) return { ok: false, error: 'Schnitt nicht gefunden.' };
    if (!Number.isFinite(time)) return { ok: false, error: 'Ungültige Zeitangabe.' };
    const max = Math.max(this.duration, 0);
    const t = Math.max(0, Math.min(time, max));
    if (edge === 'start') cut.start = Math.min(t, (cut.end != null ? cut.end : max) - MIN_CUT);
    else if (cut.end != null) cut.end = Math.max(t, cut.start + MIN_CUT);
    this._mergeCuts();
    this._changed();
    return { ok: true };
  }

  removeCut(id) {
    const before = this.cuts.length;
    this.cuts = this.cuts.filter((c) => c.id !== id);
    if (this.cuts.length === before) return { ok: false, error: 'Schnitt nicht gefunden.' };
    this._changed();
    return { ok: true };
  }

  /** Offene Schnitte am Ende der Aufnahme schließen (zu kurze entfallen). */
  _closeOpenCuts(time) {
    this.cuts = this.cuts
      .map((c) => (c.end == null ? { ...c, end: time } : c))
      .filter((c) => c.end - c.start >= MIN_CUT);
  }


  /* ------------------------------------------------------- Ablaufplan / Marker */

  setService(service) {
    this.service = {
      id: service?.id ?? null,
      name: service?.name || 'Gottesdienst',
      date: service?.date || dateStamp(),
      // Personen aus der ChurchTools-Dienstplanung (z. B. Leitung, Predigt) als Interpret-Vorschläge
      suggestions: Array.isArray(service?.suggestions) ? service.suggestions : [],
      // Infotext des Termins aus ChurchTools (bei der Bibelstunde z. B. der Predigttitel)
      info: service?.info ? String(service.info) : null
    };
    this._changed();
  }

  _nextColor() {
    const c = this._colorSeq;
    this._colorSeq += 1;
    return c;
  }

  /** Übernimmt Ablaufplan-Punkte als noch nicht gesetzte Abschnitte. */
  setAgenda(items, source = 'churchtools') {
    const manual = this.sections.filter((x) => x.source === 'manual');
    const placedFromPlan = this.sections.filter((x) => x.source !== 'manual' && x.start != null);
    const keepIds = new Set(placedFromPlan.map((x) => x.ctId).filter((id) => id != null));
    // Punkte aus Vorlagen haben keine ChurchTools-Id: bereits gesetzte am Namen erkennen, sonst entstehen Doppelte.
    const keepLabels = new Set(placedFromPlan.filter((x) => x.ctId == null).map((x) => String(x.baseLabel || x.label).trim().toLowerCase()));
    const fresh = (items || [])
      .filter((it) => !(it.id != null && keepIds.has(it.id)))
      .filter((it) => !(it.id == null && keepLabels.has(String(it.title || '').trim().toLowerCase())))
      .map((it, i) => ({
        id: newId('sec'),
        ctId: it.id ?? null,
        label: it.title || `Punkt ${i + 1}`,
        category: it.category || null,
        plannedDuration: it.duration || null,
        artist: it.responsible || null,       // zuständige Person aus dem Ablaufplan
        order: i,
        color: this._nextColor(),
        start: null,
        end: null,
        source
      }));
    this.sections = [...placedFromPlan, ...fresh, ...manual];
    const autoFilled = this._applySuggestions();
    this._applyInfo();
    this._changed();             // lässt sich rückgängig machen (z. B. versehentlich geladene Vorlage)
    return autoFilled;
  }

  /**
   * Trägt für Punkte ohne Interpret die Personen aus der Dienstplanung ein, deren Dienst zum Namen
   * passt (z. B. Dienst "Predigt 2" beim Punkt "Predigt"). Gibt zurück, bei wie vielen Punkten das geschah.
   */
  _applySuggestions() {
    const suggestions = this.service.suggestions || [];
    if (suggestions.length === 0) return 0;
    let count = 0;
    this.sections.forEach((x) => {
      if (x.artist) return;
      const names = RoleLogic.namesForLabel(x.label, suggestions);
      if (names.length) {
        x.artist = names.join(', ');
        count += 1;
      }
    });
    return count;
  }

  /**
   * Hängt den Infotext des Termins an den Predigt-Abschnitt („Predigt: Kolosser 2,6-7 Verwurzelt in Christus“).
   * Nur der erste passende Abschnitt, nur einmal (`baseLabel` merkt den ursprünglichen Namen) und nur, wenn
   * der Text nicht schon im Namen steht.
   */
  _applyInfo() {
    const info = this.service.info;
    if (!info) return false;
    const target = this.sections.find((x) => RoleLogic.takesEventInfo(x.label) || (x.baseLabel && RoleLogic.takesEventInfo(x.baseLabel)));
    if (!target || target.baseLabel) return false;
    if (String(target.label).toLowerCase().includes(info.toLowerCase())) return false;
    target.baseLabel = target.label;
    target.label = `${target.label}: ${info}`;
    return true;
  }

  _closeOpen(time) {
    const open = this.openSection();
    if (!open) return null;
    open.end = Math.max(open.start + MIN_SECTION, time);
    return open;
  }

  /** Beginnt einen neuen, selbst benannten Abschnitt. */
  startSection({ label, category, artist, time, source = 'manual' } = {}) {
    if (this.openSection()) return { ok: false, error: 'Es läuft bereits ein Abschnitt – zuerst beenden.' };
    const t = time == null ? this.duration : Math.max(0, time);
    const section = {
      id: newId('sec'),
      ctId: null,
      label: label || `Abschnitt ${this.placedSections().length + 1}`,
      category: category || null,
      plannedDuration: null,
      artist: artist || null,
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

  /** Neuen offenen Ablaufpunkt am Ende des Ablaufplans anlegen. */
  addPending({ label, artist } = {}) {
    const name = String(label || '').trim();
    if (!name) return { ok: false, error: 'Bitte einen Namen eingeben.' };
    const maxOrder = this.pendingSections().reduce((m, x) => Math.max(m, x.order || 0), -1);
    const section = {
      id: newId('sec'),
      ctId: null,
      label: name,
      category: null,
      plannedDuration: null,
      artist: artist ? String(artist).trim() || null : null,
      order: maxOrder + 1,
      color: this._nextColor(),
      start: null,
      end: null,
      source: 'plan'
    };
    this.sections.push(section);
    this._changed();
    return { ok: true, section };
  }

  /** Verschiebt einen offenen Ablaufpunkt vor einen anderen (beforeId = null: ans Ende). */
  reorderPending(id, beforeId) {
    const list = this.pendingSections().sort((a, b) => (a.order || 0) - (b.order || 0));
    const moving = list.find((x) => x.id === id);
    if (!moving) return { ok: false, error: 'Ablaufpunkt nicht gefunden.' };
    const rest = list.filter((x) => x !== moving);
    const at = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1;
    rest.splice(at < 0 ? rest.length : at, 0, moving);
    rest.forEach((x, i) => { x.order = i; });
    this._changed();
    return { ok: true };
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
  recordExport(segmentId, { file, start, end, cuts }) {
    this.exports[segmentId] = { file, start, end, cuts: cuts || [], at: new Date().toISOString() };
    this._changed();
    this.save();
  }

  updateSection(id, patch) {
    const x = this.sections.find((y) => y.id === id);
    if (!x) return null;
    if (patch.label != null) x.label = patch.label;
    if (patch.category !== undefined) x.category = patch.category;
    if (patch.artist !== undefined) x.artist = patch.artist ? String(patch.artist).trim() || null : null;
    this._changed();
    return x;
  }

  removeSection(id) {
    const x = this.sections.find((y) => y.id === id);
    if (!x) return false;
    // Ablaufplan-Punkte (egal ob aus ChurchTools oder selbst angelegt) werden von der Zeitachse
    // genommen und bleiben offen; offene Punkte und selbst gesetzte Abschnitte werden gelöscht.
    if (x.source !== 'manual' && x.start != null) {
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

    const rate = sampleRate || this.sampleRate;
    const ch = channels || 2;

    const dir = settings.get('recordingsDir');
    fs.mkdirSync(dir, { recursive: true });

    // Erst die Datei anlegen: Scheitert das (Ordner nicht beschreibbar …), bleibt die bisher
    // angezeigte Aufnahme samt Abschnitten unverändert.
    const stamp = `${dateStamp()}_${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
    const base = this._freeBasePath(path.join(dir, `${stamp}_${slug(this.service.name, 'Gottesdienst')}`));
    let writer;
    try {
      writer = new WavWriter(`${base}.wav`, rate, ch);
    } catch (err) {
      return { ok: false, error: 'Die Aufnahmedatei konnte nicht angelegt werden: ' + err.message };
    }
    this.flushSave();

    // Eine frühere Aufnahme bleibt als Datei erhalten; die Abschnitte gehören aber
    // zu ihr und werden für die neue Aufnahme zurückgesetzt.
    if (this.status === 'stopped') this._resetSectionsForNewRecording();
    this.cuts = [];

    this.sampleRate = rate;
    this.channels = ch;
    this.basePath = base;
    this.wavPath = `${base}.wav`;
    this.writer = writer;
    this._attachWriter(writer);
    this.startedAt = new Date().toISOString();
    this.status = 'recording';
    this.finalized = false;
    this.peaks = [];
    this._restoredDuration = 0;
    this._bucketAcc = 0;
    this._bucketFrames = 0;
    this.levels = { l: 0, r: 0, clip: false };

    this._startAutosave();
    this._changed({ undoable: false });
    this._resetUndo();
    this.save();                 // Session-Datei sofort anlegen, damit auch ein früher Absturz wiederherstellbar ist
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
      .filter((x) => x.source !== 'manual')
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
    this._attachWriter(this.writer);
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

  /** Fehler und Engpässe des Schreib-Threads weitergeben (Platte voll, Laufwerk zu langsam …). */
  _attachWriter(writer) {
    writer.on('error', (err) => this.emit('write-error', err));
    writer.on('slow', (slow) => this.emit('write-slow', slow));
  }

  /** Erfüllt sich, sobald die zuletzt beendete Aufnahme vollständig auf der Platte ist. */
  whenWritten() {
    return this._closing || Promise.resolve();
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
    this._closeOpenCuts(this._restoredDuration);
    // Der Schreib-Thread leert seine Warteschlange und schließt die Datei; whenWritten() wartet darauf.
    this._closing = this.writer ? this.writer.close() : null;
    if (this._closing) {
      this.writing = true;
      this._closing.finally(() => { this.writing = false; });
    }
    this.status = 'stopped';
    this.finalized = true;
    this._stopAutosave();
    this.save();
    this._changed({ undoable: false });
    this._resetUndo();
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
      // Wellenform und Dauer ändern sich laufend, ohne dass etwas "dirty" wird: spätestens alle 30 s sichern,
      // damit eine unterbrochene Aufnahme mit (fast) vollständiger Wellenform wiederhergestellt wird.
      const stale = this.status === 'recording' && Date.now() - (this._lastSave || 0) > 30000;
      if (this._dirty || stale) this.save();
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
      cuts: this.cuts,
      peaks: this.peaks
    };
    try {
      fs.writeFileSync(target + '.tmp', JSON.stringify(data), 'utf8');
      fs.renameSync(target + '.tmp', target);
      this._dirty = false;
      this._lastSave = Date.now();
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
    this.cuts = (data.cuts || []).map((c) => ({ ...c, end: c.end != null ? c.end : duration })).filter((c) => c.end - c.start >= MIN_CUT);
    this._colorSeq = this.sections.reduce((m, x) => Math.max(m, (x.color ?? -1) + 1), 0);

    this._changed({ undoable: false });
    this._resetUndo();
    // Eine unterbrochene Aufnahme gilt nach dem Öffnen als wiederhergestellt: so in der Datei vermerken,
    // sonst wird sie bei jedem Start erneut als "unterbrochen" gemeldet.
    if (data.finalized === false || data.status === 'recording' || data.status === 'paused') this.save();
    return this.snapshot();
  }
}

module.exports = { Session, slug, dateStamp, PEAK_BUCKET_MS };
