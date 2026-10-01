/** The z-score for a two-sided 95% confidence interval (the 97.5th percentile of the
 * standard normal distribution). */
const Z_95 = 1.959963984540054;

/**
 * The Wilson score interval for a binomial proportion, at 95% confidence: the
 * agent-track leaderboard's honest alternative to a bare `passed/n` pass rate, which
 * overstates confidence at the small `repeat` counts (>= 5, ADR-010 §4) this track
 * actually runs. `n === 0` has no data at all, so it returns the widest possible
 * interval, `{lo: 0, hi: 1}`, rather than dividing by zero.
 */
export function wilson95(passed: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };

  const phat = passed / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (Z_95 / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));

  return {
    lo: Math.max(0, center - margin),
    hi: Math.min(1, center + margin),
  };
}
