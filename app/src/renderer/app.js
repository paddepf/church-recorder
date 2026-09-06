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
    selectedMarkerId: null,
    selectedSegmentId: null,
    playing: false,
    starting: false,
    bucketAcc: 0,
    bucketFrames: 0,
    sampleRate: 48000
  };

  const capture = new window.Capture();
  let wave = null;

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

    wave = new window.Waveform($('wave'), {
      pxPerSec: state.settings.waveformZoom || 12,
      colors: readColors(),
      onMarkerMove: () => renderLists(),
      onMarkerMoveEnd: async (id, time) => {
        await window.api.marker.move(id, time);
      },
      onSeek: (t) => setPlayhead(t, true),
      onSelectMarker: (id) => {
        state.selectedMarkerId = id;
        renderLists();
      },
      onDropPending: async (id, time) => {
        const res = await window.api.marker.place(id, time);
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
      loadServicesForDate(new Date().toISOString().slice(0, 10), true);
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
      bg: '#131A21',
      ruler: '#101720',
      line: v('--line'),
      wave: v('--wave'),
      muted: v('--muted'),
      text: v('--text'),
      plan: v('--plan'),
      manual: v('--manual'),
      tally: v('--tally'),
      selection: 'rgba(108,124,224,0.22)'
    };
  }

  /* ------------------------------------------------------------- Zustandsbild */

  function applyState(session, peaks, transcript) {
    state.session = session;
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

    $('record-label').textContent = rec ? 'Aufnahme läuft' : (paused ? 'Fortsetzen' : 'Aufnahme starten');
    $('btn-record').disabled = rec || state.starting;
    $('btn-pause').disabled = !(rec || paused);
    $('btn-pause').textContent = paused ? 'Fortsetzen' : 'Pause';
    $('btn-stop').disabled = !(rec || paused);
    $('btn-marker').disabled = !(rec || paused);
    $('btn-next-item').disabled = !(rec || paused) || (session.pending || []).length === 0;
    $('btn-play').disabled = !(stopped && session.wavPath);

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
      markers: (session.markers || []).map((m) => ({ ...m })),
      recording: rec,
      selectedSegment: session.segments?.find((s) => s.id === state.selectedSegmentId) || null
    });

    renderLists();
    renderSegments();
    if (transcript) renderTranscript(transcript);
  }

  /* --------------------------------------------------------------- Aufnahme */

  async function startRecording() {
    if (state.starting) return;
    if (state.session && (state.session.status === 'recording' || state.session.status === 'paused')) return;
    state.starting = true;
    $('btn-record').disabled = true;

    try {
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
      $('export-result').textContent = '';
      toast('success', `Aufnahme läuft – ${result.deviceLabel || 'Eingang'} bei ${Math.round(result.sampleRate / 1000)} kHz.`);
    } catch (err) {
      toast('error', err.message);
    } finally {
      state.starting = false;
    }
  }

  async function stopRecording() {
    const res = await window.api.record.stop();
    await capture.stop();
    if (!res.ok) return toast('error', res.error);
    toast('success', 'Aufnahme beendet und gespeichert.');
    wave.follow = false;
    $('chk-follow').checked = false;
  }

  capture.onChunk = (arrayBuffer) => {
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
    const markerEl = $('marker-list');
    pendingEl.innerHTML = '';
    markerEl.innerHTML = '';
    if (!session) return;

    const pending = (session.pending || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (pending.length === 0) {
      pendingEl.innerHTML = '<li class="empty">Keine offenen Ablaufpunkte.</li>';
    }
    pending.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'item';
      li.dataset.source = m.source;
      li.draggable = true;
      li.innerHTML = `<span class="label"></span>
        <button class="mini" data-place title="An aktueller Stelle setzen">jetzt</button>`;
      li.querySelector('.label').textContent = m.label;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/marker-id', m.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      li.querySelector('[data-place]').addEventListener('click', async () => {
        const res = await window.api.marker.place(m.id, null);
        if (!res.ok) toast('error', res.error);
      });
      pendingEl.appendChild(li);
    });

    const placed = (session.markers || []).filter((m) => m.placed).sort((a, b) => a.time - b.time);
    if (placed.length === 0) {
      markerEl.innerHTML = '<li class="empty">Noch keine Marker gesetzt.</li>';
    }
    placed.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'item' + (state.selectedMarkerId === m.id ? ' selected' : '');
      li.dataset.source = m.source;
      li.innerHTML = `<span class="time"></span><span class="label"></span>
        <button class="mini" data-rename title="Umbenennen">✎</button>
        <button class="mini" data-remove title="Entfernen">×</button>`;
      li.querySelector('.time').textContent = fmt(m.time);
      li.querySelector('.label').textContent = m.label;
      li.addEventListener('click', () => {
        state.selectedMarkerId = m.id;
        wave.scrollTo(m.time);
        renderLists();
      });
      li.querySelector('[data-rename]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = await promptDialog('Neuer Name für den Marker:', m.label);
        if (name && name.trim()) await window.api.marker.update(m.id, { label: name.trim() });
      });
      li.querySelector('[data-remove]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.api.marker.remove(m.id);
      });
      markerEl.appendChild(li);
    });
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
      $('segment-info').textContent = 'Marker setzen, um Abschnitte zu erhalten.';
      return;
    }

    segments.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.label} · ${fmt(s.start)}–${fmt(s.end)}`;
      sel.appendChild(opt);
    });

    const stillThere = segments.find((s) => s.id === previous);
    // Vorauswahl: der längste Abschnitt ist meist die Predigt.
    const preferred = stillThere || segments.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
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
    wave.update({ playhead: t });
    if (seekPlayer && $('player').src && state.session?.status === 'stopped') {
      $('player').currentTime = t;
    }
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

    $('btn-marker').addEventListener('click', async () => {
      const label = await promptDialog('Bezeichnung des Markers:', 'Marker');
      if (label === null) return;
      const res = await window.api.marker.add({ label: label.trim() || 'Marker' });
      if (!res.ok) toast('error', res.error);
    });

    $('btn-next-item').addEventListener('click', async () => {
      const res = await window.api.marker.next();
      if (!res.ok) toast('warn', res.error);
    });

    $('btn-zoom-in').addEventListener('click', () => wave.setZoom(wave.pxPerSec * 1.5));
    $('btn-zoom-out').addEventListener('click', () => wave.setZoom(wave.pxPerSec / 1.5));
    $('chk-follow').addEventListener('change', (e) => { wave.follow = e.target.checked; });

    const player = $('player');
    $('btn-play').addEventListener('click', () => {
      if (player.paused) player.play(); else player.pause();
    });
    player.addEventListener('play', () => { state.playing = true; $('btn-play').textContent = 'Pause'; });
    player.addEventListener('pause', () => { state.playing = false; $('btn-play').textContent = 'Abspielen'; });
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

  function openModal(id) { $(id).hidden = false; }

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

  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
      if (typing) return;

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
      if (e.code === 'Space') {
        if (!$('btn-play').disabled) { e.preventDefault(); $('btn-play').click(); }
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
      wave.update({ duration: levels.duration, playhead: levels.duration, peaks: state.peaks });
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

  async function openServicePicker() {
    const input = $('service-date-input');
    if (!input.value) input.value = new Date().toISOString().slice(0, 10);
    openModal('modal-service');
    loadServicesForDate(input.value, false);
  }

  $('service-date-input')?.addEventListener('change', (e) => loadServicesForDate(e.target.value, false));

  async function loadServicesForDate(date, silent) {
    const list = $('service-list');
    if (!state.settings.churchToolsUrl || !state.settings.churchToolsTokenSet) {
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
      return;
    }
    list.innerHTML = '';
    if (res.services.length === 0) {
      list.innerHTML = '<div class="empty">Keine Termine an diesem Tag.</div>';
      return;
    }
    res.services.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = '<span class="name"></span><span class="meta"></span>';
      el.querySelector('.name').textContent = s.name;
      el.querySelector('.meta').textContent = (s.start || '').slice(11, 16);
      el.addEventListener('click', () => chooseService(s, false));
      list.appendChild(el);
    });
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
    await window.api.session.setService({ name, date: new Date().toISOString().slice(0, 10) });
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
      el.querySelector('.meta').textContent = `${s.date} · ${fmt(s.duration)} · ${s.markerCount} Marker`;
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

  async function refreshDevices() {
    const sel = $('set-device');
    sel.innerHTML = '';
    try {
      const devices = await window.Capture.listDevices();
      if (devices.length === 0) {
        sel.innerHTML = '<option value="">Kein Eingang gefunden</option>';
        return;
      }
      devices.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.label;
        sel.appendChild(opt);
      });
      if (state.settings.inputDeviceId) sel.value = state.settings.inputDeviceId;
    } catch (err) {
      sel.innerHTML = '<option value="">Zugriff auf Audiogeräte fehlgeschlagen</option>';
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
      waveformZoom: wave ? wave.pxPerSec : 12
    };
    const token = $('set-ct-token').value;
    if (token) patch.churchToolsToken = token;

    const res = await window.api.settings.set(patch);
    if (!res.ok) return toast('error', res.error);
    state.settings = res.settings;
    $('set-ct-token').value = '';
    applySettingsToForm();
    if (!keepOpen) {
      $('modal-settings').hidden = true;
      toast('success', 'Einstellungen gespeichert.');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
