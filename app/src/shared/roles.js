/* Zuordnung von Diensten aus der ChurchTools-Dienstplanung (z. B. "Predigt 2", "Leitung") zu
   Programmpunkten (z. B. "Predigt"). Hauptprozess und Oberfläche nutzen dieselbe Regel. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoleLogic = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function words(text) {
    return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  /**
   * Passt ein Dienst zu einem Programmpunkt? Verglichen werden ganze Wörter ("Einleitung" passt nicht
   * zu "Leitung"); reine Zahlen zählen nicht ("Predigt 2" passt nicht zu "Lied 2").
   */
  function roleMatchesLabel(role, label) {
    const labelWords = new Set(words(label));
    return words(role).some((w) => !/^\d+$/.test(w) && labelWords.has(w));
  }

  /** Namen der Personen aus der Dienstplanung, deren Dienst zum Programmpunkt passt (ohne Doppelte). */
  function namesForLabel(label, suggestions) {
    const names = [];
    (suggestions || []).forEach((s) => {
      if (roleMatchesLabel(s.role, label) && !names.includes(s.name)) names.push(s.name);
    });
    return names;
  }

  return { words, roleMatchesLabel, namesForLabel };
});
