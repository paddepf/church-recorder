'use strict';

/**
 * Schreiben und Lesen von 16-Bit-PCM-WAV-Dateien.
 *
 * Der Writer schreibt fortlaufend (streaming) und hält den Header aktuell,
 * damit eine unterbrochene Aufnahme (Absturz, Stromausfall) trotzdem eine
 * abspielbare Datei hinterlässt.
 */

const fs = require('fs');
const HEADER_BYTES = 44;

function buildHeader(sampleRate, channels, dataBytes) {
  const buf = Buffer.alloc(HEADER_BYTES);
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(Math.max(0, dataBytes + HEADER_BYTES - 8), 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);            // Größe fmt-Chunk
  buf.writeUInt16LE(1, 20);             // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

class WavWriter {
  /** @param {{append?:boolean}} [opts] append: bestehende Datei am Ende weiterschreiben */
  constructor(filePath, sampleRate, channels, opts = {}) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.dataBytes = 0;
    if (opts.append) {
      this.fd = fs.openSync(filePath, 'r+');
      const blockAlign = channels * 2;
      const existing = Math.max(0, fs.fstatSync(this.fd).size - HEADER_BYTES);
      this.dataBytes = existing - (existing % blockAlign);   // angefangenes Frame verwerfen
      this.updateHeader();
    } else {
      this.fd = fs.openSync(filePath, 'w');
      fs.writeSync(this.fd, buildHeader(sampleRate, channels, 0), 0, HEADER_BYTES, 0);
    }
    this._sinceHeaderUpdate = 0;
    this.closed = false;
  }

  /** @param {Buffer} buffer Interleaved Int16LE */
  write(buffer) {
    if (this.closed || !buffer || buffer.length === 0) return;
    fs.writeSync(this.fd, buffer, 0, buffer.length, HEADER_BYTES + this.dataBytes);
    this.dataBytes += buffer.length;
    this._sinceHeaderUpdate += buffer.length;
    // Header etwa jede Sekunde aktualisieren, damit die Datei jederzeit gültig ist.
    if (this._sinceHeaderUpdate >= this.sampleRate * this.channels * 2) {
      this.updateHeader();
      this._sinceHeaderUpdate = 0;
    }
  }

  updateHeader() {
    if (this.closed) return;
    fs.writeSync(this.fd, buildHeader(this.sampleRate, this.channels, this.dataBytes), 0, HEADER_BYTES, 0);
  }

  get frames() {
    return this.dataBytes / (this.channels * 2);
  }

  get durationSeconds() {
    return this.frames / this.sampleRate;
  }

  close() {
    if (this.closed) return;
    this.updateHeader();
    try { fs.fsyncSync(this.fd); } catch { /* egal */ }
    fs.closeSync(this.fd);
    this.closed = true;
  }
}

/** Liest Kopfdaten einer WAV-Datei (nur 16-Bit-PCM). */
function readInfo(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fd, head, 0, HEADER_BYTES, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Keine gültige WAV-Datei.');
    }
    const channels = head.readUInt16LE(22);
    const sampleRate = head.readUInt32LE(24);
    const bitsPerSample = head.readUInt16LE(34);
    if (bitsPerSample !== 16) throw new Error('Nur 16-Bit-WAV wird unterstützt.');
    const fileBytes = fs.fstatSync(fd).size;
    const dataBytes = Math.max(0, fileBytes - HEADER_BYTES);
    return {
      channels,
      sampleRate,
      bitsPerSample,
      dataBytes,
      frames: dataBytes / (channels * 2),
      duration: dataBytes / (channels * 2) / sampleRate
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Liest einen Zeitausschnitt.
 * @returns {{sampleRate:number, channels:number, samples:Int16Array}}
 */
function readSlice(filePath, startSec, endSec) {
  const info = readInfo(filePath);
  const bytesPerFrame = info.channels * 2;
  const startFrame = Math.max(0, Math.floor((startSec || 0) * info.sampleRate));
  const endFrame = Math.min(info.frames, Math.ceil((endSec == null ? info.duration : endSec) * info.sampleRate));
  const frameCount = Math.max(0, endFrame - startFrame);

  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(frameCount * bytesPerFrame);
    if (frameCount > 0) {
      fs.readSync(fd, buf, 0, buf.length, HEADER_BYTES + startFrame * bytesPerFrame);
    }
    const samples = new Int16Array(frameCount * info.channels);
    for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2);
    return { sampleRate: info.sampleRate, channels: info.channels, samples };
  } finally {
    fs.closeSync(fd);
  }
}

/** Schreibt eine komplette Mono-WAV-Datei (für die Transkription). */
function writeMonoFile(filePath, sampleRate, float32) {
  const data = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    let v = Math.max(-1, Math.min(1, float32[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, buildHeader(sampleRate, 1, data.length), 0, HEADER_BYTES, 0);
    fs.writeSync(fd, data, 0, data.length, HEADER_BYTES);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { WavWriter, readInfo, readSlice, writeMonoFile, HEADER_BYTES };
