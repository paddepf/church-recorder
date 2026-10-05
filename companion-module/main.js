import { InstanceBase, InstanceStatus, Regex, runEntrypoint, combineRgb } from '@companion-module/base'
import WebSocket from 'ws'

class GottesdienstRecorderInstance extends InstanceBase {
	async init(config) {
		this.config = config
		this.state = null
		this.msgId = 0

		this.setActionDefinitions(this.buildActions())
		this.setFeedbackDefinitions(this.buildFeedbacks())
		this.setVariableDefinitions(this.buildVariables())
		this.setPresetDefinitions(this.buildPresets())
		this.resetVariables()

		this.connect()
	}

	async configUpdated(config) {
		this.config = config
		this.authFailed = false
		this.disconnect()
		this.connect()
	}

	async destroy() {
		this.disconnect()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'ChurchRecorder',
				value:
					'Verbindet sich mit der Netzwerkschnittstelle von ChurchRecorder. ' +
					'Port und Passwort stehen dort in den Einstellungen unter „Netzwerk".',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Adresse des Aufnahmerechners',
				width: 8,
				default: '127.0.0.1',
				regex: Regex.HOSTNAME,
			},
			{
				type: 'number',
				id: 'port',
				label: 'Port',
				width: 4,
				default: 8765,
				min: 1024,
				max: 65535,
			},
			{
				type: 'textinput',
				id: 'password',
				label: 'Passwort für Steuerung',
				width: 12,
				default: '',
			},
		]
	}

	/* ------------------------------------------------------------ Verbindung */

	connect() {
		if (!this.config?.host || !this.config?.port) {
			this.updateStatus(InstanceStatus.BadConfig, 'Adresse oder Port fehlt')
			return
		}
		if (!this.config.password) {
			this.updateStatus(InstanceStatus.BadConfig, 'Passwort fehlt')
			return
		}

		this.updateStatus(InstanceStatus.Connecting)
		const url = `ws://${this.config.host}:${this.config.port}/`

		try {
			this.ws = new WebSocket(url)
		} catch (err) {
			this.updateStatus(InstanceStatus.ConnectionFailure, String(err.message))
			this.scheduleReconnect()
			return
		}

		this.ws.on('open', () => {
			this.lastError = null
			this.send({ type: 'auth', password: this.config.password })
			this.startHeartbeat()
		})

		this.ws.on('message', (raw) => {
			let msg
			try {
				msg = JSON.parse(raw.toString())
			} catch {
				return
			}
			this.handleMessage(msg)
		})

		this.ws.on('close', () => {
			this.authed = false
			this.stopHeartbeat()
			this.clearState()
			// Nach falschem Passwort nicht ständig neu versuchen: erst wieder nach Änderung der Einstellungen.
			if (this.authFailed) return
			// Eine konkrete Fehlermeldung (z. B. Verbindung abgelehnt) nicht mit "getrennt" überschreiben.
			if (this.lastError) this.updateStatus(InstanceStatus.ConnectionFailure, this.lastError)
			else this.updateStatus(InstanceStatus.Disconnected)
			this.scheduleReconnect()
		})

		this.ws.on('error', (err) => {
			this.log('debug', `WebSocket-Fehler: ${err.message}`)
			this.lastError = err.message
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})
	}

	/**
	 * Eigener Herzschlag: Fällt der Aufnahmerechner hart weg (Strom, WLAN), bemerkt das ein offener
	 * WebSocket sonst erst nach Minuten. Bleibt die Antwort auf ein ping aus, wird neu verbunden.
	 */
	startHeartbeat() {
		this.stopHeartbeat()
		this.awaitingPong = false
		this.heartbeat = setInterval(() => {
			if (this.awaitingPong) {
				this.log('warn', 'Recorder antwortet nicht mehr – Verbindung wird neu aufgebaut.')
				this.lastError = 'Recorder antwortet nicht'
				try {
					this.ws?.terminate()
				} catch {
					/* bereits zu */
				}
				return
			}
			this.awaitingPong = true
			this.send({ type: 'ping', id: ++this.msgId })
		}, 10000)
	}

	stopHeartbeat() {
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.heartbeat = null
		this.awaitingPong = false
	}

	/** Nach einer Trennung nichts Veraltetes anzeigen (z. B. rote "Aufnahme"-Taste). */
	clearState() {
		this.state = null
		this.resetVariables()
		this.checkFeedbacks()
	}

	disconnect() {
		this.stopHeartbeat()
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
		if (this.ws) {
			this.ws.removeAllListeners()
			try {
				this.ws.close()
			} catch {
				/* Verbindung war bereits zu */
			}
			this.ws = null
		}
		this.authed = false
	}

	scheduleReconnect() {
		if (this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.connect()
		}, 5000)
	}

	send(obj) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
		this.ws.send(JSON.stringify(obj))
		return true
	}

	command(action, params) {
		if (!this.authed) {
			this.log('warn', 'Nicht mit dem Recorder verbunden – Befehl verworfen.')
			return
		}
		const id = ++this.msgId
		this.send({ type: 'command', id, action, params: params || {} })
	}

	handleMessage(msg) {
		switch (msg.type) {
			case 'auth':
				if (msg.ok) {
					this.authed = true
					if (msg.role === 'monitor') {
						// Mit dem Mitlese-Passwort kommen Status und Variablen an, Befehle aber nicht.
						this.updateStatus(InstanceStatus.BadConfig, 'Passwort ist nur zum Mitlesen – Tasten steuern nichts')
					} else {
						this.updateStatus(InstanceStatus.Ok)
					}
					this.send({ type: 'get_state', id: ++this.msgId })
				}
				break

			case 'pong':
				this.awaitingPong = false
				break

			case 'state':
				this.state = msg.payload
				this.applyState()
				break

			case 'levels':
				if (this.state) this.state.levels = msg.payload
				this.setVariableValues({
					level_left: Math.round((msg.payload.l || 0) * 100),
					level_right: Math.round((msg.payload.r || 0) * 100),
					clipping: msg.payload.clip ? 'ja' : 'nein',
					timecode: this.formatTime(msg.payload.duration || 0),
				})
				this.checkFeedbacks('clipping')
				break

			case 'result':
				if (msg.ok === false) this.log('warn', `Befehl abgelehnt: ${msg.error}`)
				break

			case 'error':
				if (msg.code === 'auth_failed') {
					this.authFailed = true
					this.updateStatus(InstanceStatus.AuthenticationFailure, 'Passwort ist falsch')
					this.disconnect()
				} else {
					this.log('warn', `Recorder meldet: ${msg.message}`)
				}
				break

			default:
				break
		}
	}

	/* -------------------------------------------------------------- Variablen */

	buildVariables() {
		return [
			{ variableId: 'status', name: 'Aufnahmestatus (Text)' },
			{ variableId: 'timecode', name: 'Laufzeit' },
			{ variableId: 'service_name', name: 'Name des Gottesdienstes' },
			{ variableId: 'current_item', name: 'Aktueller Programmpunkt' },
			{ variableId: 'next_item', name: 'Nächster offener Programmpunkt' },
			{ variableId: 'marker_count', name: 'Anzahl gesetzter Abschnitte' },
			{ variableId: 'pending_count', name: 'Anzahl offener Programmpunkte' },
			{ variableId: 'level_left', name: 'Pegel links (0-100)' },
			{ variableId: 'level_right', name: 'Pegel rechts (0-100)' },
			{ variableId: 'clipping', name: 'Übersteuerung (ja/nein)' },
			{ variableId: 'input_status', name: 'Eingang (ok / leise / ausgefallen)' },
			{ variableId: 'disk_free', name: 'Freier Speicherplatz (GB)' },
			{ variableId: 'disk_hours', name: 'Aufnahmestunden, die noch Platz haben' },
			{ variableId: 'cut_open', name: 'Schnitt läuft gerade (ja/nein)' },
		]
	}

	resetVariables() {
		this.setVariableValues({
			status: 'getrennt',
			timecode: '00:00:00',
			service_name: '-',
			current_item: '-',
			next_item: '-',
			marker_count: 0,
			pending_count: 0,
			level_left: 0,
			level_right: 0,
			clipping: 'nein',
			input_status: '-',
			disk_free: '-',
			disk_hours: '-',
			cut_open: 'nein',
		})
	}

	applyState() {
		const s = this.state
		if (!s) return
		const labels = {
			idle: 'bereit',
			recording: 'Aufnahme',
			paused: 'pausiert',
			stopped: 'beendet',
		}
		// Offene Punkte in der Reihenfolge des Ablaufplans (die App sortiert nach "order")
		const pending = (s.pending || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0))
		this.setVariableValues({
			status: labels[s.status] || s.status,
			timecode: this.formatTime(s.duration || 0),
			service_name: s.service?.name || '-',
			current_item: s.currentSegment?.label || '-',
			next_item: pending.length > 0 ? pending[0].label : '-',
			marker_count: (s.sections || []).filter((x) => x.start != null).length,
			pending_count: pending.length,
			input_status: { ok: 'ok', silent: 'leise', lost: 'ausgefallen' }[s.health?.input] || '-',
			disk_free: s.health?.disk ? (s.health.disk.freeBytes / 1073741824).toFixed(1) : '-',
			disk_hours: s.health?.disk ? this.formatHours(s.health.disk.hoursLeft) : '-',
			cut_open: (s.cuts || []).some((c) => c.end == null) ? 'ja' : 'nein',
		})
		this.checkFeedbacks('recording', 'paused', 'has_pending', 'input_problem', 'disk_warn', 'disk_low', 'cut_open')
	}

	formatHours(h) {
		if (h >= 10) return `${Math.round(h)} h`
		if (h >= 1) return `${h.toFixed(1)} h`
		return `${Math.max(0, Math.round(h * 60))} min`
	}

	formatTime(t) {
		const p = (n) => String(Math.floor(n)).padStart(2, '0')
		return `${p(t / 3600)}:${p((t % 3600) / 60)}:${p(t % 60)}`
	}

	/* --------------------------------------------------------------- Aktionen */

	buildActions() {
		return {
			record_start: {
				name: 'Aufnahme starten',
				options: [],
				callback: () => this.command('record.start'),
			},
			record_stop: {
				name: 'Aufnahme beenden',
				options: [],
				callback: () => this.command('record.stop'),
			},
			record_toggle: {
				name: 'Aufnahme starten/beenden',
				options: [],
				callback: () => this.command('record.toggle'),
			},
			record_pause: {
				name: 'Aufnahme pausieren',
				options: [],
				callback: () => this.command('record.pause'),
			},
			record_resume: {
				name: 'Aufnahme fortsetzen',
				options: [],
				callback: () => this.command('record.resume'),
			},
			record_pause_toggle: {
				name: 'Pause umschalten',
				options: [],
				callback: () => {
					if (this.state?.status === 'paused') this.command('record.resume')
					else this.command('record.pause')
				},
			},
			marker_add: {
				name: 'Abschnitt starten / beenden',
				options: [
					{
						type: 'textinput',
						id: 'label',
						label: 'Bezeichnung (beim Start, leer = automatisch nummeriert)',
						default: '',
						useVariables: true,
					},
				],
				callback: async (action, context) => {
					const label = (await context.parseVariablesInString(action.options.label || '')).trim()
					this.command('marker.add', label ? { label } : {})
				},
			},
			marker_next: {
				name: 'Nächster Programmpunkt beginnt hier (beendet den laufenden Abschnitt)',
				options: [],
				callback: () => this.command('marker.next'),
			},
			cut_toggle: {
				name: 'Schnitt starten / beenden (Stelle fehlt im MP3)',
				options: [],
				callback: () => this.command('cut.toggle'),
			},
			undo: {
				name: 'Rückgängig',
				options: [],
				callback: () => this.command('undo'),
			},
			redo: {
				name: 'Wiederholen',
				options: [],
				callback: () => this.command('redo'),
			},
			template_apply: {
				name: 'Vorlage für Programmpunkte laden',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name der Vorlage (leer = Standardvorlage)',
						default: '',
						useVariables: true,
					},
				],
				callback: async (action, context) => {
					const name = await context.parseVariablesInString(action.options.name || '')
					this.command('template.apply', name ? { name } : {})
				},
			},
		}
	}

	/* -------------------------------------------------------------- Feedbacks */

	buildFeedbacks() {
		return {
			recording: {
				type: 'boolean',
				name: 'Aufnahme läuft',
				description: 'Färbt den Button, solange aufgenommen wird',
				defaultStyle: {
					bgcolor: combineRgb(200, 0, 0),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => this.state?.status === 'recording',
			},
			paused: {
				type: 'boolean',
				name: 'Aufnahme pausiert',
				defaultStyle: {
					bgcolor: combineRgb(200, 130, 0),
					color: combineRgb(0, 0, 0),
				},
				options: [],
				callback: () => this.state?.status === 'paused',
			},
			has_pending: {
				type: 'boolean',
				name: 'Es gibt offene Programmpunkte',
				defaultStyle: {
					bgcolor: combineRgb(40, 60, 160),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => (this.state?.pending || []).length > 0,
			},
			input_problem: {
				type: 'boolean',
				name: 'Eingang leise oder ausgefallen',
				description: 'Wird aktiv, wenn länger kaum Pegel anliegt oder der Eingang neu verbunden werden muss',
				defaultStyle: {
					bgcolor: combineRgb(220, 40, 30),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => ['silent', 'lost'].includes(this.state?.health?.input),
			},
			disk_warn: {
				type: 'boolean',
				name: 'Speicherplatz wird knapp (unter 3 Stunden)',
				defaultStyle: {
					bgcolor: combineRgb(240, 120, 0),
					color: combineRgb(0, 0, 0),
				},
				options: [],
				callback: () => ['warn', 'low'].includes(this.state?.health?.disk?.level),
			},
			disk_low: {
				type: 'boolean',
				name: 'Speicherplatz fast voll (unter 30 Minuten)',
				defaultStyle: {
					bgcolor: combineRgb(220, 40, 30),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => this.state?.health?.disk?.level === 'low',
			},
			cut_open: {
				type: 'boolean',
				name: 'Schnitt läuft gerade',
				defaultStyle: {
					bgcolor: combineRgb(160, 30, 120),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => (this.state?.cuts || []).some((c) => c.end == null),
			},
			clipping: {
				type: 'boolean',
				name: 'Eingang übersteuert',
				defaultStyle: {
					bgcolor: combineRgb(235, 210, 0),
					color: combineRgb(0, 0, 0),
				},
				options: [],
				callback: () => Boolean(this.state?.levels?.clip),
			},
		}
	}

	/* ---------------------------------------------------------------- Presets */

	buildPresets() {
		// Boolean-Feedbacks brauchen in Presets einen eigenen Stil, sonst färbt sich die Taste nicht.
		const feedbackDefs = this.buildFeedbacks()
		const fb = (id) => ({ feedbackId: id, options: {}, style: { ...feedbackDefs[id].defaultStyle } })
		const base = {
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		}

		return {
			record_toggle: {
				type: 'button',
				category: 'Aufnahme',
				name: 'Aufnahme starten/beenden',
				style: { ...base, text: 'REC\\n$(churchrecorder:timecode)' },
				steps: [{ down: [{ actionId: 'record_toggle' }], up: [] }],
				feedbacks: [fb('recording')],
			},
			pause: {
				type: 'button',
				category: 'Aufnahme',
				name: 'Pause umschalten',
				style: { ...base, text: 'Pause' },
				steps: [{ down: [{ actionId: 'record_pause_toggle' }], up: [] }],
				feedbacks: [fb('paused')],
			},
			marker: {
				type: 'button',
				category: 'Abschnitte',
				name: 'Abschnitt starten / beenden',
				style: { ...base, text: 'Abschnitt\\nStart/Ende' },
				steps: [{ down: [{ actionId: 'marker_add', options: { label: '' } }], up: [] }],
				feedbacks: [],
			},
			marker_predigt: {
				type: 'button',
				category: 'Abschnitte',
				name: 'Abschnitt „Predigt" starten / beenden',
				style: { ...base, text: 'Predigt' },
				steps: [{ down: [{ actionId: 'marker_add', options: { label: 'Predigt' } }], up: [] }],
				feedbacks: [],
			},
			next_item: {
				type: 'button',
				category: 'Ablaufplan',
				name: 'Nächster Programmpunkt',
				style: { ...base, text: 'Weiter\\n$(churchrecorder:next_item)' },
				steps: [{ down: [{ actionId: 'marker_next' }], up: [] }],
				feedbacks: [fb('has_pending')],
			},
			cut: {
				type: 'button',
				category: 'Abschnitte',
				name: 'Schnitt starten / beenden',
				style: { ...base, text: 'Schnitt\\nStart/Ende' },
				steps: [{ down: [{ actionId: 'cut_toggle' }], up: [] }],
				feedbacks: [fb('cut_open')],
			},
			undo: {
				type: 'button',
				category: 'Abschnitte',
				name: 'Rückgängig',
				style: { ...base, text: 'Rück-\\ngängig' },
				steps: [{ down: [{ actionId: 'undo' }], up: [] }],
				feedbacks: [],
			},
			health: {
				type: 'button',
				category: 'Anzeige',
				name: 'Eingang und Speicher',
				style: {
					...base,
					size: '7',
					text: 'Eingang: $(churchrecorder:input_status)\\nSpeicher: $(churchrecorder:disk_free) GB\\n$(churchrecorder:disk_hours)',
				},
				steps: [{ down: [], up: [] }],
				feedbacks: [fb('input_problem'), fb('disk_warn'), fb('disk_low')],
			},
			status: {
				type: 'button',
				category: 'Anzeige',
				name: 'Statusanzeige',
				style: {
					...base,
					size: '7',
					text: '$(churchrecorder:status)\\n$(churchrecorder:timecode)\\n$(churchrecorder:current_item)',
				},
				steps: [{ down: [], up: [] }],
				feedbacks: [fb('recording')],
			},
		}
	}
}

runEntrypoint(GottesdienstRecorderInstance, [])
