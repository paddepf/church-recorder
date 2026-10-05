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
const MAX_UINT32 = 0xFFFFFFFF;

function buildHeader(sampleRate, channels, dataBytes) {
  const buf = Buffer.alloc(HEADER_BYTES);
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  // Ein WAV-Header fasst höchstens 4 GB (~6 h 13 min bei 48 kHz Stereo). Darüber hinaus wird die
  // Größe gedeckelt statt einen Fehler zu werfen – die Daten werden weiter geschrieben und von
  // dieser App über die tatsächliche Dateigröße gelesen.
  const riffSize = Math.min(MAX_UINT32, Math.max(0, dataBytes + HEADER_BYTES - 8));
  const dataSize = Math.min(MAX_UINT32, dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(riffSize, 4);
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
  buf.writeUInt32LE(dataSize, 40);
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
    // writeSync darf weniger schreiben als verlangt: dann den Rest nachschieben, sonst
    // verschieben sich alle folgenden Frames.
    let done = 0;
    while (done < buffer.length) {
      done += fs.writeSync(this.fd, buffer, done, buffer.length - done, HEADER_BYTES + this.dataBytes + done);
    }
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
 * Liest eine Anzahl Frames ab einem Start-Frame (Int16, interleaved).
 * @param {object} [info] Ergebnis von readInfo (spart das erneute Lesen des Headers)
 */
function readFrames(filePath, startFrame, frameCount, info) {
  const meta = info || readInfo(filePath);
  const bytesPerFrame = meta.channels * 2;
  const first = Math.max(0, Math.min(startFrame, meta.frames));
  const count = Math.max(0, Math.min(frameCount, meta.frames - first));
  const samples = new Int16Array(count * meta.channels);
  if (count > 0) {
    const fd = fs.openSync(filePath, 'r');
    try {
      // Direkt in den Speicher des Int16Array lesen (WAV ist little endian wie x86/ARM).
      fs.readSync(fd, Buffer.from(samples.buffer), 0, count * bytesPerFrame, HEADER_BYTES + first * bytesPerFrame);
    } finally {
      fs.closeSync(fd);
    }
  }
  return { sampleRate: meta.sampleRate, channels: meta.channels, samples };
}

/**
 * Liest einen Zeitausschnitt.
 * @returns {{sampleRate:number, channels:number, samples:Int16Array}}
 */
function readSlice(filePath, startSec, endSec) {
  const info = readInfo(filePath);
  const startFrame = Math.max(0, Math.floor((startSec || 0) * info.sampleRate));
  const endFrame = Math.min(info.frames, Math.ceil((endSec == null ? info.duration : endSec) * info.sampleRate));
  return readFrames(filePath, startFrame, Math.max(0, endFrame - startFrame), info);
}

module.exports = { WavWriter, readInfo, readSlice, readFrames, HEADER_BYTES };
