'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setSettings, src } = require('./helpers');

setSettings({ churchToolsUrl: 'https://x.church.tools', churchToolsCalendarIds: [] });
const ct = require(src('main/churchtools'));

let routes = {};
global.fetch = async (url) => {
  const u = new URL(url);
  const key = u.pathname + (u.searchParams.get('page') ? `?page=${u.searchParams.get('page')}` : '');
  const body = routes[key] ?? routes[u.pathname];
  if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => body };
};

test('Termine über mehrere Seiten, Kalender-Filter', async () => {
  routes = {
    '/api/events?page=1': { data: [{ id: 1, name: 'A', startDate: '2026-10-04T08:00:00Z', calendar: { id: 2 } }], meta: { pagination: { lastPage: 2 } } },
    '/api/events?page=2': { data: [{ id: 2, name: 'B', startDate: '2026-10-05T08:00:00Z', calendar: { id: 5 } }], meta: { pagination: { lastPage: 2 } } }
  };
  setSettings({ churchToolsUrl: 'https://x.church.tools', churchToolsCalendarIds: [] });
  assert.deepEqual((await ct.listServices('a', 'b')).map((x) => x.name), ['A', 'B']);
  setSettings({ churchToolsUrl: 'https://x.church.tools', churchToolsCalendarIds: [5] });
  assert.deepEqual((await ct.listServices('a', 'b')).map((x) => x.name), ['B']);
});

test('Ablaufplan: flache Überschriften werden zur Kategorie, Person zum Interpreten', async () => {
  routes = {
    '/api/events/9/agenda': {
      data: {
        items: [
          { type: 'header', title: 'Eingang' },
          { id: 1, title: 'Begrüßung', responsible: { text: 'Anna', persons: [{ person: { domainAttributes: { firstName: 'Anna', lastName: 'Beispiel' } } }] } },
          { type: 'header', title: 'Verkündigung' },
          { id: 2, title: 'Predigt', responsible: 'Ben Muster' }
        ]
      }
    }
  };
  const plan = await ct.agenda(9);
  assert.deepEqual(plan.items.map((x) => [x.title, x.category, x.responsible]),
    [['Begrüßung', 'Eingang', 'Anna Beispiel'], ['Predigt', 'Verkündigung', 'Ben Muster']]);
});

test('Dienstplanung: Personen der gewünschten Dienste', async () => {
  ct.resetCache();
  routes = {
    '/api/services': { data: [{ id: 1, name: 'Leitung' }, { id: 2, name: 'Predigt' }, { id: 3, name: 'Technik' }] },
    '/api/events/10': { data: { eventServices: [{ serviceId: 1, name: 'Anna' }, { serviceId: 2, person: { domainAttributes: { firstName: 'Ben', lastName: 'M' } } }, { serviceId: 3, name: 'Cara' }] } }
  };
  const res = await ct.eventServices(10, ['Leitung', 'Predigt']);
  assert.deepEqual(res.suggestions, [{ role: 'Leitung', name: 'Anna' }, { role: 'Predigt', name: 'Ben M' }]);
});

test('Infotext des Termins: erste Zeile, ohne HTML und doppelte Leerzeichen', async () => {
  assert.equal(ct.eventInfoText({ description: '<p>Kolosser 2,6-7  Verwurzelt in Christus</p><p>Bitte Bibel mitbringen</p>' }), 'Kolosser 2,6-7 Verwurzelt in Christus');
  assert.equal(ct.eventInfoText({ description: '', note: 'Kolosser 2,6-7\nweiter' }), 'Kolosser 2,6-7');
  assert.equal(ct.eventInfoText({ name: 'x' }), null);
  assert.equal(ct.eventInfoText(null), null);
  ct.resetCache();
  routes = { '/api/events/12': { data: { description: 'Römer 8', eventServices: [] } } };
  assert.equal((await ct.eventServices(12, [])).info, 'Römer 8');
});

test('404 trägt den Status, kaputte Antwort eine klare Meldung', async () => {
  routes = {};
  await assert.rejects(ct.agenda(77), (err) => err.status === 404);
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } });
  await assert.rejects(ct.listCalendars(), /keine gültige Antwort/);
});
