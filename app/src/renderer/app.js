/* ChurchRecorder – Oberflächenlogik */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = window.formatTime;

  const state = {
    settings: null,
    session: null,
    peaks: [],
    duration: 0,
    selectedSectionId: null,
    selectedSegmentId: null,
    exportChecked: new Set(),   // zum Export angehakte Segment-IDs
    exportSeen: new Set(),      // schon einmal angezeigte Segment-IDs (für die Vorauswahl)
    playing: false,
    starting: false,
    bucketAcc: 0,
    bucketFrames: 0,
    sampleRate: 48000,
    cursorT: null,           // Hörcursor während der Aufnahme
    lastChunkAt: 0,          // Zeitpunkt des letzten Audioblocks vom Eingang
    chunkSeq: 0,
    recovering: false
  };

  const capture = new window.Capture();
  let wave = null;
  const monitor = new window.Monitor({
    read: (start, seconds) => window.api.record.readAudio(start, seconds),
    isLive: () => state.session?.status === 'recording',
    onPosition: (t) => {
      state.cursorT = t;
      wave.update({ playhead: t });
    },
    onStateChange: () => updatePlayButton()
  });

  /* ------------------------------------------------------------- Hilfsmittel */

  function toast(level, message, timeout = 6000) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.level = level;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), timeout);
  }

  function fileUrl(p) {
    // Windows liefert "C:\Ordner\datei.wav", macOS und Linux "/Ordner/datei.wav".
    // Beide müssen zu genau drei Schrägstrichen nach "file:" führen.
    const normalized = String(p).replace(/\\/g, '/').replace(/^\/+/, '');
    return encodeURI('file:///' + normalized).replace(/#/g, '%23');
  }

  function longTime(t) {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(h)}:${p(m)}:${p(s)}`;
  }

  /* ------------------------------------------------------------------ Start */

  async function init() {
    const info = await window.api.app.info();
    const cfg = await window.api.settings.get();
    state.settings = cfg.settings;
    state.sampleRate = state.settings.sampleRate || 48000;
    applyTheme(state.settings.theme);

    wave = new window.Waveform($('wave'), {
      colors: readColors(),
      onEdgeMove: () => renderLists(),
      onEdgeMoveEnd: async (id, edge, time) => {
        await window.api.section.moveEdge(id, edge, time);
      },
      onSeek: (t) => setPlayhead(t, true),
      onCutAdd: async (start, end) => {
        const res = await window.api.cut.add(start, end);
        if (!res.ok) toast('warn', res.error);
      },
      onCutMoveEnd: async (id, edge, time) => { await window.api.cut.moveEdge(id, edge, time); },
      onCutRemove: async (id) => {
        await window.api.cut.remove(id);
        toast('info', 'Schnitt entfernt.', 2500);
      },
      onRenameSection: (id, focus, r) => {
        const cv = $('wave').getBoundingClientRect();
        editSection(id, focus, { left: cv.left + r.x, top: cv.top + r.y, width: r.w, height: r.h });
      },
      onSelectSection: (id) => {
        state.selectedSectionId = id;
        renderLists();
      },
      onDropPending: async (id, time) => {
        const res = await window.api.section.place(id, time);
        if (!res.ok) toast('error', res.error);
      }
    });

    setDefaultZoom();
    bindUi();
    bindEvents();
    renderShortcuts(info.platform);
    refreshDisk();
    setInterval(refreshDisk, 30000);
    await refreshDevices();
    applySettingsToForm();
    await updateBadges(info);
    $('version-info').textContent = `Version ${info.version}`;

    const st = await window.api.session.state();
    if (st.ok) {
      applyState(st.state, st.peaks);
      if (st.state.status === 'stopped') fitZoom();
    }

    await checkRecovery();

    if (state.settings.autoLoadTodaysService && state.settings.churchToolsUrl && state.settings.churchToolsTokenSet) {
      loadServicesForDate(localIsoDate(), true);
    }
  }

  async function updateBadges(info) {
    const net = await window.api.net.status();
    if (net.ok) {
      $('net-badge').dataset.on = net.running ? 'true' : 'false';
      $('net-badge').textContent = net.running
        ? `Netzwerk · Port ${net.port} · ${net.clients}`
        : 'Netzwerk aus';
      $('net-info').textContent = net.running
        ? `Läuft auf Port ${net.port}.`
        : (net.passwordSet ? 'Nicht aktiv.' : 'Kein Passwort gesetzt – die Schnittstelle bleibt aus.');
    }
  }

  /** Standardansicht der Wellenform: 5 Minuten sichtbar. */
  const DEFAULT_VISIBLE_SECONDS = 300;

  function setDefaultZoom() {
    wave.scrollT = 0;
    wave.setZoom(wave.width / DEFAULT_VISIBLE_SECONDS, 0);
  }

  /** Zeigt die gesamte Aufnahme auf einen Blick. */
  function fitZoom() {
    const d = state.session?.duration || 0;
    if (d <= 0) return;
    wave.scrollT = 0;
    wave.setZoom(($('wave').clientWidth - 8) / d, 0);
  }

  function readColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return {
      bg: v('--wave-bg'),
      ruler: v('--ruler-bg'),
      flagText: v('--wave-flag-text'),
      stripe: v('--wave-stripe'),
      hover: v('--wave-hover'),
      line: v('--line'),
      wave: v('--wave'),
      muted: v('--muted'),
      text: v('--text'),
      plan: v('--plan'),
      manual: v('--manual'),
      tally: v('--tally'),
      selection: v('--wave-selection')
    };
  }

  const themeQuery = window.matchMedia('(prefers-color-scheme: light)');

  /** Setzt das Farbschema ('dark' | 'light' | 'system') und färbt die Wellenform neu ein. */
  function applyTheme(mode) {
    const light = mode === 'light' || (mode === 'system' && themeQuery.matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    if (wave) {
      wave.colors = readColors();
      wave.draw();
    }
  }
  themeQuery.addEventListener('change', () => applyTheme(state.settings?.theme));

  /* ------------------------------------------------------------- Zustandsbild */

  function applyState(session, peaks) {
    const wasRecording = state.session?.status === 'recording';
    state.session = session;
    if (wasRecording && session.status === 'paused' && !peaks) resyncPeaks();
    if (peaks) {
      state.peaks = peaks;
      wave.peaks = state.peaks;
    }
    state.duration = session.duration || 0;

    document.body.dataset.status = session.status;
    $('service-name').textContent = session.service?.name || 'Kein Gottesdienst gewählt';
    $('service-date').textContent = session.service?.date || '';

    const rec = session.status === 'recording';
    const paused = session.status === 'paused';
    const stopped = session.status === 'stopped';

    $('record-label').textContent = rec ? 'Aufnahme läuft' : (paused ? 'Fortsetzen' : 'Neue Aufnahme starten');
    $('btn-record').disabled = rec || state.starting;
    $('btn-continue').hidden = !(stopped && session.wavPath);
    $('btn-continue').disabled = state.starting;
    $('btn-pause').disabled = !(rec || paused);
    $('btn-pause').textContent = paused ? 'Fortsetzen' : 'Pause';
    $('btn-stop').disabled = !(rec || paused);
    $('btn-marker').disabled = !(rec || paused);
    $('btn-marker').textContent = session.currentSegment ? 'Abschnitt beenden' : 'Abschnitt starten';
    $('btn-next-item').disabled = !(rec || paused) || ((session.pending || []).length === 0 && !session.currentSegment);
    $('btn-play').disabled = !((stopped && session.wavPath) || rec || paused);
    updatePlayButton();

    if (stopped && session.wavPath) {
      const url = fileUrl(session.wavPath);
      if ($('player').getAttribute('src') !== url) $('player').setAttribute('src', url);
    }

    $('current-item').textContent = rec || paused
      ? (session.currentSegment?.label || 'Kein Abschnitt')
      : (stopped ? 'Aufnahme beendet' : 'Bereit');

    if (!rec) $('timecode').textContent = longTime(session.duration || 0);

    wave.update({
      duration: session.duration || 0,
      sections: (session.sections || []).map((x) => ({ ...x })),
      cuts: (session.cuts || []).map((c) => ({ ...c })),
      recording: rec,
      selectedSegment: session.segments?.find((s) => s.id === state.selectedSegmentId) || null
    });

    renderLists();
    renderSegments();
  }

  /** Gleicht die lokal mitgerechnete Wellenform mit der tatsächlich geschriebenen Datei ab. */
  async function resyncPeaks() {
    const full = await window.api.session.state();
    if (!full.ok || state.session?.status === 'recording') return;
    state.peaks = full.peaks || [];
    wave.peaks = state.peaks;
    state.bucketAcc = 0;
    state.bucketFrames = 0;
    wave.draw();
  }

  /* --------------------------------------------------------------- Aufnahme */

  async function startRecording() {
    if (state.starting) return;
    if (state.session && (state.session.status === 'recording' || state.session.status === 'paused')) return;
    state.starting = true;

    try {
      // Eine angezeigte, beendete Aufnahme würde sonst aus der Ansicht verschwinden.
      if (state.session?.status === 'stopped' && state.session.wavPath) {
        const sections = (state.session.sections || []).filter((x) => x.start != null).length;
        const go = await confirmDialog(
          'Neue Aufnahme starten?',
          `Die angezeigte Aufnahme (${longTime(state.session.duration || 0)}, ${sections} Abschnitte) ist als Datei gespeichert ` +
          'und lässt sich über „Aufnahmen" jederzeit wieder öffnen. Die neue Aufnahme beginnt mit leerer Wellenform, ' +
          'die gesetzten Abschnitte werden zurückgesetzt. Noch nicht exportierte MP3-Abschnitte bitte vorher speichern.',
          'Neue Aufnahme starten'
        );
        if (!go) return;
      }

      $('btn-record').disabled = true;
      refreshDisk().then((hours) => {
        if (hours != null && hours < DISK_WARN_HOURS) {
          toast('warn', `Wenig Speicherplatz: nur noch für ca. ${formatHours(hours)} Aufnahme.`, 12000);
        }
      });
      const result = await capture.start(state.settings.inputDeviceId, state.settings.sampleRate);
      state.sampleRate = result.sampleRate;
      state.lastChunkAt = Date.now();

      const rec = await window.api.record.start({ sampleRate: result.sampleRate, channels: 2 });
      if (!rec.ok) {
        await capture.stop();
        toast('error', rec.error || 'Die Aufnahme konnte nicht gestartet werden.');
        return;
      }

      state.peaks = [];
      state.bucketAcc = 0;
      state.bucketFrames = 0;
      wave.peaks = state.peaks;
      setDefaultZoom();
      wave.follow = true;
      $('chk-follow').checked = true;
      monitor.pause();
      state.cursorT = null;
      wave.update({ playhead: null });
      $('export-result').textContent = '';
      toast('success', `Aufnahme läuft – ${result.deviceLabel || 'Eingang'} bei ${Math.round(result.sampleRate / 1000)} kHz.`);
    } catch (err) {
      toast('error', err.message);
    } finally {
      state.starting = false;
      // Knopf nur sperren, solange tatsächlich aufgenommen wird (auch nach Abbruch oder Fehler wieder frei).
      const st = state.session?.status;
      $('btn-record').disabled = st === 'recording';
    }
  }

  /* ------------------------------------------------- Wächter für den Eingang */

  const WATCHDOG_MS = 2500;      // so lange darf der Eingang schweigen, bevor neu verbunden wird
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function showAudioWarning(on, text, kind = 'lost') {
    const el = $('audio-warning');
    el.hidden = !on;
    el.dataset.kind = kind;
    if (on && text) el.textContent = text;
  }

  /** Warnbalken für leise/stumme Eingänge, solange keine Wiederverbindung läuft. */
  function applyHealth(h) {
    state.health = h;
    if (state.recovering) return;
    if (h && h.input === 'silent' && state.session?.status === 'recording') {
      showAudioWarning(true, 'Seit über 20 Sekunden kaum Pegel – Mischpult oder Kabel prüfen?', 'silent');
    } else {
      showAudioWarning(false);
    }
  }

  /**
   * Der Audioeingang liefert nichts mehr (z. B. nach Ruhezustand oder wenn das Gerät
   * kurz weg war): Eingang neu öffnen und in dieselbe Datei weiterschreiben.
   */
  async function recoverCapture() {
    if (state.recovering) return;
    state.recovering = true;
    window.api.reportInputLost(true);
    const lostSince = state.lastChunkAt;
    showAudioWarning(true, 'Kein Audiosignal – der Eingang wird neu verbunden …', 'lost');
    toast('error', 'Der Audioeingang liefert keine Daten mehr – er wird neu verbunden.', 8000);
    try {
      while (state.session?.status === 'recording') {
        await Promise.race([capture.stop(), sleep(2000)]);
        try {
          const rate = state.session.sampleRate;
          const before = state.chunkSeq;
          const result = await capture.start(state.settings.inputDeviceId, rate);
          if (result.sampleRate !== rate) {
            await capture.stop();
            throw new Error(`Eingang läuft mit ${result.sampleRate} Hz statt ${rate} Hz.`);
          }
          await sleep(1500);
          if (state.session?.status !== 'recording') { await capture.stop(); return; }
          if (state.chunkSeq > before) {
            const lost = Math.round((Date.now() - lostSince) / 1000);
            toast('success', `Audioeingang wieder verbunden. Etwa ${lost} s fehlen in der Aufnahme.`, 10000);
            return;
          }
        } catch (err) {
          console.warn('Eingang neu verbinden fehlgeschlagen:', err);
        }
        await sleep(2000);
      }
    } finally {
      state.recovering = false;
      state.lastChunkAt = Date.now();
      window.api.reportInputLost(false);
      applyHealth(state.health);
    }
  }

  setInterval(() => {
    if (state.session?.status !== 'recording' || state.starting || state.recovering || !capture.running) return;
    if (Date.now() - state.lastChunkAt > WATCHDOG_MS) recoverCapture();
  }, 1000);

  /** Hängt eine neue Aufnahme an die beendete an (gleiche Datei, gleiche Abschnitte). */
  async function continueRecording() {
    if (state.starting || state.session?.status !== 'stopped') return;
    state.starting = true;
    $('btn-continue').disabled = true;
    try {
      const rate = state.session.sampleRate;
      const result = await capture.start(state.settings.inputDeviceId, rate);
      if (result.sampleRate !== rate) {
        await capture.stop();
        return toast('error', `Der Eingang läuft mit ${result.sampleRate} Hz, die Aufnahme hat ${rate} Hz – Fortsetzen nicht möglich.`);
      }
      state.sampleRate = result.sampleRate;
      state.lastChunkAt = Date.now();
      const res = await window.api.record.continue();
      if (!res.ok) {
        await capture.stop();
        return toast('error', res.error);
      }
      // Wellenform und Peak-Rest stammen aus der gespeicherten Aufnahme.
      const full = await window.api.session.state();
      if (full.ok) {
        state.peaks = full.peaks || [];
        wave.peaks = state.peaks;
      }
      state.bucketAcc = 0;
      state.bucketFrames = 0;
      setDefaultZoom();
      wave.follow = true;
      $('chk-follow').checked = true;
      monitor.pause();
      state.cursorT = null;
      wave.update({ playhead: null });
      $('player').pause();
      $('export-result').textContent = '';
      toast('success', 'Aufnahme wird fortgesetzt.');
    } catch (err) {
      toast('error', err.message);
    } finally {
      state.starting = false;
      $('btn-continue').disabled = false;
    }
  }

  async function stopRecording() {
    const res = await window.api.record.stop();
    await capture.stop();
    monitor.pause();
    if (!res.ok) return toast('error', res.error);
    toast('success', 'Aufnahme beendet und gespeichert.');
    state.cursorT = null;
    wave.update({ playhead: res.duration || 0 });
    wave.follow = false;
    $('chk-follow').checked = false;
  }

  capture.onChunk = (arrayBuffer) => {
    state.lastChunkAt = Date.now();
    state.chunkSeq += 1;
    // In der Pause läuft die Erfassung weiter, es wird aber nichts aufgezeichnet.
    if (state.session?.status === 'paused') return;
    // Peaks lokal mitrechnen, damit die Wellenform ohne Zusatzverkehr wächst.
    const view = new Int16Array(arrayBuffer);
    const bucketFrames = Math.round(state.sampleRate * 0.05);
    for (let i = 0; i < view.length; i += 2) {
      const m = Math.max(Math.abs(view[i]), Math.abs(view[i + 1])) / 32768;
      if (m > state.bucketAcc) state.bucketAcc = m;
      if (++state.bucketFrames >= bucketFrames) {
        state.peaks.push(Math.round(state.bucketAcc * 255));
        state.bucketAcc = 0;
        state.bucketFrames = 0;
      }
    }
    window.api.record.chunk(arrayBuffer);
  };

  capture.onError = (message) => toast('error', message);

  /* ----------------------------------------------------------------- Listen */

  function renderLists() {
    const session = state.session;
    const pendingEl = $('pending-list');
    const sectionEl = $('marker-list');
    pendingEl.innerHTML = '';
    sectionEl.innerHTML = '';
    if (!session) return;
    const live = session.status === 'recording' || session.status === 'paused';

    const pending = (session.pending || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (pending.length === 0) {
      pendingEl.innerHTML = '<li class="empty">Keine offenen Ablaufpunkte.</li>';
    }
    pending.forEach((x) => {
      const li = document.createElement('li');
      li.className = 'item';
      li.dataset.hue = '';
      li.style.setProperty('--hue', window.sectionHue(x));
      li.draggable = true;
      li.innerHTML = `<span class="label"></span>
        <button class="mini" data-rename title="Name und Interpret bearbeiten">✎</button>
        <button class="mini" data-remove title="Punkt aus dem Ablaufplan entfernen">×</button>`;
      // Klick auf den Punkt beginnt ihn jetzt (nur während der Aufnahme); Ziehen auf die Wellenform bleibt möglich.
      li.classList.toggle('clickable', live);
      li.title = live
        ? 'Klicken: jetzt beginnen · auf die Wellenform ziehen: an die Stelle legen'
        : 'Auf die Wellenform ziehen, um den Punkt an eine Stelle zu legen';
      li.querySelector('.label').textContent = x.label;
      li.querySelector('.label').appendChild(artistTag(x, () => li.getBoundingClientRect()));
      li.querySelector('[data-rename]').addEventListener('click', (e) => {
        e.stopPropagation();
        editSection(x.id, 'name', li.getBoundingClientRect());
      });
      li.querySelector('[data-remove]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.api.section.remove(x.id);
      });
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/marker-id', x.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      // Umsortieren: einen Punkt auf einen anderen Punkt der Liste ziehen (auf die Wellenform = ablegen).
      li.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('text/marker-id')) return;
        e.preventDefault();
        const before = e.clientY - li.getBoundingClientRect().top < li.offsetHeight / 2;
        li.classList.toggle('drop-before', before);
        li.classList.toggle('drop-after', !before);
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
      li.addEventListener('drop', async (e) => {
        const dragged = e.dataTransfer.getData('text/marker-id');
        const before = e.clientY - li.getBoundingClientRect().top < li.offsetHeight / 2;
        li.classList.remove('drop-before', 'drop-after');
        if (!dragged || dragged === x.id) return;
        e.preventDefault();
        const next = before ? x.id : (li.nextElementSibling?.dataset.id || null);
        await window.api.section.reorder(dragged, next);
      });
      li.dataset.id = x.id;
      li.addEventListener('click', async () => {
        if (!live) return;
        const res = await window.api.section.start(x.id, null);
        if (!res.ok) toast('error', res.error);
      });
      pendingEl.appendChild(li);
    });

    const placed = (session.sections || []).filter((x) => x.start != null).sort((a, b) => a.start - b.start);
    if (placed.length === 0) {
      sectionEl.innerHTML = '<li class="empty">Noch keine Abschnitte.</li>';
    }
    placed.forEach((x) => {
      const li = document.createElement('li');
      li.className = 'item' + (state.selectedSectionId === x.id ? ' selected' : '');
      li.dataset.hue = '';
      li.style.setProperty('--hue', window.sectionHue(x));
      li.innerHTML = `<span class="time"></span><span class="label"></span>
        <button class="mini" data-rename title="Name und Interpret bearbeiten">✎</button>
        <button class="mini" data-remove title="Entfernen">×</button>`;
      li.querySelector('.time').textContent = `${fmt(x.start)} – ${x.end != null ? fmt(x.end) : 'läuft'}`;
      li.querySelector('.label').textContent = x.label;
      li.dataset.id = x.id;
      li.querySelector('.label').appendChild(artistTag(x, () => li.getBoundingClientRect()));
      li.addEventListener('click', () => {
        state.selectedSectionId = x.id;
        wave.scrollTo(x.start);
        renderLists();
      });
      li.querySelector('[data-rename]').addEventListener('click', (e) => {
        e.stopPropagation();
        editSection(x.id, 'name', li.getBoundingClientRect());
      });
      li.querySelector('.label').addEventListener('dblclick', () => editSection(x.id, 'name', li.getBoundingClientRect()));
      li.querySelector('[data-remove]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.api.section.remove(x.id);
      });
      sectionEl.appendChild(li);
    });
  }

  /** Interpret hinter dem Namen; ohne Eintrag erscheint beim Darüberfahren "+ Interpret". Klick = direkt bearbeiten. */
  function artistTag(section, getAnchor) {
    const el = document.createElement('span');
    el.className = 'artist' + (section.artist ? '' : ' empty');
    el.textContent = section.artist ? ' · ' + section.artist : ' + Interpret';
    el.title = 'Interpret direkt bearbeiten';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      editSection(section.id, 'artist', getAnchor());
    });
    return el;
  }

  /**
   * Bearbeitet Name und Interpret direkt an Ort und Stelle: ein Feld legt sich über das Element
   * (Fähnchen in der Wellenform oder Listenzeile). Enter speichert, Esc bricht ab, ein Klick
   * daneben speichert ebenfalls. Tab wechselt zwischen Name und Interpret.
   * @param {{left:number, top:number, width:number, height:number}} anchor Lage in Bildschirmkoordinaten
   */
  function editSection(id, focus = 'name', anchor) {
    const x = (state.session?.sections || []).find((y) => y.id === id);
    if (!x || state.inlineEdit) return;
    if (!anchor) {
      const row = document.querySelector(`#marker-list .item[data-id="${id}"], #pending-list .item[data-id="${id}"]`);
      if (!row) return;
      anchor = row.getBoundingClientRect();
    }

    const box = document.createElement('div');
    box.className = 'inline-edit';
    box.style.setProperty('--hue', window.sectionHue(x));
    box.innerHTML = '<input class="ie-name" type="text" aria-label="Name" /><input class="ie-artist" type="text" placeholder="Interpret" aria-label="Interpret" />';
    const name = box.querySelector('.ie-name');
    const artist = box.querySelector('.ie-artist');
    name.value = x.label || '';
    artist.value = x.artist || '';

    const width = Math.max(anchor.width, 300);
    box.style.left = Math.max(4, Math.min(anchor.left, window.innerWidth - width - 4)) + 'px';
    box.style.top = anchor.top + 'px';
    box.style.width = width + 'px';
    box.style.minHeight = Math.max(anchor.height, 26) + 'px';
    document.body.appendChild(box);
    state.inlineEdit = id;

    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      box.remove();
      state.inlineEdit = null;
      if (!save) return;
      const patch = {};
      const label = name.value.trim();
      if (label && label !== x.label) patch.label = label;
      if (artist.value.trim() !== (x.artist || '')) patch.artist = artist.value.trim();
      if (Object.keys(patch).length) await window.api.section.update(id, patch);
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    // Klick außerhalb (Fokus verlässt beide Felder) speichert.
    box.addEventListener('focusout', () => setTimeout(() => { if (!box.contains(document.activeElement)) finish(true); }, 0));
    const first = focus === 'artist' ? artist : name;
    first.focus();
    first.select();
  }

  /** Abschnitte zum Export; beendete Abschnitte sind anklickbar, bereits gesicherte tragen einen Vermerk. */
  function renderSegments() {
    const list = $('export-list');
    const session = state.session;
    const segments = session?.segments || [];
    const canExport = session?.status === 'stopped';
    const sections = new Map((session?.sections || []).map((x) => [x.id, x]));
    list.innerHTML = '';

    if (segments.length === 0) {
      list.innerHTML = '<div class="empty">Abschnitt starten und beenden, um ihn zu exportieren.</div>';
      $('btn-export').disabled = true;
      updateExportButton();
      return;
    }

    segments.forEach((seg) => {
      // Neue Abschnitte sind vorausgewählt, sofern sie noch nicht gesichert wurden (die ganze Aufnahme nie).
      const done = (session.exports || {})[seg.id];
      if (!state.exportSeen.has(seg.id)) {
        state.exportSeen.add(seg.id);
        if (seg.markerId && !seg.open && !done) state.exportChecked.add(seg.id);
      }

      const row = document.createElement('div');
      row.className = 'export-item' + (state.selectedSegmentId === seg.id ? ' selected' : '');
      row.dataset.id = seg.id;
      row.style.setProperty('--hue', window.sectionHue(sections.get(seg.markerId) || { color: 4 }));
      row.innerHTML = '<input type="checkbox" /><span class="name"></span><span class="meta"></span><span class="done"></span>';

      const box = row.querySelector('input');
      box.checked = state.exportChecked.has(seg.id);
      box.disabled = !canExport || seg.open;
      box.addEventListener('change', () => {
        if (box.checked) state.exportChecked.add(seg.id); else state.exportChecked.delete(seg.id);
        updateExportButton();
      });

      const name = row.querySelector('.name');
      name.textContent = seg.label;
      name.title = 'Abschnitt in der Wellenform zeigen';
      name.addEventListener('click', () => {
        state.selectedSegmentId = state.selectedSegmentId === seg.id ? null : seg.id;
        renderSegments();
        wave.update({ selectedSegment: segments.find((x) => x.id === state.selectedSegmentId) || null });
        if (state.selectedSegmentId) wave.scrollTo(seg.start);
      });
      const len = Math.max(0, seg.end - seg.start - (seg.cutSeconds || 0));
      row.querySelector('.meta').textContent = `${fmt(seg.start)}–${fmt(seg.end)} · ${fmt(len)}` +
        (seg.cutSeconds > 0.05 ? ` · ✂ −${fmt(seg.cutSeconds)}` : '');

      const mark = row.querySelector('.done');
      if (done) {
        const sig = (list) => (list || []).map((c) => `${c.start.toFixed(1)}-${c.end.toFixed(1)}`).join(',');
        const changed = Math.abs(done.start - seg.start) > 0.05 || Math.abs(done.end - seg.end) > 0.05
          || sig(done.cuts) !== sig(seg.cuts);
        mark.textContent = changed ? '✓ geändert seit Export' : '✓ gesichert';
        mark.classList.toggle('stale', changed);
        mark.title = done.file;
      }
      list.appendChild(row);
    });

    $('export-target').textContent = canExport
      ? ''
      : 'Der Export ist nach dem Beenden der Aufnahme möglich.';
    updateExportButton();
    refreshExportTarget();
  }

  function updateExportButton() {
    const canExport = state.session?.status === 'stopped';
    const n = $('export-list').querySelectorAll('input:checked').length;
    $('btn-export').disabled = !canExport || n === 0;
    $('btn-export').textContent = n > 1 ? `${n} Ausgewählte als MP3 speichern` : 'Ausgewählte als MP3 speichern';
  }

  /** Zeigt, wohin exportiert wird (Unterordner des Export-Oberordners). */
  async function refreshExportTarget() {
    if (state.session?.status !== 'stopped') return;
    const target = await window.api.exportTarget();
    $('export-target').textContent = target.ok && target.folder
      ? `Ziel: ${target.folder}`
      : 'Der Zielordner wird beim Speichern abgefragt.';
  }

  /* -------------------------------------------------------------- Playhead */

  function setPlayhead(t, seekPlayer) {
    const status = state.session?.status;
    if (status === 'recording' || status === 'paused') {
      // Hörcursor in der laufenden Aufnahme: Ansicht bleibt an der Stelle stehen.
      state.cursorT = t;
      wave.update({ playhead: t });
      wave.follow = false;
      $('chk-follow').checked = false;
      if (monitor.playing) monitor.seek(t);
      return;
    }
    wave.update({ playhead: t });
    if (seekPlayer && $('player').src && state.session?.status === 'stopped') {
      $('player').currentTime = t;
    }
  }

  /** Leertaste / Abspielen-Knopf: Wiedergabe der fertigen Datei oder Mithören der laufenden Aufnahme. */
  function togglePlayback() {
    const status = state.session?.status;
    if (status === 'recording' || status === 'paused') {
      if (monitor.playing) return monitor.pause();
      if (state.cursorT == null) {
        return toast('info', 'Zum Mithören erst in die Wellenform klicken, um den Cursor zu setzen.', 4000);
      }
      if (state.cursorT >= state.duration - 0.5) {
        return toast('info', 'Der Cursor steht am Live-Ende – bitte weiter vorne setzen.', 4000);
      }
      monitor.play(state.cursorT);
      return;
    }
    const player = $('player');
    if (player.paused) player.play(); else player.pause();
  }

  function updatePlayButton() {
    const status = state.session?.status;
    const live = status === 'recording' || status === 'paused';
    const playing = live ? monitor.playing : state.playing;
    $('btn-play').textContent = playing ? 'Pause' : (live ? 'Mithören' : 'Abspielen');
  }

  /* ------------------------------------------------------------ UI-Bindungen */

  function bindUi() {
    $('btn-record').addEventListener('click', () => {
      if (state.session?.status === 'paused') return window.api.record.resume();
      startRecording();
    });
    $('btn-pause').addEventListener('click', async () => {
      const s = state.session?.status;
      const res = s === 'paused' ? await window.api.record.resume() : await window.api.record.pause();
      if (!res.ok) toast('error', res.error);
    });
    $('btn-stop').addEventListener('click', stopRecording);
    $('btn-continue').addEventListener('click', continueRecording);

    // Beginnt sofort einen Abschnitt bzw. beendet den laufenden; umbenannt wird bei Bedarf danach.
    $('btn-marker').addEventListener('click', async () => {
      const res = await window.api.section.toggle({});
      if (!res.ok) return toast('error', res.error);
      state.selectedSectionId = res.section.id;
      renderLists();
    });

    $('btn-next-item').addEventListener('click', async () => {
      const res = await window.api.section.next();
      if (!res.ok) toast('warn', res.error);
    });

    $('btn-zoom-in').addEventListener('click', () => wave.setZoom(wave.pxPerSec * 1.5));
    $('btn-zoom-out').addEventListener('click', () => wave.setZoom(wave.pxPerSec / 1.5));
    $('chk-follow').addEventListener('change', (e) => { wave.follow = e.target.checked; });

    const player = $('player');
    $('btn-play').addEventListener('click', togglePlayback);
    player.addEventListener('play', () => { state.playing = true; updatePlayButton(); });
    player.addEventListener('pause', () => { state.playing = false; updatePlayButton(); });
    player.addEventListener('timeupdate', () => {
      if (state.playing) setPlayhead(player.currentTime, false);
    });

    const addPlanPoint = async () => {
      const input = $('plan-new');
      const label = input.value.trim();
      if (!label) return;
      const res = await window.api.section.add({ label });
      if (!res.ok) return toast('error', res.error);
      input.value = '';
      input.focus();
    };
    $('btn-plan-add').addEventListener('click', addPlanPoint);
    $('plan-template').addEventListener('change', (e) => applyPlanTemplate(e.target.value));
    $('plan-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPlanPoint(); } });
    // Auf den freien Platz unter der Liste ziehen: ans Ende sortieren.
    $('pending-list').addEventListener('dragover', (e) => {
      if (e.target === $('pending-list') && e.dataTransfer.types.includes('text/marker-id')) e.preventDefault();
    });
    $('pending-list').addEventListener('drop', async (e) => {
      if (e.target !== $('pending-list')) return;
      const dragged = e.dataTransfer.getData('text/marker-id');
      if (dragged) await window.api.section.reorder(dragged, null);
    });
    $('btn-all-keys').addEventListener('click', () => openModal('modal-keys'));
    $('btn-export').addEventListener('click', exportSelected);
    $('export-all').addEventListener('click', () => setExportChecks(true));
    $('export-none').addEventListener('click', () => setExportChecks(false));

    $('btn-settings').addEventListener('click', () => openModal('modal-settings'));
    $('btn-library').addEventListener('click', openLibrary);
    $('btn-service').addEventListener('click', openServicePicker);
    $('btn-open-folder').addEventListener('click', () => window.api.app.openRecordingsFolder());

    document.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => b.closest('.modal').hidden = true));
    document.querySelectorAll('.modal').forEach((m) =>
      m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));

    bindSettingsForm();
    bindShortcuts();
  }

  function openModal(id) {
    $(id).hidden = false;
    // Geräte können seit dem Start ein- oder ausgesteckt worden sein.
    if (id === 'modal-settings') {
      refreshDevices();
      loadTemplatesDraft();
      renderTemplateEditor();
    }
  }

  /** Ja/Nein-Abfrage; Abbrechen ist vorausgewählt. */
  function confirmDialog(title, text, okLabel = 'OK') {
    const modal = $('modal-confirm');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel;
    modal.hidden = false;
    $('confirm-cancel').focus();

    return new Promise((resolve) => {
      const finish = (value) => {
        modal.hidden = true;
        modal.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey, true);
        $('confirm-close').removeEventListener('click', onCancel);
        $('confirm-cancel').removeEventListener('click', onCancel);
        $('confirm-ok').removeEventListener('click', onOk);
        resolve(value);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
      modal.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey, true);
      $('confirm-close').addEventListener('click', onCancel);
      $('confirm-cancel').addEventListener('click', onCancel);
      $('confirm-ok').addEventListener('click', onOk);
    });
  }

  async function undoEdit() {
    const res = await window.api.edit.undo();
    toast(res.ok ? 'info' : 'warn', res.ok ? 'Rückgängig gemacht.' : res.error, 2500);
  }

  async function redoEdit() {
    const res = await window.api.edit.redo();
    toast(res.ok ? 'info' : 'warn', res.ok ? 'Wiederholt.' : res.error, 2500);
  }

  /** Taste X: während der Aufnahme einen Schnitt beginnen bzw. beenden (die Stelle fehlt dann im MP3). */
  async function toggleCut() {
    const status = state.session?.status;
    if (status !== 'recording' && status !== 'paused') {
      toast('info', 'Schnitte: während der Aufnahme mit X, sonst mit Umschalt + Ziehen in der Wellenform.', 5000);
      return;
    }
    const res = await window.api.cut.toggle(null);
    if (!res.ok) return toast('warn', res.error);
    const text = { started: 'Schnitt beginnt – X beendet ihn.', ended: 'Schnitt beendet.', discarded: 'Schnitt zu kurz – verworfen.' }[res.change];
    toast(res.change === 'started' ? 'warn' : 'info', text, 3000);
  }

  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
      if (typing) return;
      // Während eines geöffneten Dialogs keine Kürzel auslösen.
      if (document.querySelector('.modal:not([hidden])')) return;

      if (e.ctrlKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        if (state.session?.status === 'recording') stopRecording(); else startRecording();
        return;
      }
      if (e.key.toLowerCase() === 'm' && !e.ctrlKey) {
        if (!$('btn-marker').disabled) { e.preventDefault(); $('btn-marker').click(); }
        return;
      }
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey) {
        if (!$('btn-next-item').disabled) { e.preventDefault(); $('btn-next-item').click(); }
        return;
      }
      // Rückgängig/Wiederholen (Windows/Linux: Strg+Z, Strg+Y bzw. Strg+Umschalt+Z; auf dem Mac über das Menü)
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoEdit(); else undoEdit();
        return;
      }
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redoEdit();
        return;
      }
      if (e.key.toLowerCase() === 'x' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleCut();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        $('modal-keys').hidden = !$('modal-keys').hidden;
        return;
      }
      if (e.key === 'F2' && state.selectedSectionId) {
        e.preventDefault();
        editSection(state.selectedSectionId, 'name');
        return;
      }
      if (e.code === 'Space') {
        // Fokus von Knöpfen nehmen, sonst löst die Leertaste zusätzlich deren Klick aus.
        if (e.target.tagName === 'BUTTON') e.target.blur();
        e.preventDefault();
        if (!$('btn-play').disabled) togglePlayback();
      }
    });
  }

  /* ------------------------------------------------------------- Ereignisse */

  function bindEvents() {
    window.api.on('state', (s) => applyState(s));

    window.api.on('levels', (levels) => {
      $('meter-l').style.width = Math.min(100, levels.l * 100) + '%';
      $('meter-r').style.width = Math.min(100, levels.r * 100) + '%';
      $('clip').dataset.on = String(Boolean(levels.clip));
      state.duration = levels.duration;
      $('timecode').textContent = longTime(levels.duration);
      wave.update({ duration: levels.duration, peaks: state.peaks });
    });

    window.api.on('health', (h) => applyHealth(h));

    window.api.on('toast', ({ level, message }) => toast(level, message));

    window.api.on('command', ({ action }) => {
      if (action === 'record.start') startRecording();
      if (action === 'record.stop') stopRecording();
    });

    // Einträge aus dem macOS-Menü
    window.api.on('menu', ({ action }) => {
      if (action === 'settings') openModal('modal-settings');
      if (action === 'toggle-record') {
        if (state.session?.status === 'recording') stopRecording(); else startRecording();
      }
      if (action === 'undo' || action === 'redo') {
        // In einem Textfeld wirkt Rückgängig dort, sonst auf Abschnitte und Schnitte.
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') document.execCommand(action);
        else if (action === 'undo') undoEdit(); else redoEdit();
      }
      if (action === 'marker' && !$('btn-marker').disabled) $('btn-marker').click();
      if (action === 'next-item' && !$('btn-next-item').disabled) $('btn-next-item').click();
    });

    window.api.on('network-status', (info) => {
      $('net-badge').dataset.on = info.running ? 'true' : 'false';
      $('net-badge').textContent = info.running ? `Netzwerk · Port ${info.port} · ${info.clients}` : 'Netzwerk aus';
      $('net-info').textContent = info.running
        ? `Läuft auf Port ${info.port}. Verbundene Clients: ${info.clients}.`
        : (info.passwordSet ? 'Nicht aktiv.' : 'Kein Passwort gesetzt – die Schnittstelle bleibt aus.');
    });

    window.api.on('update-status', (s) => {
      const btn = $('btn-update');
      btn.hidden = s.state !== 'ready';
      if (s.state === 'ready') {
        btn.textContent = `Update ${s.version} installieren`;
        btn.onclick = async () => {
          const res = await window.api.update.install();
          if (!res.ok) toast('warn', res.error);
        };
      }
      if (s.state === 'error') $('version-info').title = s.message || '';
    });

    window.api.on('export-progress', ({ progress, index, total }) => {
      const bar = $('export-progress');
      bar.hidden = false;
      if (total && progress < 1) $('export-result').textContent = `MP3 ${index} von ${total} wird erstellt …`;
      bar.querySelector('i').style.width = Math.round(progress * 100) + '%';
      if (progress >= 1) setTimeout(() => { bar.hidden = true; }, 800);
    });
  }

  /* ----------------------------------------------------------------- Export */

  function setExportChecks(on) {
    $('export-list').querySelectorAll('input:not(:disabled)').forEach((box) => {
      box.checked = on;
      const id = box.closest('.export-item').dataset.id;
      if (on) state.exportChecked.add(id); else state.exportChecked.delete(id);
    });
    updateExportButton();
  }

  /** Speichert alle angehakten Abschnitte nacheinander als MP3. */
  async function exportSelected() {
    const items = (state.session?.segments || [])
      .filter((seg) => state.exportChecked.has(seg.id) && !seg.open)
      .map((seg) => ({ id: seg.id, start: seg.start, end: seg.end, label: seg.label }));
    if (items.length === 0) return;

    $('btn-export').disabled = true;
    $('export-result').textContent = `MP3 1 von ${items.length} wird erstellt …`;
    try {
      const res = await window.api.exportBatch(items);
      if (res.canceled) {
        $('export-result').textContent = '';
      } else if (!res.ok) {
        $('export-result').textContent = '';
        toast('error', res.error);
      } else {
        // Gesicherte Abschnitte sind danach nicht mehr vorausgewählt.
        items.forEach((item) => {
          if (!res.failed.some((f) => f.label === item.label)) state.exportChecked.delete(item.id);
        });
        const n = res.files.length;
        $('export-result').innerHTML = `${n} von ${items.length} MP3-Dateien gespeichert. <a data-reveal>Im Ordner zeigen</a>`;
        const first = res.files[0];
        $('export-result').querySelector('[data-reveal]').addEventListener('click',
          () => window.api.app.reveal(first || res.folder));
        if (res.failed.length) {
          toast('error', `Nicht exportiert: ${res.failed.map((f) => `${f.label} (${f.error})`).join('; ')}`, 12000);
        } else {
          toast('success', n === 1 ? 'Die MP3 wurde gespeichert.' : `${n} MP3-Dateien wurden gespeichert.`);
        }
      }
    } finally {
      renderSegments();
    }
  }

  /* ------------------------------------------------------- Kürzel und Speicher */

  /** Alle Tastenkürzel; "main" erscheint in der kleinen Karte, alles im Dialog. */
  function shortcutList(platform) {
    const mod = platform === 'darwin' ? 'Cmd' : 'Strg';
    return [
      { keys: [mod, 'R'], text: 'Aufnahme starten / beenden', main: true },
      { keys: ['M'], text: 'Abschnitt starten / beenden', main: true },
      { keys: ['N'], text: 'Nächster Ablaufpunkt', main: true },
      { keys: ['X'], text: 'Schnitt starten / beenden', main: true },
      { keys: [mod, 'Z'], text: 'Rückgängig', main: true },
      { keys: ['Leertaste'], text: 'Mithören / Abspielen', main: true },
      { keys: ['?'], text: 'Alle Kürzel anzeigen' },
      { keys: [mod, 'Umschalt', 'Z'], text: 'Wiederholen' },
      { keys: ['F2'], text: 'Gewählten Abschnitt bearbeiten' },
      { keys: ['Klick'], text: 'In die Wellenform: Hörcursor setzen' },
      { keys: ['Doppelklick'], text: 'Auf eine Marke: Name/Interpret direkt bearbeiten' },
      { keys: ['Ziehen'], text: 'Marke verschieben, Nachbarn weichen aus' },
      { keys: ['Umschalt', 'Ziehen'], text: 'In der Wellenform: Schnitt aufziehen (fehlt im MP3)' },
      { keys: ['Doppelklick'], text: 'Auf einen Schnitt: Schnitt entfernen' },
      { keys: ['Mausrad'], text: 'Wellenform scrollen' },
      { keys: [mod, 'Mausrad'], text: 'Wellenform zoomen' },
      { keys: ['F12'], text: 'Entwicklerwerkzeuge (nur Dev-Modus)' }
    ];
  }

  function renderShortcuts(platform) {
    const fill = (el, items) => {
      el.innerHTML = '';
      items.forEach((it) => {
        const li = document.createElement('li');
        const keys = document.createElement('span');
        keys.className = 'keys';
        it.keys.forEach((k) => {
          const kbd = document.createElement('kbd');
          kbd.textContent = k;
          keys.appendChild(kbd);
        });
        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = it.text;
        li.append(keys, text);
        el.appendChild(li);
      });
    };
    const all = shortcutList(platform);
    fill($('keys-list'), all.filter((x) => x.main));
    fill($('keys-all'), all);
  }

  const DISK_WARN_HOURS = 3;     // darunter wird der Speicherplatz orange
  const DISK_LOW_HOURS = 0.5;    // darunter rot, auch während der Aufnahme als Meldung
  let diskLowToastShown = false;

  function formatBytes(b) {
    const gb = b / 1073741824;
    return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1).replace('.', ',')} GB`;
  }

  function formatHours(h) {
    if (h >= 10) return `${Math.round(h)} Std.`;
    if (h >= 1) return `${h.toFixed(1).replace('.', ',')} Std.`;
    return `${Math.max(0, Math.round(h * 60))} Min.`;
  }

  /** Aktualisiert die Speicheranzeige in der Kopfleiste; gibt die Stunden zurück, die noch Platz haben. */
  async function refreshDisk() {
    const res = await window.api.app.diskFree();
    const badge = $('disk-badge');
    if (!res.ok) {
      badge.textContent = 'Speicher unbekannt';
      badge.dataset.level = 'ok';
      return null;
    }
    badge.textContent = `${formatBytes(res.freeBytes)} frei · ca. ${formatHours(res.hoursLeft)}`;
    badge.title = `Freier Speicherplatz auf ${res.dir}: reicht für ca. ${formatHours(res.hoursLeft)} Aufnahme`;
    badge.dataset.level = res.hoursLeft < DISK_LOW_HOURS ? 'low' : (res.hoursLeft < DISK_WARN_HOURS ? 'warn' : 'ok');

    if (res.hoursLeft < DISK_LOW_HOURS && state.session?.status === 'recording' && !diskLowToastShown) {
      diskLowToastShown = true;
      toast('error', `Speicherplatz wird knapp: nur noch für ca. ${formatHours(res.hoursLeft)} Aufnahme.`, 15000);
    }
    if (res.hoursLeft >= DISK_LOW_HOURS) diskLowToastShown = false;
    return res.hoursLeft;
  }

  /* ---------------------------------------------------------- ChurchTools-UI */

  const OVERVIEW_COUNT = 5;      // so viele vergangene und kommende Termine werden angeboten
  const OVERVIEW_PAST_DAYS = 90;
  const OVERVIEW_FUTURE_DAYS = 120;

  /** Lokales Datum als YYYY-MM-DD (toISOString würde nach UTC umrechnen). */
  function localIsoDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function shiftDays(iso, days) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return localIsoDate(d);
  }

  function germanDate(iso) {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  async function openServicePicker() {
    $('service-date-input').value = '';
    openModal('modal-service');
    loadServiceOverview();
  }

  // Ein gewähltes Datum zeigt nur diesen Tag; leeren zeigt wieder die Übersicht.
  $('service-date-input')?.addEventListener('change', (e) => {
    if (e.target.value) loadServicesForDate(e.target.value, false);
    else loadServiceOverview();
  });

  /** Ergänzt Beginn als Date sowie lokales Datum und Uhrzeit (ChurchTools liefert UTC). */
  function withLocalTime(list) {
    return list.map((s) => {
      const when = s.start ? new Date(s.start) : null;
      const valid = when && !isNaN(when);
      return {
        ...s,
        when: valid ? when : null,
        date: valid ? localIsoDate(when) : s.date,
        time: valid ? when.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''
      };
    });
  }

  /** Der Termin, der gerade läuft oder als Nächster ansteht; sonst der zuletzt begonnene. */
  function pickCurrentOrNext(list) {
    const now = Date.now();
    const SERVICE_FALLBACK_MS = 2 * 3600 * 1000;      // Dauer, falls ChurchTools kein Ende liefert
    const sorted = list.filter((s) => s.when).sort((a, b) => a.when - b.when);
    const endOf = (s) => {
      const e = s.end ? new Date(s.end).getTime() : NaN;
      return isNaN(e) ? s.when.getTime() + SERVICE_FALLBACK_MS : e;
    };
    return sorted.find((s) => endOf(s) > now) || sorted[sorted.length - 1] || list[0] || null;
  }

  function ctConfigured() {
    return Boolean(state.settings.churchToolsUrl && state.settings.churchToolsTokenSet);
  }

  function serviceItem(s) {
    const el = document.createElement('div');
    const current = state.session?.service?.id != null && String(state.session.service.id) === String(s.id);
    el.className = 'list-item' + (current ? ' current' : '');
    el.innerHTML = '<span class="name"></span><span class="meta"></span>';
    el.querySelector('.name').textContent = s.name + (current ? ' ✓' : '');
    el.querySelector('.meta').textContent = [germanDate(s.date), s.time].filter(Boolean).join(' · ');
    el.addEventListener('click', () => chooseService(s, false));
    return el;
  }

  /** Zeigt die zuletzt vergangenen und die nächsten Termine zur Auswahl. */
  async function loadServiceOverview() {
    const list = $('service-list');
    if (!ctConfigured()) {
      list.innerHTML = '<div class="empty">ChurchTools ist noch nicht eingerichtet.</div>';
      return;
    }
    list.innerHTML = '<div class="empty">Wird geladen …</div>';
    const today = localIsoDate();
    const res = await window.api.churchtools.services({
      from: shiftDays(today, -OVERVIEW_PAST_DAYS),
      to: shiftDays(today, OVERVIEW_FUTURE_DAYS)
    });
    if ($('service-date-input').value) return;      // inzwischen ein Datum gewählt
    if (!res.ok) {
      list.innerHTML = '';
      toast('warn', res.error);
      return;
    }
    const services = withLocalTime(res.services);
    const upcoming = services.filter((s) => s.date >= today).slice(0, OVERVIEW_COUNT);
    const past = services.filter((s) => s.date < today).slice(-OVERVIEW_COUNT).reverse();

    list.innerHTML = '';
    const group = (title, items, emptyText) => {
      const head = document.createElement('div');
      head.className = 'list-head';
      head.textContent = title;
      list.appendChild(head);
      if (items.length === 0) {
        list.insertAdjacentHTML('beforeend', `<div class="empty">${emptyText}</div>`);
        return;
      }
      items.forEach((s) => list.appendChild(serviceItem(s)));
    };
    group('Heute und kommende', upcoming, 'Keine kommenden Termine gefunden.');
    group('Zuletzt', past, 'Keine vergangenen Termine gefunden.');
  }

  async function loadServicesForDate(date, silent) {
    const list = $('service-list');
    if (!ctConfigured()) {
      if (!silent) list.innerHTML = '<div class="empty">ChurchTools ist noch nicht eingerichtet.</div>';
      return;
    }
    if (!silent) list.innerHTML = '<div class="empty">Wird geladen …</div>';
    const res = await window.api.churchtools.services({ from: date, to: date });
    if (!res.ok) {
      if (!silent) list.innerHTML = '';
      toast('warn', res.error);
      return;
    }
    const services = withLocalTime(res.services);
    if (silent) {
      if (services.length === 1) {
        chooseService(services[0], true);
      } else if (services.length > 1) {
        const next = pickCurrentOrNext(services);
        toast('info', `${services.length} Termine heute – gewählt: ${next.name} (${next.time}). Über den Namen oben lässt sich ein anderer wählen.`, 9000);
        chooseService(next, true);
      } else toast('info', 'Heute ist kein Termin in ChurchTools – über den Namen oben lassen sich frühere oder kommende wählen.', 9000);
      return;
    }
    list.innerHTML = '';
    if (res.services.length === 0) {
      list.innerHTML = '<div class="empty">Keine Termine an diesem Tag.</div>';
      return;
    }
    services.forEach((s) => list.appendChild(serviceItem(s)));
  }

  async function chooseService(service, silent) {
    $('modal-service').hidden = true;
    const res = await window.api.churchtools.agenda({
      eventId: service.id,
      name: service.name,
      date: service.date
    });
    if (!res.ok) return toast('warn', 'Ablaufplan nicht geladen: ' + res.error);
    if (res.usedDefaults) {
      toast('info', `${service.name}: In ChurchTools ist kein Ablaufplan gepflegt – ${res.count} Standardpunkte eingetragen.`, 9000);
    } else {
      toast('success', `${service.name}: ${res.count} Ablaufpunkte übernommen.`);
    }
  }

  $('btn-manual-service')?.addEventListener('click', async () => {
    const name = $('manual-service-name').value.trim();
    if (!name) return;
    await window.api.session.setService({ name, date: localIsoDate() });
    $('modal-service').hidden = true;
  });

  /* -------------------------------------------------------------- Bibliothek */

  async function openLibrary() {
    openModal('modal-library');
    const list = $('library-list');
    list.innerHTML = '<div class="empty">Wird geladen …</div>';
    const res = await window.api.session.list();
    list.innerHTML = '';
    if (!res.ok || res.sessions.length === 0) {
      list.innerHTML = '<div class="empty">Noch keine Aufnahmen vorhanden.</div>';
      return;
    }
    res.sessions.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'list-item' + (s.finalized ? '' : ' unfinished');
      el.innerHTML = '<span class="name"></span><span class="meta"></span>';
      el.querySelector('.name').textContent = s.name + (s.finalized ? '' : ' · unterbrochen');
      el.querySelector('.meta').textContent = `${s.date} · ${fmt(s.duration)} · ${s.sectionCount} Abschnitte`;
      el.addEventListener('click', () => openSession(s.path));
      list.appendChild(el);
    });
  }

  async function openSession(path) {
    const res = await window.api.session.open(path);
    if (!res.ok) return toast('error', res.error);
    $('modal-library').hidden = true;
    const full = await window.api.session.state();
    if (full.ok) {
      state.peaks = full.peaks || [];
      wave.peaks = state.peaks;
      applyState(full.state, full.peaks);
      fitZoom();
    }
  }

  async function checkRecovery() {
    const res = await window.api.session.recoverable();
    if (!res.ok || res.sessions.length === 0) return;
    const s = res.sessions[0];
    toast('warn', `Eine unterbrochene Aufnahme wurde gefunden (${s.date}, ${fmt(s.duration)}). Über "Aufnahmen" wiederherstellbar.`, 12000);
  }

  /* --------------------------------------------------------- Einstellungen */

  async function fillDeviceSelect(sel, kind, savedId, emptyText) {
    sel.innerHTML = '';
    const std = document.createElement('option');
    std.value = '';
    std.textContent = 'Systemstandard';
    sel.appendChild(std);
    try {
      const devices = await window.Capture.listDevices(kind);
      devices.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.label;
        sel.appendChild(opt);
      });
      if (devices.length === 0) std.textContent = emptyText;
      // Gespeichertes Gerät nicht mehr angeschlossen: bei Systemstandard bleiben.
      sel.value = devices.some((d) => d.id === savedId) ? savedId : '';
    } catch (err) {
      std.textContent = 'Zugriff auf Audiogeräte fehlgeschlagen';
    }
  }

  async function refreshDevices() {
    await fillDeviceSelect($('set-device'), 'audioinput', state.settings.inputDeviceId, 'Systemstandard (kein Eingang gefunden)');
    await fillDeviceSelect($('set-output'), 'audiooutput', state.settings.outputDeviceId, 'Systemstandard');
    applyOutputDevice();
  }

  /** Wendet das gewählte Ausgabegerät auf Mithören und Abspielen an. */
  function applyOutputDevice() {
    const id = state.settings.outputDeviceId || '';
    monitor.setOutput(id).catch(() => {});
    const player = $('player');
    if (player.setSinkId) {
      player.setSinkId(id).catch(() => player.setSinkId('').catch(() => {}));
    }
  }

  function applySettingsToForm() {
    const s = state.settings;
    $('set-samplerate').value = String(s.sampleRate);
    $('set-dir').value = s.recordingsDir;
    loadTemplatesDraft();
    renderTemplateEditor();
    fillPlanTemplates();
    $('set-default-artist').value = s.defaultArtist || '';
    $('set-export-dir').value = s.exportDir || '';
    $('set-pattern').value = s.fileNamePattern;
    $('set-bitrate').value = String(s.mp3Bitrate);
    $('set-ct-url').value = s.churchToolsUrl;
    $('set-ct-auto').checked = Boolean(s.autoLoadTodaysService);
    $('ct-token-state').textContent = s.churchToolsTokenSet
      ? (s.encryptionAvailable ? 'Ein Token ist hinterlegt (verschlüsselt gespeichert).' : 'Ein Token ist hinterlegt. Achtung: Verschlüsselung auf diesem System nicht verfügbar.')
      : 'Noch kein Token hinterlegt.';
    $('set-net-on').checked = Boolean(s.networkEnabled);
    $('set-net-port').value = s.networkPort;
    $('set-net-pass').value = s.networkPassword;
    $('set-monitor-pass').value = s.monitorPassword;
    $('set-autoupdate').checked = Boolean(s.autoUpdateCheck);
    $('set-theme').value = s.theme || 'dark';
  }

  /** Editor für die Standard-Programmpunkte (Name, nach oben/unten, entfernen). */
  function renderDefaultAgenda(list) {
    const box = $('default-agenda-list');
    box.innerHTML = '';
    (list || []).forEach((text) => addDefaultAgendaRow(text));
  }

  function addDefaultAgendaRow(text = '') {
    const box = $('default-agenda-list');
    const row = document.createElement('div');
    row.className = 'agenda-row';
    row.innerHTML = `<input type="text" />
      <button class="secondary" data-up title="Nach oben">↑</button>
      <button class="secondary" data-down title="Nach unten">↓</button>
      <button class="secondary" data-del title="Entfernen">×</button>`;
    row.querySelector('input').value = text;
    row.querySelector('[data-up]').addEventListener('click', () => {
      if (row.previousElementSibling) box.insertBefore(row, row.previousElementSibling);
    });
    row.querySelector('[data-down]').addEventListener('click', () => {
      if (row.nextElementSibling) box.insertBefore(row.nextElementSibling, row);
    });
    row.querySelector('[data-del]').addEventListener('click', () => row.remove());
    box.appendChild(row);
    return row;
  }

  /* ----------------------------------------------- Vorlagen für Programmpunkte */

  /** Arbeitskopie der Vorlagen für den Einstellungsdialog. */
  function loadTemplatesDraft() {
    const list = JSON.parse(JSON.stringify(state.settings.agendaTemplates || []));
    state.tpl = {
      templates: list,
      defaultId: state.settings.defaultTemplateId || (list[0] && list[0].id),
      selectedId: state.settings.defaultTemplateId || (list[0] && list[0].id)
    };
  }

  /** Übernimmt Name und Punkte aus den Eingabefeldern in die Arbeitskopie. */
  function commitTemplateDraft() {
    const t = state.tpl;
    const cur = t && t.templates.find((x) => x.id === t.selectedId);
    if (!cur) return;
    cur.name = $('tpl-name').value.trim() || 'Ohne Namen';
    cur.items = readDefaultAgenda();
  }

  function renderTemplateEditor() {
    const t = state.tpl;
    if (!t) return;
    const sel = $('tpl-select');
    sel.innerHTML = '';
    t.templates.forEach((tpl) => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.name + (tpl.id === t.defaultId ? ' (Standard)' : '');
      sel.appendChild(opt);
    });
    sel.value = t.selectedId;
    const cur = t.templates.find((x) => x.id === t.selectedId);
    $('tpl-name').value = cur ? cur.name : '';
    $('tpl-default').checked = t.defaultId === t.selectedId;
    $('tpl-default').disabled = t.defaultId === t.selectedId;     // es muss immer eine Standardvorlage geben
    renderDefaultAgenda(cur ? cur.items : []);
  }

  function readTemplatesForSave() {
    commitTemplateDraft();
    return { agendaTemplates: state.tpl.templates, defaultTemplateId: state.tpl.defaultId };
  }

  /** Auswahlfeld in der Kachel "Ablaufplan": Vorlage laden. */
  function fillPlanTemplates() {
    const sel = $('plan-template');
    sel.innerHTML = '<option value="">Vorlage laden …</option>';
    (state.settings.agendaTemplates || []).forEach((tpl) => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.name;
      sel.appendChild(opt);
    });
  }

  async function applyPlanTemplate(id) {
    const tpl = (state.settings.agendaTemplates || []).find((x) => x.id === id);
    $('plan-template').value = '';
    if (!tpl) return;
    if ((state.session?.pending || []).length > 0) {
      const go = await confirmDialog(
        `Vorlage „${tpl.name}" laden?`,
        'Die offenen Punkte im Ablaufplan werden durch die Punkte der Vorlage ersetzt. Bereits gesetzte Abschnitte bleiben erhalten.',
        'Vorlage laden'
      );
      if (!go) return;
    }
    const res = await window.api.agenda.applyTemplate(id);
    toast(res.ok ? 'success' : 'error', res.ok ? `Vorlage „${res.name}": ${res.count} Punkte eingetragen.` : res.error, 4000);
  }

  function readDefaultAgenda() {
    return [...$('default-agenda-list').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
  }

  function bindSettingsForm() {
    $('btn-default-agenda-add').addEventListener('click', () => addDefaultAgendaRow('').querySelector('input').focus());
    $('tpl-select').addEventListener('change', (e) => { commitTemplateDraft(); state.tpl.selectedId = e.target.value; renderTemplateEditor(); });
    $('btn-tpl-add').addEventListener('click', () => {
      commitTemplateDraft();
      const tpl = { id: 'tpl_' + Date.now().toString(36), name: 'Neue Vorlage', items: [] };
      state.tpl.templates.push(tpl);
      state.tpl.selectedId = tpl.id;
      renderTemplateEditor();
      $('tpl-name').focus();
      $('tpl-name').select();
    });
    $('btn-tpl-del').addEventListener('click', () => {
      const t = state.tpl;
      if (t.templates.length <= 1) return toast('warn', 'Mindestens eine Vorlage muss bleiben.', 4000);
      t.templates = t.templates.filter((x) => x.id !== t.selectedId);
      if (t.defaultId === t.selectedId) t.defaultId = t.templates[0].id;
      t.selectedId = t.defaultId;
      renderTemplateEditor();
    });
    $('tpl-default').addEventListener('change', (e) => {
      commitTemplateDraft();      // Änderungen an Name und Punkten nicht verlieren
      if (e.target.checked) state.tpl.defaultId = state.tpl.selectedId;
      renderTemplateEditor();
    });
    $('tpl-name').addEventListener('input', () => {
      // Name sofort im Auswahlfeld zeigen
      const opt = $('tpl-select').selectedOptions[0];
      if (opt) opt.textContent = $('tpl-name').value || 'Ohne Namen';
    });
    $('btn-choose-dir').addEventListener('click', async () => {
      const res = await window.api.settings.chooseFolder();
      if (res.ok && res.path) $('set-dir').value = res.path;
    });
    $('btn-choose-export-dir').addEventListener('click', async () => {
      const res = await window.api.settings.chooseFolder();
      if (res.ok && res.path) $('set-export-dir').value = res.path;
    });
    $('btn-clear-export-dir').addEventListener('click', () => { $('set-export-dir').value = ''; });
    $('btn-ct-test').addEventListener('click', async () => {
      $('ct-test-result').textContent = 'Wird geprüft …';
      await saveSettings(true);
      const res = await window.api.churchtools.test();
      $('ct-test-result').textContent = res.ok
        ? `Verbunden als ${res.name}.`
        : res.error;
    });

    $('btn-check-update').addEventListener('click', async () => {
      await window.api.update.check();
      toast('info', 'Es wird nach einem Update gesucht.');
    });

    $('btn-save-settings').addEventListener('click', () => saveSettings(false));
  }

  async function saveSettings(keepOpen) {
    const patch = {
      inputDeviceId: $('set-device').value,
      inputDeviceLabel: $('set-device').selectedOptions[0]?.textContent || '',
      outputDeviceId: $('set-output').value,
      outputDeviceLabel: $('set-output').selectedOptions[0]?.textContent || '',
      sampleRate: Number($('set-samplerate').value),
      recordingsDir: $('set-dir').value,
      exportDir: $('set-export-dir').value,
      ...readTemplatesForSave(),
      defaultArtist: $('set-default-artist').value.trim(),
      fileNamePattern: $('set-pattern').value.trim() || '{interpret}_{abschnitt}_{gottesdienst}_{datum}',
      mp3Bitrate: Number($('set-bitrate').value),
      churchToolsUrl: $('set-ct-url').value.trim(),
      autoLoadTodaysService: $('set-ct-auto').checked,
      networkEnabled: $('set-net-on').checked,
      networkPort: Number($('set-net-port').value) || 8765,
      networkPassword: $('set-net-pass').value,
      monitorPassword: $('set-monitor-pass').value,
      autoUpdateCheck: $('set-autoupdate').checked,
      theme: $('set-theme').value
    };
    const token = $('set-ct-token').value;
    if (token) patch.churchToolsToken = token;

    const res = await window.api.settings.set(patch);
    if (!res.ok) return toast('error', res.error);
    state.settings = res.settings;
    applyTheme(state.settings.theme);
    applyOutputDevice();
    refreshDisk();
    $('set-ct-token').value = '';
    applySettingsToForm();
    if (!keepOpen) {
      $('modal-settings').hidden = true;
      toast('success', 'Einstellungen gespeichert.');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
