'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { src } = require('./helpers');
const { roleMatchesLabel, namesForLabel, templateForTitle } = require(src('shared/roles'));

test('ganze Wörter, Zahlen zählen nicht', () => {
  assert.equal(roleMatchesLabel('Predigt 2', 'Predigt'), true);
  assert.equal(roleMatchesLabel('Gebetsleitung', 'Einleitung'), false);
  assert.equal(roleMatchesLabel('Predigt', 'Einleitung'), false);
  assert.equal(roleMatchesLabel('Predigt 2', 'Lied 2'), false);
  assert.equal(roleMatchesLabel('Leitung', 'Begrüßung und Leitung'), true);
});

test('Dienst Leitung gehört zu Einleitung und Abschluss', () => {
  assert.equal(roleMatchesLabel('Leitung', 'Einleitung'), true);
  assert.equal(roleMatchesLabel('Leitung', 'Abschluss'), true);
  assert.equal(roleMatchesLabel('Leitung', 'Predigt'), false);
  assert.deepEqual(namesForLabel('Abschluss', [{ role: 'Leitung', name: 'Eva' }, { role: 'Predigt', name: 'Ben' }]), ['Eva']);
});

test('Dienst Geschichte gehört zum Kinderbeitrag', () => {
  assert.equal(roleMatchesLabel('Geschichte', 'Kinderbeitrag'), true);
  assert.equal(roleMatchesLabel('Geschichte 2', 'Kinderbeitrag'), true);
  assert.equal(roleMatchesLabel('Geschichte', 'Predigt'), false);
  assert.deepEqual(namesForLabel('Kinderbeitrag', [{ role: 'Geschichte', name: 'Dora' }, { role: 'Predigt', name: 'Ben' }]), ['Dora']);
});

test('Namen ohne Doppelte', () => {
  const sug = [{ role: 'Predigt', name: 'Ben' }, { role: 'Predigt 2', name: 'Cara' }, { role: 'Leitung', name: 'Ben' }];
  assert.deepEqual(namesForLabel('Predigt', sug), ['Ben', 'Cara']);
});

test('Vorlage passend zum Gottesdienst-Titel', () => {
  const tpls = [
    { id: 'a', name: 'Gottesdienst', items: [] },
    { id: 'b', name: 'Bibelstunde', items: [] },
    { id: 'c', name: 'Bibelstunde Jugend', items: [] }
  ];
  assert.equal(templateForTitle(tpls, 'Bibelstunde').id, 'b');
  assert.equal(templateForTitle(tpls, 'bibelstunde im Gemeindehaus').id, 'b');
  assert.equal(templateForTitle(tpls, 'Bibelstunde Jugend').id, 'c');
  assert.equal(templateForTitle(tpls, 'Sonntagsgottesdienst'), null);
  assert.equal(templateForTitle([], 'Bibelstunde'), null);
});
