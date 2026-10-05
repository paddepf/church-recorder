'use strict';

/**
 * Minimaler ID3v2.3-Schreiber für MP3-Dateien (Titel, Interpret, Album, Jahr).
 * Texte werden als UTF-16 mit BOM abgelegt, damit Umlaute überall korrekt ankommen.
 */

function textFrame(id, text) {
  const body = Buffer.concat([
    Buffer.from([0x01, 0xff, 0xfe]),              // Kodierung UTF-16 mit BOM (little endian)
    Buffer.from(String(text), 'utf16le'),
    Buffer.from([0x00, 0x00])                     // Abschluss
  ]);
  const head = Buffer.alloc(10);
  head.write(id, 0, 'ascii');
  head.writeUInt32BE(body.length, 4);             // ab Version 2.3 normale (nicht synchsafe) Größe
  return Buffer.concat([head, body]);
}

function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/**
 * @param {{title?:string, artist?:string, album?:string, year?:string}} tags
 * @returns {Buffer} ID3-Block zum Voranstellen; leer, wenn keine Angabe vorhanden ist
 */
function buildId3v2(tags = {}) {
  const frames = [];
  if (tags.title) frames.push(textFrame('TIT2', tags.title));
  if (tags.artist) frames.push(textFrame('TPE1', tags.artist));
  if (tags.album) frames.push(textFrame('TALB', tags.album));
  if (tags.year) frames.push(textFrame('TYER', tags.year));
  if (frames.length === 0) return Buffer.alloc(0);

  const body = Buffer.concat(frames);
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([0x03, 0x00, 0x00]), syncsafe(body.length)]);
  return Buffer.concat([header, body]);
}

module.exports = { buildId3v2 };
