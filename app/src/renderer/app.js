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
    playing: false,
    starting: false,
    bucketAcc: 0,
    bucketFrames: 0,
    sampleRate: 48000,
    cursorT: null            // Hörcursor während der Aufnahme
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
      pxPerSec: state.settings.waveformZoom || 12,
      colors: readColors(),
      onEdgeMove: () => renderLists(),
      onEdgeMoveEnd: async (id, edge, time) => {
        await window.api.section.moveEdge(id, edge, time);
      },
      onSeek: (t) => setPlayhead(t, true),
      onRenameSection: (id) => renameSection(id),
      onSelectSection: (id) => {
        state.selectedSectionId = id;
        renderLists();
      },
      onDropPending: async (id, time) => {
        const res = await window.api.section.start(id, time);
        if (!res.ok) toast('error', res.error);
      }
    });

    bindUi();
    bindEvents();
    await refreshDevices();
    applySettingsToForm();
    await updateBadges(info);
    $('version-info').textContent = `Version ${info.version}`;

    const st = await window.api.session.state();
    if (st.ok) {
      applyState(st.state, st.peaks, st.transcript);
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
    const t = info.transcription || {};
    const badge = $('trans-badge');
    badge.dataset.on = t.ok ? 'true' : (t.reason === 'disabled' ? 'false' : 'warn');
    badge.textContent = t.ok ? 'Transkript bereit' : 'Transkript aus';
    badge.title = t.message || (t.reason === 'disabled' ? 'In den Einstellungen deaktiviert.' : '');
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

  function applyState(session, peaks, transcript) {
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
      recording: rec,
      selectedSegment: session.segments?.find((s) => s.id === state.selectedSegmentId) || null
    });

    renderLists();
    renderSegments();
    if (transcript) renderTranscript(transcript);
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
      const result = await capture.start(state.settings.inputDeviceId, state.settings.sampleRate);
      state.sampleRate = result.sampleRate;

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
        <button class="mini" data-place title="Diesen Abschnitt jetzt beginnen">starten</button>`;
      li.querySelector('.label').textContent = x.label;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/marker-id', x.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      const btn = li.querySelector('[data-place]');
      btn.disabled = !live;
      btn.addEventListener('click', async () => {
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
        <button class="mini" data-rename title="Umbenennen">✎</button>
        <button class="mini" data-remove title="Entfernen">×</button>`;
      li.querySelector('.time').textContent = `${fmt(x.start)} – ${x.end != null ? fmt(x.end) : 'läuft'}`;
      li.querySelector('.label').textContent = x.label;
      li.addEventListener('click', () => {
        state.selectedSectionId = x.id;
        wave.scrollTo(x.start);
        renderLists();
      });
      li.querySelector('[data-rename]').addEventListener('click', (e) => {
        e.stopPropagation();
        renameSection(x.id);
      });
      li.querySelector('.label').addEventListener('dblclick', () => renameSection(x.id));
      li.querySelector('[data-remove]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.api.section.remove(x.id);
      });
      sectionEl.appendChild(li);
    });
  }

  async function renameSection(id) {
    const x = (state.session?.sections || []).find((y) => y.id === id);
    if (!x) return;
    const name = await promptDialog('Neuer Name für den Abschnitt:', x.label);
    if (name && name.trim()) await window.api.section.update(id, { label: name.trim() });
  }

  function renderSegments() {
    const sel = $('segment-select');
    const session = state.session;
    const segments = session?.segments || [];
    const previous = state.selectedSegmentId;
    sel.innerHTML = '';

    if (segments.length === 0) {
      sel.innerHTML = '<option>Noch keine Abschnitte</option>';
      sel.disabled = true;
      $('btn-export').disabled = true;
      $('segment-info').textContent = 'Abschnitt starten und beenden, um ihn zu exportieren.';
      return;
    }

    segments.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.label} · ${fmt(s.start)}–${fmt(s.end)}`;
      sel.appendChild(opt);
    });

    const stillThere = segments.find((s) => s.id === previous);
    // Vorauswahl: der längste Abschnitt ist meist die Predigt; ohne Abschnitte die ganze Aufnahme.
    const real = segments.filter((x) => x.markerId);
    const preferred = stillThere
      || (real.length ? real : segments).slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    state.selectedSegmentId = preferred.id;
    sel.value = preferred.id;
    sel.disabled = false;

    const canExport = state.session.status === 'stopped';
    $('btn-export').disabled = !canExport;
    updateSegmentInfo();
    if (!canExport) $('segment-info').textContent = 'Export ist nach dem Beenden der Aufnahme möglich.';
  }

  function updateSegmentInfo() {
    const seg = (state.session?.segments || []).find((s) => s.id === state.selectedSegmentId);
    if (!seg) return;
    const len = Math.max(0, seg.end - seg.start);
    $('segment-info').textContent = `${fmt(seg.start)} bis ${fmt(seg.end)} · Länge ${fmt(len)}`;
    wave.update({ selectedSegment: seg });
  }

  function renderTranscript(list) {
    const el = $('transcript');
    el.innerHTML = '';
    (list || []).forEach((seg) => appendTranscript(seg, false));
    el.scrollTop = el.scrollHeight;
  }

  function appendTranscript(seg, scroll = true) {
    const el = $('transcript');
    const line = document.createElement('div');
    line.className = 'tline';
    line.innerHTML = '<span class="ts"></span><span class="txt"></span>';
    line.querySelector('.ts').textContent = fmt(seg.start);
    line.querySelector('.txt').textContent = seg.text;
    line.addEventListener('click', () => {
      wave.scrollTo(seg.start);
      setPlayhead(seg.start, true);
    });
    el.appendChild(line);
    if (scroll) el.scrollTop = el.scrollHeight;
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

    $('segment-select').addEventListener('change', (e) => {
      state.selectedSegmentId = e.target.value;
      updateSegmentInfo();
    });

    $('btn-export').addEventListener('click', exportSelected);

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
    if (id === 'modal-settings') refreshDevices();
  }

  /** Ersatz für window.prompt(), das Electron nicht unterstützt. */
  function promptDialog(title, defaultValue = '') {
    const modal = $('modal-prompt');
    const input = $('prompt-input');
    $('prompt-title').textContent = title;
    input.value = defaultValue;
    modal.hidden = false;
    input.focus();
    input.select();

    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        modal.hidden = true;
        modal.removeEventListener('click', onBackdrop);
        $('prompt-close').removeEventListener('click', onCancel);
        $('prompt-cancel').removeEventListener('click', onCancel);
        $('prompt-ok').removeEventListener('click', onOk);
        input.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onOk = () => finish(input.value);
      const onCancel = () => finish(null);
      const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
      const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); onOk(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      };
      modal.addEventListener('click', onBackdrop);
      $('prompt-close').addEventListener('click', onCancel);
      $('prompt-cancel').addEventListener('click', onCancel);
      $('prompt-ok').addEventListener('click', onOk);
      input.addEventListener('keydown', onKey);
    });
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
      if (e.key === 'F2' && state.selectedSectionId) {
        e.preventDefault();
        renameSection(state.selectedSectionId);
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

    window.api.on('transcript', (seg) => appendTranscript(seg));

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

    window.api.on('transcription-status', (s) => {
      const badge = $('trans-badge');
      badge.dataset.on = s.active ? 'true' : (s.message ? 'warn' : 'false');
      badge.textContent = s.active ? 'Transkript läuft' : 'Transkript aus';
      badge.title = s.message || '';
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

    window.api.on('export-progress', ({ progress }) => {
      const bar = $('export-progress');
      bar.hidden = false;
      bar.querySelector('i').style.width = Math.round(progress * 100) + '%';
      if (progress >= 1) setTimeout(() => { bar.hidden = true; }, 800);
    });
  }

  /* ----------------------------------------------------------------- Export */

  async function exportSelected() {
    const seg = (state.session?.segments || []).find((s) => s.id === state.selectedSegmentId);
    if (!seg) return;
    $('btn-export').disabled = true;
    $('export-result').textContent = 'MP3 wird erstellt …';
    try {
      const res = await window.api.exportSegment({ start: seg.start, end: seg.end, label: seg.label });
      if (res.canceled) {
        $('export-result').textContent = '';
      } else if (res.ok) {
        const mb = (res.bytes / 1048576).toFixed(1);
        $('export-result').innerHTML = `Gespeichert (${mb} MB). <a data-reveal>Im Ordner zeigen</a>`;
        $('export-result').querySelector('[data-reveal]').addEventListener('click',
          () => window.api.app.reveal(res.outPath));
        toast('success', 'MP3 wurde gespeichert.');
      } else {
        $('export-result').textContent = '';
        toast('error', res.error);
      }
    } finally {
      $('btn-export').disabled = false;
    }
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

  function ctConfigured() {
    return Boolean(state.settings.churchToolsUrl && state.settings.churchToolsTokenSet);
  }

  function serviceItem(s) {
    const el = document.createElement('div');
    const current = state.session?.service?.id != null && String(state.session.service.id) === String(s.id);
    el.className = 'list-item' + (current ? ' current' : '');
    el.innerHTML = '<span class="name"></span><span class="meta"></span>';
    el.querySelector('.name').textContent = s.name + (current ? ' ✓' : '');
    el.querySelector('.meta').textContent = `${germanDate(s.date)} · ${(s.start || '').slice(11, 16)}`.replace(/ · $/, '');
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
    const upcoming = res.services.filter((s) => s.date >= today).slice(0, OVERVIEW_COUNT);
    const past = res.services.filter((s) => s.date < today).slice(-OVERVIEW_COUNT).reverse();

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
    if (silent) {
      if (res.services.length === 1) chooseService(res.services[0], true);
      else if (res.services.length > 1) toast('info', `${res.services.length} Termine heute – bitte oben auswählen.`);
      else toast('info', 'Heute ist kein Termin in ChurchTools – über den Namen oben lassen sich frühere oder kommende wählen.', 9000);
      return;
    }
    list.innerHTML = '';
    if (res.services.length === 0) {
      list.innerHTML = '<div class="empty">Keine Termine an diesem Tag.</div>';
      return;
    }
    res.services.forEach((s) => list.appendChild(serviceItem(s)));
  }

  async function chooseService(service, silent) {
    $('modal-service').hidden = true;
    const res = await window.api.churchtools.agenda({
      eventId: service.id,
      name: service.name,
      date: service.date
    });
    if (!res.ok) return toast('warn', 'Ablaufplan nicht geladen: ' + res.error);
    toast('success', `${service.name}: ${res.count} Ablaufpunkte übernommen.`);
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
      applyState(full.state, full.peaks, full.transcript);
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
    $('set-trans-on').checked = Boolean(s.transcriptionEnabled);
    $('set-whisper-bin').value = s.whisperBinaryPath;
    $('set-whisper-model').value = s.whisperModelPath;
    $('set-chunk').value = String(s.transcriptionChunkSeconds);
    $('set-autoupdate').checked = Boolean(s.autoUpdateCheck);
    $('set-theme').value = s.theme || 'dark';
  }

  function bindSettingsForm() {
    $('btn-choose-dir').addEventListener('click', async () => {
      const res = await window.api.settings.chooseFolder();
      if (res.ok && res.path) $('set-dir').value = res.path;
    });
    $('btn-choose-bin').addEventListener('click', async () => {
      const res = await window.api.settings.chooseFile({
        title: 'Whisper-Programm wählen',
        filters: [{ name: 'Programm', extensions: ['exe', ''] }]
      });
      if (res.ok && res.path) $('set-whisper-bin').value = res.path;
    });
    $('btn-choose-model').addEventListener('click', async () => {
      const res = await window.api.settings.chooseFile({
        title: 'Whisper-Modell wählen',
        filters: [{ name: 'Modell', extensions: ['bin'] }]
      });
      if (res.ok && res.path) $('set-whisper-model').value = res.path;
    });

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
      fileNamePattern: $('set-pattern').value.trim() || '{datum}_{gottesdienst}_{abschnitt}',
      mp3Bitrate: Number($('set-bitrate').value),
      churchToolsUrl: $('set-ct-url').value.trim(),
      autoLoadTodaysService: $('set-ct-auto').checked,
      networkEnabled: $('set-net-on').checked,
      networkPort: Number($('set-net-port').value) || 8765,
      networkPassword: $('set-net-pass').value,
      monitorPassword: $('set-monitor-pass').value,
      transcriptionEnabled: $('set-trans-on').checked,
      whisperBinaryPath: $('set-whisper-bin').value,
      whisperModelPath: $('set-whisper-model').value,
      transcriptionChunkSeconds: Number($('set-chunk').value),
      autoUpdateCheck: $('set-autoupdate').checked,
      theme: $('set-theme').value,
      waveformZoom: wave ? wave.pxPerSec : 12
    };
    const token = $('set-ct-token').value;
    if (token) patch.churchToolsToken = token;

    const res = await window.api.settings.set(patch);
    if (!res.ok) return toast('error', res.error);
    state.settings = res.settings;
    applyTheme(state.settings.theme);
    applyOutputDevice();
    $('set-ct-token').value = '';
    applySettingsToForm();
    if (!keepOpen) {
      $('modal-settings').hidden = true;
      toast('success', 'Einstellungen gespeichert.');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
