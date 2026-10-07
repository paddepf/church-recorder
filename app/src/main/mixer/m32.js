'use strict';

/**
 * Wissen über das Midas M32 (gleiches OSC wie Behringer X32): Adressen, Farben und Routing der
 * Kartenausgänge (DN32-USB). Quelle: inoffizielle X32-OSC-Dokumentation (P.-G. Maillot).
 * **Nicht an einem echten Pult geprüft** – deshalb lässt sich das Routing auch anlernen
 * (`routingKind` mit `learned`), dann zählt nur der Vergleich mit den gemerkten Werten.
 */

const PORT = 10023;
const CHANNELS = 32;
const CARD_BLOCKS = ['1-8', '9-16', '17-24', '25-32'];

const pad2 = (n) => String(n).padStart(2, '0');
const namePath = (ch) => `/ch/${pad2(ch)}/config/name`;      // ch 1-basiert
const colorPath = (ch) => `/ch/${pad2(ch)}/config/color`;
const routingPath = (block) => `/config/routing/CARD/${block}`;

/** Quellen der Kartenausgänge (Wert von /config/routing/CARD/…), je ein 8er-Block. */
const ROUTING_SOURCES = [
  'AN1-8', 'AN9-16', 'AN17-24', 'AN25-32',
  'A1-8', 'A9-16', 'A17-24', 'A25-32', 'A33-40', 'A41-48',
  'B1-8', 'B9-16', 'B17-24', 'B25-32', 'B33-40', 'B41-48',
  'CARD1-8', 'CARD9-16', 'CARD17-24', 'CARD25-32',
  'OUT1-8', 'OUT9-16', 'P161-8', 'P169-16', 'AUX1-6/Mon', 'AuxIN1-6/TB'
];
const FIRST_OUTPUT_SOURCE = 20;   // ab hier Ausgänge des Pults (Matrix, Summe …) statt Eingänge

/** Klartext einer Routing-Quelle. */
function routingLabel(value) {
  return ROUTING_SOURCES[value] || `Quelle ${value}`;
}

/**
 * Was liefern die Kartenausgänge gerade?
 * - 'multitrack': Block 1–8 führt Eingänge (Preamps, Stagebox) – also einzelne Kanäle.
 * - 'stereo': Block 1–8 führt Pult-Ausgänge (z. B. Matrix auf 1–2).
 * - 'unknown': kein Routing gelesen oder unbekannter Wert.
 * Angelernte Werte (`learned.stereo` / `learned.multitrack`, je vier Zahlen) haben Vorrang.
 * @returns {{kind: string, learned: boolean}}
 */
function routingKind(blocks, learned) {
  if (!Array.isArray(blocks) || blocks.length !== CARD_BLOCKS.length || blocks.some((b) => !Number.isInteger(b))) {
    return { kind: 'unknown', learned: false };
  }
  const same = (a) => Array.isArray(a) && a.length === blocks.length && a.every((v, i) => v === blocks[i]);
  if (learned) {
    if (same(learned.multitrack)) return { kind: 'multitrack', learned: true };
    if (same(learned.stereo)) return { kind: 'stereo', learned: true };
  }
  const first = blocks[0];
  if (first >= 0 && first < FIRST_OUTPUT_SOURCE) return { kind: 'multitrack', learned: false };
  if (first >= FIRST_OUTPUT_SOURCE && first < ROUTING_SOURCES.length) return { kind: 'stereo', learned: false };
  return { kind: 'unknown', learned: false };
}

/** Kanalfarben des Pults (Wert von /ch/…/config/color); „i“ = invertiert (farbiger Hintergrund). */
const COLORS = ['off', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
function colorName(value) {
  if (!Number.isInteger(value) || value < 0 || value > 15) return null;
  return COLORS[value % 8];
}

module.exports = {
  PORT, CHANNELS, CARD_BLOCKS, ROUTING_SOURCES,
  namePath, colorPath, routingPath, routingLabel, routingKind, colorName
};
