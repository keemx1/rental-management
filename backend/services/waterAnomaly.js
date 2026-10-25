'use strict';

/**
 * Water meter anomaly detection — shared logic (Phase 3).
 *
 * PORT NOTE: frontend/js/water-anomaly.js is a verbatim port of this file.
 * Keep the two in sync so offline warnings match server-side flags exactly.
 *
 * Rules:
 * - negative consumption (current < previous) → REJECT (meter misread or
 *   meter replaced; agent must verify on site, never auto-posts).
 * - zero consumption → WARN (vacant unit or stuck meter).
 * - spike (>3× the tenant's average over recent history) → WARN.
 * - very high absolute consumption (>= HIGH_UNITS) → WARN.
 * - otherwise OK.
 */
const SPIKE_FACTOR = 3;
const MIN_HISTORY = 2;
const HIGH_UNITS = 50;

function detectWaterAnomaly({ previous, current, history }) {
  const prev = Number(previous || 0);
  const curr = Number(current || 0);
  const units = curr - prev;

  if (units < 0) {
    return {
      level: 'reject',
      code: 'negative',
      message: `Current reading (${curr}) is below the previous reading (${prev}). Verify the meter on site — it may have been misread or replaced.`,
    };
  }
  if (units === 0) {
    return {
      level: 'warn',
      code: 'zero',
      message: 'Zero consumption since the last reading. The unit may be vacant or the meter stuck.',
    };
  }
  const hist = (Array.isArray(history) ? history : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (hist.length >= MIN_HISTORY) {
    const avg = hist.reduce((s, n) => s + n, 0) / hist.length;
    if (avg > 0 && units > SPIKE_FACTOR * avg) {
      return {
        level: 'warn',
        code: 'spike',
        message: `Consumption of ${units} units is more than ${SPIKE_FACTOR}× the recent average of ${avg.toFixed(1)} units — possible leak or misread.`,
      };
    }
  }
  if (units >= HIGH_UNITS) {
    return {
      level: 'warn',
      code: 'high',
      message: `Consumption of ${units} units is unusually high. Double-check the reading before posting.`,
    };
  }
  return { level: 'ok', code: null, message: null };
}

module.exports = { detectWaterAnomaly, SPIKE_FACTOR, MIN_HISTORY, HIGH_UNITS };
