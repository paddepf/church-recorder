/* Wellenform-Ansicht: zeichnet die laufende Aufnahme und die Abschnitte
   (je eine Anfangs- und Endmarke), erlaubt Verschieben der Marken und
   Ablegen offener Ablaufplan-Punkte. */

(function () {
  'use strict';

  const BUCKET_SEC = 0.05;   // Auflösung der Peak-Daten (muss zu session.js passen)
  const RULER_H = 22;
  const FLAG_H = 26;
  const MIN_SECTION = 0.1;
  // Dezente, gut unterscheidbare Farbtöne für die Abschnitte (Reihenfolge der Anlage).
  const HUES = [212, 28, 150, 300, 48, 182, 346, 262];
  const hueOf = (section) => HUES[(section.color || 0) % HUES.length];

  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }

  class Waveform {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.peaks = [];
      this.duration = 0;
      this.sections = [];
      this._hit = [];             // Trefferflächen der Griffe, beim Zeichnen gefüllt
      this.pxPerSec = opts.pxPerSec || 12;
      this.scrollT = 0;
      this.playhead = 0;          // Hörposition (null = keine)
      this.follow = true;
      this.recording = false;
      this.selectedSegment = null;
      this.hoverTime = null;
      this.dragging = null;
      this.colors = opts.colors || {};

      this.onEdgeMove = opts.onEdgeMove || (() => {});
      this.onEdgeMoveEnd = opts.onEdgeMoveEnd || (() => {});
      this.onSeek = opts.onSeek || (() => {});
      this.onSelectSection = opts.onSelectSection || (() => {});
      this.onDropPending = opts.onDropPending || (() => {});
      this.onRenameSection = opts.onRenameSection || (() => {});

      this._bind();
      this.resize();
    }

    /* ------------------------------------------------------------ Geometrie */

    get width() { return this.canvas.clientWidth; }
    get height() { return this.canvas.clientHeight; }
    get viewSeconds() { return this.width / this.pxPerSec; }

    timeToX(t) { return (t - this.scrollT) * this.pxPerSec; }
    xToTime(x) { return this.scrollT + x / this.pxPerSec; }

    clampScroll() {
      const max = Math.max(0, this.duration - this.viewSeconds * 0.98);
      this.scrollT = Math.min(Math.max(0, this.scrollT), Math.max(0, max));
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.floor(this.canvas.clientWidth * dpr);
      this.canvas.height = Math.floor(this.canvas.clientHeight * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    setZoom(pxPerSec, anchorTime) {
      const anchor = anchorTime == null ? this.scrollT + this.viewSeconds / 2 : anchorTime;
      const rel = (anchor - this.scrollT) / this.viewSeconds;
      this.pxPerSec = Math.min(300, Math.max(0.05, pxPerSec));
      this.scrollT = anchor - rel * this.viewSeconds;
      this.clampScroll();
      this.draw();
    }

    scrollTo(t, center = true) {
      this.scrollT = center ? t - this.viewSeconds / 2 : t;
      this.follow = false;
      this.clampScroll();
      this.draw();
    }

    update({ peaks, duration, sections, playhead, recording, selectedSegment }) {
      if (peaks) this.peaks = peaks;
      if (duration != null) this.duration = duration;
      if (sections) this.sections = sections;
      if (playhead !== undefined) this.playhead = playhead;
      if (recording != null) this.recording = recording;
      if (selectedSegment !== undefined) this.selectedSegment = selectedSegment;

      if (this.recording && this.follow) {
        this.scrollT = Math.max(0, this.duration - this.viewSeconds * 0.85);
      }
      this.draw();
    }

    /* ------------------------------------------------------------ Zeichnen */

    draw() {
      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;
      if (!w || !h) return;
      const c = this.colors;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = c.bg || '#131A21';
      ctx.fillRect(0, 0, w, h);

      const laneTop = RULER_H + FLAG_H;
      const laneH = h - laneTop;
      const mid = laneTop + laneH / 2;

      this._hit = [];
      this._drawSegmentBands(laneTop, laneH);
      this._drawRuler();

      // Wellenform
      const startIdx = Math.max(0, Math.floor(this.scrollT / BUCKET_SEC));
      const endIdx = Math.min(this.peaks.length, Math.ceil((this.scrollT + this.viewSeconds) / BUCKET_SEC) + 1);
      const bucketsPerPx = 1 / (BUCKET_SEC * this.pxPerSec);

      ctx.fillStyle = c.wave || '#4E6C8A';
      if (bucketsPerPx <= 1) {
        // Weit gezoomt: ein Balken je Bucket
        const barW = Math.max(1, BUCKET_SEC * this.pxPerSec - 1);
        for (let i = startIdx; i < endIdx; i++) {
          const v = (this.peaks[i] || 0) / 255;
          const x = this.timeToX(i * BUCKET_SEC);
          const bh = Math.max(1, v * (laneH / 2 - 6));
          ctx.fillRect(x, mid - bh, barW, bh * 2);
        }
      } else {
        // Herausgezoomt: je Pixel den Spitzenwert
        for (let px = 0; px < w; px++) {
          const from = Math.floor((this.scrollT + px / this.pxPerSec) / BUCKET_SEC);
          const to = Math.floor((this.scrollT + (px + 1) / this.pxPerSec) / BUCKET_SEC);
          let peak = 0;
          for (let i = from; i <= to && i < this.peaks.length; i++) {
            if (this.peaks[i] > peak) peak = this.peaks[i];
          }
          if (!peak) continue;
          const bh = Math.max(1, (peak / 255) * (laneH / 2 - 6));
          ctx.fillRect(px, mid - bh, 1, bh * 2);
        }
      }

      // Mittellinie
      ctx.strokeStyle = c.line || '#2A3542';
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();

      this._drawHandles(laneTop, h);
      this._drawPlayhead(h);
      this._drawHover(h);
    }

    _drawSegmentBands(laneTop, laneH) {
      const ctx = this.ctx;
      this.sections.filter((x) => x.start != null).forEach((x) => {
        const end = x.end != null ? x.end : this.duration;
        const x1 = this.timeToX(x.start);
        const x2 = this.timeToX(end);
        if (x2 < 0 || x1 > this.width) return;
        const selected = this.selectedSegment && this.selectedSegment.markerId === x.id;
        ctx.fillStyle = `hsla(${hueOf(x)}, 60%, 55%, ${selected ? 0.3 : 0.15})`;
        ctx.fillRect(x1, laneTop, x2 - x1, laneH);
      });
    }

    _drawRuler() {
      const ctx = this.ctx;
      const c = this.colors;
      ctx.fillStyle = c.ruler || '#101720';
      ctx.fillRect(0, 0, this.width, RULER_H);
      ctx.strokeStyle = c.line || '#2A3542';
      ctx.beginPath();
      ctx.moveTo(0, RULER_H + 0.5);
      ctx.lineTo(this.width, RULER_H + 0.5);
      ctx.stroke();

      const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
      const step = candidates.find((s) => s * this.pxPerSec >= 70) || 3600;
      const first = Math.floor(this.scrollT / step) * step;

      ctx.font = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';
      ctx.textBaseline = 'middle';
      for (let t = first; t <= this.scrollT + this.viewSeconds; t += step) {
        const x = this.timeToX(t);
        if (x < -40 || x > this.width + 40) continue;
        ctx.strokeStyle = c.line || '#2A3542';
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H - 6);
        ctx.lineTo(Math.round(x) + 0.5, RULER_H);
        ctx.stroke();
        ctx.fillStyle = c.muted || '#7D8CA0';
        ctx.fillText(fmt(t), x + 4, RULER_H / 2);
      }
    }

    /** Zeichnet je Abschnitt eine Anfangs- und eine Endmarke in dessen Farbe. */
    _drawHandles(laneTop, h) {
      const ctx = this.ctx;
      const c = this.colors;
      const placed = this.sections.filter((x) => x.start != null).sort((a, b) => a.start - b.start);

      ctx.font = '12px system-ui, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';

      const flag = (section, edge, t, text, rightSide) => {
        const x = this.timeToX(t);
        if (x < -240 || x > this.width + 240) return;
        const color = `hsl(${hueOf(section)}, 55%, 62%)`;
        const active = this.dragging && this.dragging.id === section.id && this.dragging.edge === edge;

        ctx.strokeStyle = color;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
        ctx.lineWidth = 1;

        // Fähnchen: Anfang steht rechts der Linie, Ende links davon.
        const tw = Math.min(220, ctx.measureText(text).width + 16);
        const fx = rightSide ? x : x - tw;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(fx, RULER_H + 3, tw, FLAG_H - 6, 3);
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.rect(fx, RULER_H + 3, tw, FLAG_H - 6);
        ctx.clip();
        ctx.fillStyle = c.flagText || '#0E1318';
        ctx.fillText(text, fx + 8, RULER_H + FLAG_H / 2);
        ctx.restore();

        this._hit.push({ id: section.id, edge, flag: [fx, fx + tw], x });
      };

      placed.forEach((x) => {
        flag(x, 'start', x.start, x.label || 'Abschnitt', true);
        if (x.end != null) flag(x, 'end', x.end, 'Ende', false);
      });
    }

    _drawPlayhead(h) {
      const ctx = this.ctx;
      const line = (t, color) => {
        const x = this.timeToX(t);
        if (x < 0 || x > this.width) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
        ctx.lineWidth = 1;
      };
      // Während der Aufnahme markiert die rote Linie das Live-Ende,
      // die helle Linie ist der Hörcursor.
      if (this.recording) line(this.duration, this.colors.tally || '#FF3B30');
      if (this.playhead != null) line(this.playhead, this.colors.text || '#E6EBF0');
    }

    _drawHover(h) {
      if (this.hoverTime == null) return;
      const ctx = this.ctx;
      const x = this.timeToX(this.hoverTime);
      ctx.strokeStyle = this.colors.hover || 'rgba(255,255,255,0.18)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_H);
      ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* ---------------------------------------------------------- Interaktion */

    /** Findet den Griff (Anfang/Ende eines Abschnitts) unter dem Zeiger. */
    _handleAt(x, y) {
      if (y < RULER_H) return null;
      // Fähnchen zuerst (größere Trefferfläche), von hinten, damit das oberste gewinnt.
      if (y <= RULER_H + FLAG_H) {
        for (let i = this._hit.length - 1; i >= 0; i--) {
          const hit = this._hit[i];
          if (x >= hit.flag[0] - 2 && x <= hit.flag[1] + 2) return hit;
        }
      }
      for (let i = this._hit.length - 1; i >= 0; i--) {
        if (Math.abs(this._hit[i].x - x) <= 6) return this._hit[i];
      }
      return null;
    }

    _pos(event) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    _bind() {
      const cv = this.canvas;

      cv.addEventListener('pointerdown', (e) => {
        const { x, y } = this._pos(e);
        const handle = this._handleAt(x, y);
        if (handle) {
          this.dragging = { id: handle.id, edge: handle.edge, offset: x - handle.x };
          cv.setPointerCapture(e.pointerId);
          this.onSelectSection(handle.id);
          this.draw();
        } else if (y > RULER_H) {
          const t = Math.max(0, Math.min(this.duration, this.xToTime(x)));
          this.onSeek(t);
        } else {
          this._panning = { startX: x, startScroll: this.scrollT };
          cv.setPointerCapture(e.pointerId);
        }
      });

      cv.addEventListener('pointermove', (e) => {
        const { x, y } = this._pos(e);
        if (this.dragging) {
          const { id, edge } = this.dragging;
          const sec = this.sections.find((ss) => ss.id === id);
          if (sec) {
            let t = Math.max(0, Math.min(this.duration, this.xToTime(x - this.dragging.offset)));
            if (edge === 'start' && sec.end != null) t = Math.min(t, sec.end - MIN_SECTION);
            if (edge === 'end') t = Math.max(t, sec.start + MIN_SECTION);
            sec[edge] = t;
            this.onEdgeMove(id, edge, t);
          }
          this.draw();
          return;
        }
        if (this._panning) {
          this.scrollT = this._panning.startScroll - (x - this._panning.startX) / this.pxPerSec;
          this.follow = false;
          this.clampScroll();
          this.draw();
          return;
        }
        this.hoverTime = this.xToTime(x);
        cv.style.cursor = this._handleAt(x, y) ? 'ew-resize' : (y < RULER_H ? 'grab' : 'pointer');
        this.draw();
      });

      const endDrag = (e) => {
        if (this.dragging) {
          const { id, edge } = this.dragging;
          const sec = this.sections.find((ss) => ss.id === id);
          if (sec) this.onEdgeMoveEnd(id, edge, sec[edge]);
          this.dragging = null;
          this.draw();
        }
        this._panning = null;
        try { cv.releasePointerCapture(e.pointerId); } catch { /* schon freigegeben */ }
      };
      cv.addEventListener('pointerup', endDrag);
      cv.addEventListener('pointercancel', endDrag);

      cv.addEventListener('dblclick', (e) => {
        const { x, y } = this._pos(e);
        const handle = this._handleAt(x, y);
        if (handle) this.onRenameSection(handle.id);
      });

      cv.addEventListener('pointerleave', () => {
        this.hoverTime = null;
        this.draw();
      });

      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const { x } = this._pos(e);
        if (e.ctrlKey || e.shiftKey) {
          const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
          this.setZoom(this.pxPerSec * factor, this.xToTime(x));
        } else {
          this.scrollT += (e.deltaY + e.deltaX) / this.pxPerSec;
          this.follow = false;
          this.clampScroll();
          this.draw();
        }
      }, { passive: false });

      cv.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this.hoverTime = this.xToTime(this._pos(e).x);
        this.draw();
      });

      cv.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/marker-id');
        if (!id) return;
        const t = Math.max(0, Math.min(this.duration, this.xToTime(this._pos(e).x)));
        this.onDropPending(id, t);
      });

      window.addEventListener('resize', () => this.resize());
    }
  }

  window.Waveform = Waveform;
  window.sectionHue = hueOf;
  window.formatTime = fmt;
})();
