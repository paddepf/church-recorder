/* Wellenform-Ansicht: zeichnet die laufende Aufnahme und die Abschnitte
   (je eine Anfangs- und Endmarke), erlaubt Verschieben der Marken und
   Ablegen offener Ablaufplan-Punkte. */

(function () {
  'use strict';

  const BUCKET_SEC = 0.05;   // Auflösung der Peak-Daten (muss zu session.js passen)
  const RULER_H = 22;
  const FLAG_H = 26;
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
      this.cuts = [];             // Schnitte: {id,start,end|null}, beim MP3-Export ausgelassen
      this.pendingCut = null;     // Schnitt, der gerade mit Umschalt+Ziehen aufgezogen wird
      this.draggingCut = null;
      this._hit = [];             // Trefferflächen der Griffe, beim Zeichnen gefüllt
      this.hoverHandle = null;    // Start-Fähnchen unter dem Zeiger
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
      this.onFollowChange = opts.onFollowChange || (() => {});
      this.onCutAdd = opts.onCutAdd || (() => {});
      this.onCutMoveEnd = opts.onCutMoveEnd || (() => {});
      this.onCutRemove = opts.onCutRemove || (() => {});

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
      this.onFollowChange(false);
      this.clampScroll();
      this.draw();
    }

    update({ peaks, duration, sections, cuts, playhead, recording, selectedSegment }) {
      if (peaks) this.peaks = peaks;
      if (duration != null) this.duration = duration;
      if (sections) this.sections = sections;
      if (cuts) this.cuts = cuts;
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

      this._drawCuts(laneTop, h);
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

      ctx.font = '11px system-ui, "Segoe UI", Roboto, sans-serif';
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

    /** Schnitte: schraffierte rote Flächen mit Rand; offene reichen bis zum Live-Ende. */
    _drawCuts(laneTop, h) {
      const ctx = this.ctx;
      const rgb = this.colors.cut || '255,59,48';
      if (!this._cutPattern || this._cutPatternRgb !== rgb) {
        this._cutPatternRgb = rgb;
        const tile = document.createElement('canvas');
        tile.width = 8;
        tile.height = 8;
        const t = tile.getContext('2d');
        t.strokeStyle = `rgba(${rgb},0.55)`;
        t.lineWidth = 1.5;
        t.beginPath();
        t.moveTo(-2, 10);
        t.lineTo(10, -2);
        t.stroke();
        this._cutPattern = ctx.createPattern(tile, 'repeat');
      }
      const all = [...this.cuts];
      if (this.pendingCut) all.push({ id: null, start: this.pendingCut.start, end: this.pendingCut.end });
      all.forEach((cut) => {
        const end = cut.end != null ? cut.end : this.duration;
        const x1 = this.timeToX(cut.start);
        const x2 = this.timeToX(end);
        if (x2 < 0 || x1 > this.width) return;
        const w = Math.max(2, x2 - x1);
        ctx.fillStyle = `rgba(${rgb},0.14)`;
        ctx.fillRect(x1, laneTop, w, h - laneTop);
        ctx.fillStyle = this._cutPattern;
        ctx.fillRect(x1, laneTop, w, h - laneTop);
        ctx.strokeStyle = `rgba(${rgb},0.9)`;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1) + 0.5, laneTop);
        ctx.lineTo(Math.round(x1) + 0.5, h);
        if (cut.end != null) {
          ctx.moveTo(Math.round(x2) + 0.5, laneTop);
          ctx.lineTo(Math.round(x2) + 0.5, h);
        }
        ctx.stroke();
        if (w > 44) {
          ctx.font = '12px system-ui, "Segoe UI", sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = this.colors.cutText || '#FF8A80';
          ctx.fillText('✂ Schnitt', x1 + 6, laneTop + 12);
        }
      });
    }

    /** Findet den Rand eines Schnitts unter dem Zeiger (nur in der Wellenform-Fläche). */
    _cutEdgeAt(x, y) {
      if (y <= RULER_H + FLAG_H) return null;
      for (const cut of this.cuts) {
        if (Math.abs(this.timeToX(cut.start) - x) <= 6) return { id: cut.id, edge: 'start' };
        if (cut.end != null && Math.abs(this.timeToX(cut.end) - x) <= 6) return { id: cut.id, edge: 'end' };
      }
      return null;
    }

    _cutAt(x, y) {
      if (y <= RULER_H + FLAG_H) return null;
      const t = this.xToTime(x);
      return this.cuts.find((c) => t >= c.start && t <= (c.end != null ? c.end : this.duration)) || null;
    }

    /** Kürzt einen Text mit "…" auf die verfügbare Breite. */
    _fitText(text, maxW) {
      const ctx = this.ctx;
      if (maxW <= 0 || !text) return '';
      if (ctx.measureText(text).width <= maxW) return text;
      const ell = '…';
      const ellW = ctx.measureText(ell).width;
      if (maxW < ellW) return '';
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(text.slice(0, mid)).width + ellW <= maxW) lo = mid; else hi = mid - 1;
      }
      return lo > 0 ? text.slice(0, lo).trimEnd() + ell : ell;
    }

    /** Zeichnet je Abschnitt eine Anfangs- und eine Endmarke in dessen Farbe. */
    _drawHandles(laneTop, h) {
      const ctx = this.ctx;
      const c = this.colors;
      const placed = this.sections.filter((x) => x.start != null).sort((a, b) => a.start - b.start);

      ctx.font = '12px system-ui, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';

      const PAD = 8;            // Innenabstand im Fähnchen
      const TAB = 10;           // Breite eines Fähnchens ohne Text
      const MAX_START = 360;
      const endLabel = 'Ende';
      const endFull = ctx.measureText(endLabel).width + PAD * 2;
      const hintText = '  ·  + Interpret';

      /** Linie und Fähnchen; parts = [{ text, alpha }] sind bereits auf die Breite gekürzt. */
      const drawFlag = (section, edge, x, w, rightSide, parts) => {
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
        const fx = rightSide ? x : x - w;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(fx, RULER_H + 3, w, FLAG_H - 6, 3);
        ctx.fill();

        ctx.save();
        ctx.beginPath();
        ctx.rect(fx, RULER_H + 3, w, FLAG_H - 6);
        ctx.clip();
        ctx.fillStyle = c.flagText || '#0E1318';
        let tx = fx + PAD;
        parts.forEach((part) => {
          if (!part.text) return;
          ctx.globalAlpha = part.alpha;
          ctx.fillText(part.text, tx, RULER_H + FLAG_H / 2);
          tx += ctx.measureText(part.text).width;
        });
        ctx.restore();
        return fx;
      };

      placed.forEach((sec) => {
        const sx = this.timeToX(sec.start);
        const ex = sec.end != null ? this.timeToX(sec.end) : null;
        if ((ex ?? sx) < -400 || sx > this.width + 400) return;

        const hovered = this.hoverHandle && this.hoverHandle.id === sec.id && this.hoverHandle.edge === 'start';
        const name = sec.label || 'Abschnitt';
        const extra = sec.artist ? '  ·  ' + sec.artist : (hovered ? hintText : '');
        const nameW = ctx.measureText(name).width;
        const wantStart = Math.min(MAX_START, nameW + (extra ? ctx.measureText(extra).width : 0) + PAD * 2);

        // Breiten verteilen: Passen beide Fähnchen nicht in den Abschnitt, wird zuerst das
        // Anfangs-Fähnchen gekürzt, dann das Ende-Fähnchen auf eine Lasche ohne Text.
        let startW = wantStart;
        let endW = endFull;
        if (ex != null) {
          const room = Math.max(0, ex - sx - 2);
          if (wantStart + endW > room) {
            startW = room - endW;
            if (startW < 40) {
              endW = Math.min(TAB, room);
              startW = Math.max(0, room - endW);
            }
          }
        }
        const startMax = startW;

        // Anfangs-Fähnchen: Name, dahinter (heller) der Interpret
        const inner = startW - PAD * 2;
        const nameFit = startW >= 24 ? this._fitText(name, inner) : '';
        const nameFitW = nameFit ? ctx.measureText(nameFit).width : 0;
        // Der Interpret erscheint nur, wenn genug Platz bleibt (sonst stünde dort nur "Ge…").
        const extraRoom = inner - nameFitW;
        const extraFit = nameFit && extra && extraRoom >= 60 ? this._fitText(extra, extraRoom) : '';
        const startDrawW = Math.max(TAB, Math.min(startW, nameFitW + (extraFit ? ctx.measureText(extraFit).width : 0) + PAD * 2));
        const fx = drawFlag(sec, 'start', sx, startW >= TAB ? startDrawW : TAB, true, [
          { text: nameFit, alpha: 1 },
          { text: extraFit, alpha: sec.artist ? 0.72 : 0.5 }
        ]);

        // Trefferfläche: ohne Interpret bleibt Platz für den Hinweis, damit er beim Darüberfahren
        // nicht flackert und der Doppelklick darauf das Interpret-Feld öffnet.
        const hintW = sec.artist ? 0 : ctx.measureText(hintText).width;
        const hitW = Math.min(Math.max(startDrawW, nameFitW + hintW + PAD * 2), Math.max(startMax, TAB));
        this._hit.push({ id: sec.id, edge: 'start', flag: [fx, fx + hitW], x: sx, artistX: fx + PAD + nameFitW });

        // Ende-Fähnchen
        if (ex != null) {
          const label = endW >= endFull ? endLabel : '';
          const efx = drawFlag(sec, 'end', ex, endW, false, [{ text: label, alpha: 1 }]);
          this._hit.push({ id: sec.id, edge: 'end', flag: [efx, efx + endW], x: ex, artistX: null });
        }
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
        const cutEdge = !(handle && y <= RULER_H + FLAG_H) ? this._cutEdgeAt(x, y) : null;
        if (cutEdge) {
          this.draggingCut = cutEdge;
          cv.setPointerCapture(e.pointerId);
        } else if (e.shiftKey && !handle && y > RULER_H) {
          // Umschalt + Ziehen: Schnitt aufziehen
          const t = Math.max(0, Math.min(this.duration, this.xToTime(x)));
          this.pendingCut = { start: t, end: t, anchor: t };
          cv.setPointerCapture(e.pointerId);
        } else if (handle) {
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
        if (this.draggingCut) {
          const cut = this.cuts.find((c) => c.id === this.draggingCut.id);
          if (cut) {
            const t = Math.max(0, Math.min(this.duration, this.xToTime(x)));
            if (this.draggingCut.edge === 'start') cut.start = Math.min(t, (cut.end != null ? cut.end : this.duration) - 0.2);
            else cut.end = Math.max(t, cut.start + 0.2);
          }
          this.draw();
          return;
        }
        if (this.pendingCut) {
          const t = Math.max(0, Math.min(this.duration, this.xToTime(x)));
          this.pendingCut.start = Math.min(this.pendingCut.anchor, t);
          this.pendingCut.end = Math.max(this.pendingCut.anchor, t);
          this.draw();
          return;
        }
        if (this.dragging) {
          const { id, edge } = this.dragging;
          const sec = this.sections.find((ss) => ss.id === id);
          if (sec) {
            // Gleiche Regel wie im Hauptprozess: Nachbarn weichen aus, nichts überlappt.
            const raw = Math.max(0, Math.min(this.duration, this.xToTime(x - this.dragging.offset)));
            const r = window.SectionLogic.moveEdge(this.sections, id, edge, raw, this.duration);
            if (r) this.onEdgeMove(id, edge, r.time);
          }
          this.draw();
          return;
        }
        if (this._panning) {
          this.scrollT = this._panning.startScroll - (x - this._panning.startX) / this.pxPerSec;
          this.follow = false;
          this.onFollowChange(false);
          this.clampScroll();
          this.draw();
          return;
        }
        this.hoverTime = this.xToTime(x);
        const over = this._handleAt(x, y);
        const hover = over && over.edge === 'start' ? { id: over.id, edge: 'start' } : null;
        if ((hover && hover.id) !== (this.hoverHandle && this.hoverHandle.id)) this.hoverHandle = hover;
        cv.style.cursor = this._handleAt(x, y) || this._cutEdgeAt(x, y) ? 'ew-resize' : (y < RULER_H ? 'grab' : (e.shiftKey ? 'crosshair' : 'pointer'));
        this.draw();
      });

      const endDrag = (e) => {
        if (this.draggingCut) {
          const cut = this.cuts.find((c) => c.id === this.draggingCut.id);
          if (cut) this.onCutMoveEnd(cut.id, this.draggingCut.edge, cut[this.draggingCut.edge]);
          this.draggingCut = null;
          this.draw();
        }
        if (this.pendingCut) {
          const { start, end } = this.pendingCut;
          this.pendingCut = null;
          if (end - start >= 0.2) this.onCutAdd(start, end);
          this.draw();
        }
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
        if (!handle && !this._cutEdgeAt(x, y)) {
          const cut = this._cutAt(x, y);
          if (cut) { this.onCutRemove(cut.id); return; }
        }
        // Doppelklick auf den Interpreten (oder den Hinweis) springt direkt in dieses Feld.
        if (handle) {
          const focus = handle.artistX != null && x >= handle.artistX ? 'artist' : 'name';
          // Rechteck des Fähnchens (Zeichenfläche), damit der Editor genau darüber erscheint.
          this.onRenameSection(handle.id, focus, {
            x: handle.flag[0], y: RULER_H + 3, w: Math.max(10, handle.flag[1] - handle.flag[0]), h: FLAG_H - 6
          });
        }
      });

      cv.addEventListener('pointerleave', () => {
        this.hoverTime = null;
        this.hoverHandle = null;
        this.draw();
      });

      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const { x } = this._pos(e);
        if (e.ctrlKey || e.shiftKey) {
          // Umschalt+Mausrad liefert auf dem Mac deltaX statt deltaY
          const delta = e.deltaY || e.deltaX;
          const factor = delta < 0 ? 1.2 : 1 / 1.2;
          this.setZoom(this.pxPerSec * factor, this.xToTime(x));
        } else {
          this.scrollT += (e.deltaY + e.deltaX) / this.pxPerSec;
          this.follow = false;
          this.onFollowChange(false);
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
      // Wird das Fenster auf einen Monitor mit anderer Pixeldichte gezogen, neu aufbauen (sonst unscharf).
      const watchDpr = () => {
        const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        mq.addEventListener('change', () => { this.resize(); watchDpr(); }, { once: true });
      };
      watchDpr();
    }
  }

  window.Waveform = Waveform;
  window.sectionHue = hueOf;
  window.formatTime = fmt;
})();
