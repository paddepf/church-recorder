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
    throw new Error(`ChurchTools meldet Fehler ${res.status}.`);
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

module.exports = { test, listServices, todaysServices, agenda, isoDate };
