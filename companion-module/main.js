import { InstanceBase, InstanceStatus, Regex, runEntrypoint, combineRgb } from '@companion-module/base'
import WebSocket from 'ws'

class GottesdienstRecorderInstance extends InstanceBase {
	async init(config) {
		this.config = config
		this.state = null
		this.msgId = 0
		this.pending = new Map()

		this.setActionDefinitions(this.buildActions())
		this.setFeedbackDefinitions(this.buildFeedbacks())
		this.setVariableDefinitions(this.buildVariables())
		this.setPresetDefinitions(this.buildPresets())
		this.resetVariables()

		this.connect()
	}

	async configUpdated(config) {
		this.config = config
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
			this.send({ type: 'auth', password: this.config.password })
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
			this.updateStatus(InstanceStatus.Disconnected)
			this.scheduleReconnect()
		})

		this.ws.on('error', (err) => {
			this.log('debug', `WebSocket-Fehler: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})
	}

	disconnect() {
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
					this.updateStatus(InstanceStatus.Ok)
					this.send({ type: 'get_state', id: ++this.msgId })
				}
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
					this.updateStatus(InstanceStatus.AuthenticationFailure, 'Passwort ist falsch')
					this.disconnect()
					this.scheduleReconnect()
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
			{ variableId: 'marker_count', name: 'Anzahl gesetzter Marker' },
			{ variableId: 'pending_count', name: 'Anzahl offener Programmpunkte' },
			{ variableId: 'level_left', name: 'Pegel links (0-100)' },
			{ variableId: 'level_right', name: 'Pegel rechts (0-100)' },
			{ variableId: 'clipping', name: 'Übersteuerung (ja/nein)' },
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
		const pending = s.pending || []
		this.setVariableValues({
			status: labels[s.status] || s.status,
			timecode: this.formatTime(s.duration || 0),
			service_name: s.service?.name || '-',
			current_item: s.currentSegment?.label || '-',
			next_item: pending.length > 0 ? pending[0].label : '-',
			marker_count: (s.markers || []).filter((m) => m.placed).length,
			pending_count: pending.length,
		})
		this.checkFeedbacks('recording', 'paused', 'has_pending')
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
				name: 'Marker setzen',
				options: [
					{
						type: 'textinput',
						id: 'label',
						label: 'Bezeichnung',
						default: 'Marker',
						useVariables: true,
					},
				],
				callback: async (action, context) => {
					const label = await context.parseVariablesInString(action.options.label || 'Marker')
					this.command('marker.add', { label })
				},
			},
			marker_next: {
				name: 'Nächster Programmpunkt beginnt hier',
				options: [],
				callback: () => this.command('marker.next'),
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
			clipping: {
				type: 'boolean',
				name: 'Eingang übersteuert',
				defaultStyle: {
					bgcolor: combineRgb(230, 160, 0),
					color: combineRgb(0, 0, 0),
				},
				options: [],
				callback: () => Boolean(this.state?.levels?.clip),
			},
		}
	}

	/* ---------------------------------------------------------------- Presets */

	buildPresets() {
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
				feedbacks: [{ feedbackId: 'recording' }],
			},
			pause: {
				type: 'button',
				category: 'Aufnahme',
				name: 'Pause umschalten',
				style: { ...base, text: 'Pause' },
				steps: [{ down: [{ actionId: 'record_pause_toggle' }], up: [] }],
				feedbacks: [{ feedbackId: 'paused' }],
			},
			marker: {
				type: 'button',
				category: 'Marker',
				name: 'Marker setzen',
				style: { ...base, text: 'Marker\\nsetzen' },
				steps: [{ down: [{ actionId: 'marker_add', options: { label: 'Marker' } }], up: [] }],
				feedbacks: [],
			},
			marker_predigt: {
				type: 'button',
				category: 'Marker',
				name: 'Marker „Predigt"',
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
				feedbacks: [{ feedbackId: 'has_pending' }],
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
				feedbacks: [{ feedbackId: 'recording' }],
			},
		}
	}
}

runEntrypoint(GottesdienstRecorderInstance, [])
