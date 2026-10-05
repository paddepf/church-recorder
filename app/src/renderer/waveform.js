/* Wellenform-Ansicht: zeichnet die laufende Aufnahme und die Marker,
   erlaubt Verschieben der Marker und Ablegen offener Ablaufplan-Punkte. */

(function () {
  'use strict';

  const BUCKET_SEC = 0.05;   // Auflösung der Peak-Daten (muss zu session.js passen)
  const RULER_H = 22;
  const FLAG_H = 26;

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
      this.markers = [];
      this.pxPerSec = opts.pxPerSec || 12;
      this.scrollT = 0;
      this.playhead = 0;
      this.follow = true;
      this.recording = false;
      this.selectedSegment = null;
      this.hoverTime = null;
      this.dragging = null;
      this.colors = opts.colors || {};

      this.onMarkerMove = opts.onMarkerMove || (() => {});
      this.onMarkerMoveEnd = opts.onMarkerMoveEnd || (() => {});
      this.onSeek = opts.onSeek || (() => {});
      this.onSelectMarker = opts.onSelectMarker || (() => {});
      this.onDropPending = opts.onDropPending || (() => {});

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

    update({ peaks, duration, markers, playhead, recording, selectedSegment }) {
      if (peaks) this.peaks = peaks;
      if (duration != null) this.duration = duration;
      if (markers) this.markers = markers;
      if (playhead != null) this.playhead = playhead;
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

      this._drawMarkers(laneTop, h);
      this._drawPlayhead(h);
      this._drawHover(h);
    }

    _drawSegmentBands(laneTop, laneH) {
      const ctx = this.ctx;
      const placed = this.markers.filter((m) => m.placed).sort((a, b) => a.time - b.time);
      placed.forEach((m, i) => {
        const start = m.time;
        const end = i + 1 < placed.length ? placed[i + 1].time : this.duration;
        const x1 = this.timeToX(start);
        const x2 = this.timeToX(end);
        if (x2 < 0 || x1 > this.width) return;
        const isSelected = this.selectedSegment && this.selectedSegment.markerId === m.id;
        ctx.fillStyle = isSelected
          ? (this.colors.selection || 'rgba(108,124,224,0.22)')
          : (i % 2 === 0 ? (this.colors.stripe || 'rgba(255,255,255,0.022)') : 'transparent');
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

    _drawMarkers(laneTop, h) {
      const ctx = this.ctx;
      const c = this.colors;
      const placed = this.markers.filter((m) => m.placed).sort((a, b) => a.time - b.time);

      ctx.font = '12px system-ui, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';

      placed.forEach((m) => {
        const x = this.timeToX(m.time);
        if (x < -200 || x > this.width + 200) return;
        const color = m.source === 'churchtools'
          ? (c.plan || '#6C7CE0')
          : (c.manual || '#2BB3A3');
        const active = this.dragging && this.dragging.id === m.id;

        ctx.strokeStyle = color;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
        ctx.lineWidth = 1;

        // Fähnchen mit Beschriftung
        const label = m.label || 'Marker';
        const tw = Math.min(220, ctx.measureText(label).width + 16);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, RULER_H + 3, tw, FLAG_H - 6, 3);
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, RULER_H + 3, tw, FLAG_H - 6);
        ctx.clip();
        ctx.fillStyle = c.flagText || '#0E1318';
        ctx.fillText(label, x + 8, RULER_H + FLAG_H / 2);
        ctx.restore();
      });
    }

    _drawPlayhead(h) {
      const x = this.timeToX(this.playhead);
      if (x < 0 || x > this.width) return;
      const ctx = this.ctx;
      ctx.strokeStyle = this.recording ? (this.colors.tally || '#FF3B30') : (this.colors.text || '#E6EBF0');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_H);
      ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
      ctx.lineWidth = 1;
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

    _markerAt(x, y) {
      if (y < RULER_H) return null;
      const tolerance = 6;
      const placed = this.markers.filter((m) => m.placed);
      // Fähnchen zuerst (größere Trefferfläche)
      for (const m of placed) {
        const mx = this.timeToX(m.time);
        if (y >= RULER_H && y <= RULER_H + FLAG_H && x >= mx - 2 && x <= mx + 220) return m;
      }
      for (const m of placed) {
        if (Math.abs(this.timeToX(m.time) - x) <= tolerance) return m;
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
        const marker = this._markerAt(x, y);
        if (marker) {
          this.dragging = { id: marker.id, offset: x - this.timeToX(marker.time) };
          cv.setPointerCapture(e.pointerId);
          this.onSelectMarker(marker.id);
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
          const t = Math.max(0, Math.min(this.duration, this.xToTime(x - this.dragging.offset)));
          const m = this.markers.find((mm) => mm.id === this.dragging.id);
          if (m) m.time = t;
          this.onMarkerMove(this.dragging.id, t);
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
        cv.style.cursor = this._markerAt(x, y) ? 'ew-resize' : (y < RULER_H ? 'grab' : 'pointer');
        this.draw();
      });

      const endDrag = (e) => {
        if (this.dragging) {
          const m = this.markers.find((mm) => mm.id === this.dragging.id);
          this.onMarkerMoveEnd(this.dragging.id, m ? m.time : 0);
          this.dragging = null;
          this.draw();
        }
        this._panning = null;
        try { cv.releasePointerCapture(e.pointerId); } catch { /* schon freigegeben */ }
      };
      cv.addEventListener('pointerup', endDrag);
      cv.addEventListener('pointercancel', endDrag);

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
  window.formatTime = fmt;
})();
