'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { src } = require('./helpers');
const { roleMatchesLabel, namesForLabel } = require(src('shared/roles'));

test('ganze Wörter, Zahlen zählen nicht', () => {
  assert.equal(roleMatchesLabel('Predigt 2', 'Predigt'), true);
  assert.equal(roleMatchesLabel('Leitung', 'Einleitung'), false);
  assert.equal(roleMatchesLabel('Predigt 2', 'Lied 2'), false);
  assert.equal(roleMatchesLabel('Leitung', 'Begrüßung und Leitung'), true);
});

test('Namen ohne Doppelte', () => {
  const sug = [{ role: 'Predigt', name: 'Ben' }, { role: 'Predigt 2', name: 'Cara' }, { role: 'Leitung', name: 'Ben' }];
  assert.deepEqual(namesForLabel('Predigt', sug), ['Ben', 'Cara']);
});
