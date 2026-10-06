'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { src } = require('./helpers');
const { moveEdge } = require(src('shared/sections'));

const make = () => [{ id: 'a', start: 0, end: 10 }, { id: 'b', start: 10, end: 20 }, { id: 'c', start: 25, end: 30 }];

test('Anfang nach links schiebt das Ende des Vorgängers mit', () => {
  const s = make();
  assert.equal(moveEdge(s, 'b', 'start', 5, 40).time, 5);
  assert.equal(s[0].end, 5);
});

test('Ende nach rechts schiebt den Anfang des Nachfolgers mit', () => {
  const s = make();
  moveEdge(s, 'b', 'end', 27, 40);
  assert.equal(s[2].start, 27);
});

test('kein Abschnitt wird kürzer als 0,1 s', () => {
  const s = make();
  assert.equal(moveEdge(s, 'b', 'start', -3, 40).time, 0.1);
  assert.equal(moveEdge(s, 'b', 'end', 40, 40).time, 29.9);
});

test('Verkürzen schiebt niemanden', () => {
  const s = make();
  moveEdge(s, 'b', 'start', 14, 40);
  assert.deepEqual(s.map((x) => [x.start, x.end]), [[0, 10], [14, 20], [25, 30]]);
});
