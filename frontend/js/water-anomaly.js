/**
 * Water meter anomaly detection — offline port (Phase 3).
 *
 * Verbatim port of backend/services/waterAnomaly.js. Keep the two in sync
 * so the warning an agent sees offline matches the flag stored on sync.
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

export { detectWaterAnomaly, SPIKE_FACTOR, MIN_HISTORY, HIGH_UNITS };
