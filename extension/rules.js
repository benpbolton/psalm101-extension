// Psalm101 filtering levels, shared by the background, the page script, the engine, and the popup.
// Tiers: P0 safe, P1 suggestive, P2 nudity, P3 explicit.
// Chosen on held-out human-labeled validation data so every level keeps explicit recall at 100%.
//
// A check returns probabilities; whether to hide is decided here, so changing the level re-decides instantly
// without checking anything again.
(function (g) {
  const LEVELS = ['Very strict', 'Strict', 'Moderate', 'Relaxed'];
  const LEVEL_DETAIL = [
    'Also hides borderline swimwear and fashion',
    'Hides suggestive, nudity and explicit',
    'Allows most lingerie and swimwear; hides nudity',
    'Hides explicit content only',
  ];
  // [kind, k, threshold]: 'atLeast' = P(tier >= k) >= t; 'expected' = (P1/3 + 2·P2/3 + P3) >= t.
  const RULES = [
    ['atLeast', 1, 0.35],
    ['expected', 0, 0.30],
    ['atLeast', 2, 0.25],
    ['atLeast', 3, 0.15],
  ];
  const slider = (p) => p[1] / 3 + (2 * p[2]) / 3 + p[3];
  const ruleFor = (level) => RULES[Math.max(0, Math.min(3, level ?? 1))];
  const blocks = ([kind, k, t], p) => (kind === 'expected' ? slider(p) >= t : p.slice(k).reduce((a, b) => a + b, 0) >= t);
  const decide = (p, _model, level) => blocks(ruleFor(level), p);
  // The whole image, or overlapping squares along the long side when it's more than 2.2:1 ([x, y, w, h] each).
  function tilesFor(w, h) {
    const long = Math.max(w, h), short = Math.min(w, h);
    if (!short || long / short <= 2.2) return [[0, 0, w, h]];
    const n = Math.ceil((long / short) * 1.25), step = (long - short) / Math.max(n - 1, 1);
    return Array.from({ length: n }, (_, i) => (w > h ? [i * step, 0, short, short] : [0, i * step, short, short]));
  }
  g.PsalmRules = { LEVELS, LEVEL_DETAIL, RULES, slider, ruleFor, blocks, decide, tilesFor };
})(globalThis);
