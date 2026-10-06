/* Zuordnung von Diensten aus der ChurchTools-Dienstplanung (z. B. "Predigt 2", "Leitung") zu
   Programmpunkten (z. B. "Predigt"). Hauptprozess und Oberfläche nutzen dieselbe Regel. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoleLogic = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Feste Zuordnungen von Diensten zu Programmpunkten, die sich nicht aus gleichen Wörtern ergeben:
   * Dienst (Wort) → Programmpunkt-Wörter. „Geschichte“ gehört immer zum Kinderbeitrag, „Leitung“ zu
   * Einleitung und Abschluss.
   */
  const ALIASES = {
    geschichte: ['kinderbeitrag'],
    leitung: ['einleitung', 'abschluss']
  };

  function words(text) {
    return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  /**
   * Passt ein Dienst zu einem Programmpunkt? Verglichen werden ganze Wörter ("Einleitung" passt nicht
   * zu "Leitung"); reine Zahlen zählen nicht ("Predigt 2" passt nicht zu "Lied 2").
   */
  function roleMatchesLabel(role, label) {
    const labelWords = new Set(words(label));
    return words(role).some((w) => !/^\d+$/.test(w) && (labelWords.has(w) || (ALIASES[w] || []).some((a) => labelWords.has(a))));
  }

  /** Namen der Personen aus der Dienstplanung, deren Dienst zum Programmpunkt passt (ohne Doppelte). */
  function namesForLabel(label, suggestions) {
    const names = [];
    (suggestions || []).forEach((s) => {
      if (roleMatchesLabel(s.role, label) && !names.includes(s.name)) names.push(s.name);
    });
    return names;
  }

  /**
   * Vorlage, die zum Titel eines Gottesdienstes passt (Vorlage „Bibelstunde“ zum Termin „Bibelstunde“ oder
   * „Bibelstunde im Gemeindehaus“): alle Wörter des Vorlagennamens müssen als ganze Wörter im Titel stehen,
   * Groß-/Kleinschreibung egal. Bei mehreren Treffern gewinnt der längere Vorlagenname. Sonst `null`.
   */
  function templateForTitle(templates, title) {
    const titleWords = new Set(words(title));
    let best = null;
    let bestLen = 0;
    (templates || []).forEach((t) => {
      const w = words(t && t.name);
      if (w.length > bestLen && w.every((x) => titleWords.has(x))) {
        best = t;
        bestLen = w.length;
      }
    });
    return best;
  }

  /** Abschnitt, der den Infotext des Termins (Predigttitel) bekommt: Name enthält das Wort „Predigt“. */
  function takesEventInfo(label) {
    return words(label).includes('predigt');
  }

  return { words, roleMatchesLabel, namesForLabel, templateForTitle, takesEventInfo, ALIASES };
});
