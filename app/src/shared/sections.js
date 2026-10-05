/* Gemeinsame Regeln für Abschnitte (Hauptprozess und Oberfläche nutzen dieselbe Datei),
   damit das Verschieben in der Wellenform und die gespeicherte Lage identisch ausfallen. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SectionLogic = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_SECTION = 0.1;   // kürzester Abschnitt in Sekunden

  /** Ende eines Abschnitts; ein laufender reicht bis zum Live-Ende. */
  function endOf(section, duration) {
    return section.end != null ? section.end : Math.max(duration, section.start + MIN_SECTION);
  }

  /**
   * Verschiebt den Anfang oder das Ende eines Abschnitts. Abschnitte überlappen
   * nie: Stößt die Marke an einen Nachbarn, wandert dessen angrenzende Marke mit
   * (der Nachbar wird kürzer). Kürzer als MIN_SECTION wird dabei keiner – dort
   * bleibt die Marke stehen.
   *
   * Verändert die übergebenen Abschnitte direkt.
   * @returns {{section: object, time: number}|null} tatsächlich gesetzte Zeit
   */
  function moveEdge(sections, id, edge, time, duration) {
    const x = sections.find((s) => s.id === id && s.start != null);
    if (!x) return null;
    const max = Math.max(duration, 0);
    const others = sections.filter((s) => s !== x && s.start != null);
    let t = time;

    if (edge === 'start') {
      t = Math.max(0, Math.min(t, x.end != null ? x.end - MIN_SECTION : max));
      if (t < x.start) {
        // Nach links: vorausgehende Abschnitte weichen zurück.
        const before = others.filter((o) => o.end != null && o.start < x.start).sort((a, b) => b.start - a.start);
        for (const o of before) if (o.end > t) t = Math.max(t, o.start + MIN_SECTION);
        t = Math.min(t, x.start);
        for (const o of before) if (o.end > t) o.end = t;
      }
      x.start = t;
    } else if (x.end != null) {
      t = Math.min(max, Math.max(t, x.start + MIN_SECTION));
      if (t > x.end) {
        // Nach rechts: nachfolgende Abschnitte weichen zurück.
        const after = others.filter((o) => o.start > x.start).sort((a, b) => a.start - b.start);
        for (const o of after) if (o.start < t) t = Math.min(t, endOf(o, duration) - MIN_SECTION);
        t = Math.max(t, x.end);
        for (const o of after) if (o.start < t) o.start = t;
      }
      x.end = t;
    } else {
      return { section: x, time: x.end };
    }
    return { section: x, time: t };
  }

  return { MIN_SECTION, endOf, moveEdge };
});
