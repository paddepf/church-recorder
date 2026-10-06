'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { src } = require('./helpers');
const { buildId3v2 } = require(src('main/id3'));

test('Rahmen mit UTF-16-Texten', () => {
  const tag = buildId3v2({ title: 'Größe', artist: 'Müller' });
  assert.equal(tag.toString('ascii', 0, 3), 'ID3');
  let pos = 10;
  const frames = {};
  while (pos < tag.length) {
    const id = tag.toString('ascii', pos, pos + 4);
    const n = tag.readUInt32BE(pos + 4);
    frames[id] = tag.subarray(pos + 11, pos + 10 + n).toString('utf16le').replace(/\u0000+$/, '').replace(/^﻿/, '');
    pos += 10 + n;
  }
  assert.equal(frames.TIT2, 'Größe');
  assert.equal(frames.TPE1, 'Müller');
});

test('ohne Angaben kein Tag', () => {
  assert.equal(buildId3v2({}).length, 0);
});
