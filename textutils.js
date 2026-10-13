/**
 * Anser - text normalisation helpers.
 * Loaded by content.js (via manifest content_scripts) AND by the service worker (importScripts).
 */
(function (root) {
  const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
  const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
  const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
  const ETH_LABELS = ["ሀ", "ለ", "ሐ", "መ", "ሠ", "ረ"];
  const LAT_LABELS = "ABCDEF";

  /** NFC, strip zero-width/control chars, unify spaces. Keeps single newlines. */
  function normalizeText(s) {
    if (s === null || s === undefined) return "";
    let t = String(s);
    try { t = t.normalize("NFC"); } catch (e) { /* ignore */ }
    return t
      .replace(ZERO_WIDTH, "")
      .replace(CONTROL, " ")
      .replace(ODD_SPACES, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** Same, but collapses everything onto one line (for options). */
  function normalizeInline(s) {
    return normalizeText(s).replace(/\s+/g, " ").trim();
  }

  /**
   * Remove a leading option label ("ሀ.", "A)", "(b)", "3)") WITHOUT touching real content.
   * Digits are only stripped in the "3)" form, so "2 m/s" and "0.5" survive intact.
   */
  function stripOptionLabel(s) {
    return normalizeInline(s).replace(
      /^(?:\(\s*[ሀለሐመሠረA-Fa-f]\s*\)|[ሀለሐመሠረA-Fa-f]\s?[.)፡:]|\d{1,2}\))\s*/,
      ""
    );
  }

  /**
   * Detect options merged into the question text ("... ሀ. x ለ. y ሐ. z መ. w" or "A. x B. y C. z").
   * Requires a run of >= 3 consecutive labels starting at the first label, so ordinary
   * text such as "points A and B" is never cut.
   * Returns { question, options } or null.
   */
  function splitMergedOptions(text) {
    const t = " " + normalizeInline(text);
    const re = /(?:^|\s)([ሀለሐመሠረ]|[A-Fa-f])\s?[.)፡]\s*/g;
    const marks = [];
    let m;
    while ((m = re.exec(t))) marks.push({ label: m[1], start: m.index, end: re.lastIndex });

    const idxIn = (set, l) => (set === "eth" ? ETH_LABELS.indexOf(l) : LAT_LABELS.indexOf(l.toUpperCase()));
    for (const set of ["eth", "lat"]) {
      for (let s = 0; s < marks.length; s++) {
        if (idxIn(set, marks[s].label) !== 0) continue;
        const run = [marks[s]];
        for (let k = s + 1; k < marks.length; k++) {
          if (idxIn(set, marks[k].label) === run.length) run.push(marks[k]);
        }
        if (run.length >= 3) {
          const options = run.map((mk, i) =>
            t.slice(mk.end, i + 1 < run.length ? run[i + 1].start : t.length).trim()
          );
          if (options.every((o) => o.length > 0)) {
            return { question: t.slice(0, run[0].start).trim(), options };
          }
        }
      }
    }
    return null;
  }

  root.AnserText = { normalizeText, normalizeInline, stripOptionLabel, splitMergedOptions };
})(typeof self !== "undefined" ? self : this);
