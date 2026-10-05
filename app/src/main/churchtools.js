'use strict';

const settings = require('./settings');

/**
 * Minimaler ChurchTools-Client.
 * Authentifizierung über Personal Access Token:  Authorization: Login <token>
 */

function baseUrl() {
  const url = (settings.get('churchToolsUrl') || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Es ist keine ChurchTools-Adresse hinterlegt.');
  return url;
}

async function request(pathname, params) {
  const token = settings.churchToolsToken();
  if (!token) throw new Error('Es ist kein ChurchTools-Token hinterlegt.');

  const url = new URL(baseUrl() + pathname);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k + '[]', x));
    else url.searchParams.set(k, v);
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Login ${token}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('ChurchTools antwortet nicht (Zeitüberschreitung).');
    throw new Error('ChurchTools ist nicht erreichbar: ' + err.message);
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('ChurchTools hat den Zugriff abgelehnt. Bitte Token prüfen.');
  }
  if (!res.ok) {
    const err = new Error(`ChurchTools meldet Fehler ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json.data !== undefined ? json.data : json;
}

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Verbindung und Token prüfen. */
async function test() {
  const me = await request('/api/whoami');
  return {
    ok: true,
    name: me?.firstName ? `${me.firstName} ${me.lastName || ''}`.trim() : (me?.cmsUserId || 'Unbekannt')
  };
}

/**
 * Gottesdienste/Termine in einem Zeitraum.
 * @param {string} from ISO-Datum
 * @param {string} to   ISO-Datum
 */
async function listServices(from, to) {
  const data = await request('/api/events', { from, to });
  const list = Array.isArray(data) ? data : [];
  return list
    .map((e) => ({
      id: e.id,
      name: e.name || e.caption || 'Gottesdienst',
      start: e.startDate || e.start_date || null,
      end: e.endDate || null,
      date: (e.startDate || '').slice(0, 10) || from
    }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

/** Gottesdienste von heute (mit Vorschlag des nächstliegenden). */
async function todaysServices() {
  const today = isoDate(new Date());
  const list = await listServices(today, today);
  return { date: today, services: list };
}

/**
 * Ablaufplan eines Termins.
 * Liefert eine flache Liste von Programmpunkten in Reihenfolge.
 */
async function agenda(eventId) {
  const data = await request(`/api/events/${eventId}/agenda`);
  const items = data?.items || data?.agendaItems || [];
  const flat = [];

  const walk = (list, headerTitle) => {
    (list || []).forEach((item) => {
      const title = item.title || item.bezeichnung || 'Programmpunkt';
      if (item.type === 'header' || item.isHeader) {
        walk(item.items || item.children, title);
        return;
      }
      flat.push({
        id: item.id ?? null,
        title,
        category: headerTitle || item.serviceCategoryName || null,
        duration: item.duration ?? null,
        responsible: responsibleText(item),
        position: item.position ?? flat.length
      });
      if (item.items || item.children) walk(item.items || item.children, title);
    });
  };

  walk(items, null);
  flat.sort((a, b) => (a.position || 0) - (b.position || 0));
  return {
    id: data?.id ?? null,
    name: data?.name || null,
    items: flat
  };
}

/* ------------------------------------------------------- Personen und Dienste */

/** Name einer Person aus den verschiedenen Formen, in denen ChurchTools sie liefern kann. */
function personName(p) {
  if (!p) return '';
  if (typeof p === 'string') return p.trim();
  const inner = p.person || p;
  const attrs = inner.domainAttributes || inner;
  const full = [attrs.firstName || attrs.vorname, attrs.lastName || attrs.name_nachname || attrs.nachname]
    .filter(Boolean).join(' ').trim();
  return full || String(inner.title || inner.text || inner.displayName || '').trim();
}

/** Zuständige Person(en) eines Ablaufpunkts als Text, z. B. "Anna Beispiel, Ben Muster". */
function responsibleText(item) {
  const r = item.responsible ?? item.responsibles ?? item.responsiblePersons;
  if (!r) return null;
  const names = [];
  if (typeof r === 'string') names.push(r);
  else if (Array.isArray(r)) r.forEach((p) => names.push(personName(p)));
  else {
    // Verknüpfte Personen haben Vorrang vor dem Freitext (der meist denselben Namen trägt).
    if (Array.isArray(r.persons)) r.persons.forEach((p) => names.push(personName(p)));
    if (!names.some(Boolean) && r.text) names.push(String(r.text));
    if (!names.some(Boolean)) names.push(personName(r));
  }
  const unique = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  return unique.length ? unique.join(', ') : null;
}

let servicesCache = null;

/** Alle Dienste (Id -> Name), z. B. "Leitung", "Predigt". */
async function serviceNames() {
  if (servicesCache) return servicesCache;
  const data = await request('/api/services');
  const map = {};
  (Array.isArray(data) ? data : []).forEach((s) => { map[s.id] = s.name; });
  servicesCache = map;
  return map;
}

/**
 * Personen, die für einen Termin in der Dienstplanung eingetragen sind – gefiltert auf die
 * gewünschten Dienste (z. B. "Leitung", "Predigt"; Teilübereinstimmung, ohne Groß-/Kleinschreibung).
 * @returns {{suggestions: {role:string, name:string}[], found: number}}
 */
async function eventServices(eventId, wanted) {
  const wantedList = (wanted || []).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  if (wantedList.length === 0) return { suggestions: [], found: 0 };

  const event = await request(`/api/events/${eventId}`, { include: 'eventServices' });
  const entries = event?.eventServices || event?.services || [];
  let names = {};
  try { names = await serviceNames(); } catch { /* Dienstnamen fehlen: dann nur Einträge mit eigenem Namen */ }

  const out = [];
  for (const es of entries) {
    const role = String(es.serviceName || names[es.serviceId] || es.service?.name || '').trim();
    if (!role || !wantedList.some((w) => role.toLowerCase().includes(w))) continue;
    let name = personName(es.person);
    // Manche Antworten tragen den Personennamen direkt unter "name"
    if (!name && es.name && String(es.name).trim().toLowerCase() !== role.toLowerCase()) name = String(es.name).trim();
    if (!name && es.personId) {
      try { name = personName(await request(`/api/persons/${es.personId}`)); } catch { /* ohne Namen überspringen */ }
    }
    if (name) out.push({ role, name });
  }
  return { suggestions: out, found: entries.length };
}

module.exports = { test, listServices, todaysServices, agenda, eventServices, isoDate };
