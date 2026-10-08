'use strict';

/**
 * Minimales OSC 1.0 (Open Sound Control) zum Sprechen mit dem Mischpult: Nachrichten mit
 * Adresse und Argumenten der Typen i (int32), f (float32), s (Text) und b (Blob).
 * Bündel (#bundle) werden nicht gebraucht – das X32/M32 schickt einzelne Nachrichten.
 */

/** Text mit Nullbyte, auf ein Vielfaches von 4 Byte aufgefüllt. */
function str(text) {
  const raw = Buffer.from(String(text), 'utf8');
  const out = Buffer.alloc(Math.ceil((raw.length + 1) / 4) * 4);
  raw.copy(out);
  return out;
}

/**
 * @param {string} address z. B. „/ch/01/config/name“
 * @param {Array<number|string|Buffer|{type:string, value:any}>} [args] Zahlen gelten als int32, außer als {type:'f'}
 */
function encode(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    const arg = a && typeof a === 'object' && !Buffer.isBuffer(a) ? a : {
      type: typeof a === 'string' ? 's' : Buffer.isBuffer(a) ? 'b' : (Number.isInteger(a) ? 'i' : 'f'),
      value: a
    };
    tags += arg.type;
    if (arg.type === 'i') {
      const b = Buffer.alloc(4);
      b.writeInt32BE(arg.value);
      parts.push(b);
    } else if (arg.type === 'f') {
      const b = Buffer.alloc(4);
      b.writeFloatBE(arg.value);
      parts.push(b);
    } else if (arg.type === 's') {
      parts.push(str(arg.value));
    } else if (arg.type === 'b') {
      const size = Buffer.alloc(4);
      size.writeInt32BE(arg.value.length);
      const data = Buffer.alloc(Math.ceil(arg.value.length / 4) * 4);
      arg.value.copy(data);
      parts.push(size, data);
    } else {
      throw new Error(`OSC: Typ ${arg.type} wird nicht unterstützt.`);
    }
  }
  return Buffer.concat([str(address), str(tags), ...parts]);
}

function readStr(buf, pos) {
  const end = buf.indexOf(0, pos);
  if (end < 0) throw new Error('OSC: Text ohne Ende');
  return { value: buf.toString('utf8', pos, end), next: Math.ceil((end + 1) / 4) * 4 };
}

/** @returns {{address:string, args:Array<number|string|Buffer>}} */
function decode(buf) {
  const addr = readStr(buf, 0);
  if (!addr.value.startsWith('/')) throw new Error('OSC: keine Nachricht');
  if (addr.next >= buf.length) return { address: addr.value, args: [] };
  const tags = readStr(buf, addr.next);
  if (!tags.value.startsWith(',')) return { address: addr.value, args: [] };
  let pos = tags.next;
  const args = [];
  for (const t of tags.value.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(pos)); pos += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(pos)); pos += 4; }
    else if (t === 's') { const s = readStr(buf, pos); args.push(s.value); pos = s.next; }
    else if (t === 'b') {
      const n = buf.readInt32BE(pos);
      args.push(buf.subarray(pos + 4, pos + 4 + n));
      pos += 4 + Math.ceil(n / 4) * 4;
    } else throw new Error(`OSC: Typ ${t} wird nicht unterstützt.`);
  }
  return { address: addr.value, args };
}

module.exports = { encode, decode };
