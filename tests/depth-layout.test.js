import { describe, expect, test } from "bun:test";
import { PAST_MINUTES, layout } from "../dist/depth-chart.js";

const MINUTE = 60000;
const now = Date.UTC(2026, 10, 4, 18, 0);
const base = { width: 1384, height: 640, timestamp: now, reference: 80000 };

describe("depth chart layout", () => {
  test("a flat price draws flat: height never depends on time", () => {
    const g = layout({ ...base, prices: [79950, 80050] });
    const early = g.y(80000);
    for (const m of [-15, -10, -1, 0]) {
      expect(g.x(now + m * MINUTE)).toBeLessThanOrEqual(g.xNow);
      expect(g.y(80000)).toBe(early);
    }
  });

  test("past and future share one minutes-per-pixel scale", () => {
    const g = layout({ ...base, horizonMinutes: 15, prices: [80000] });
    const past = g.xNow - g.x(now - PAST_MINUTES * MINUTE);
    const future = g.x(now + 15 * MINUTE) - g.xNow;
    expect(Math.abs(past - future)).toBeLessThan(1e-9);
    expect(g.x(now + 15 * MINUTE)).toBeCloseTo(g.xEnd, 9);
  });

  test("price range follows visible prices, not deep book levels", () => {
    const g = layout({ ...base, prices: [79980, 80040] });
    expect(g.lo).toBeLessThanOrEqual(79980);
    expect(g.hi).toBeGreaterThanOrEqual(80040);
    expect(g.hi - g.lo).toBeLessThan(120);
    const quiet = layout({ ...base, prices: [80000] });
    expect(quiet.hi - quiet.lo).toBe(60);
    expect(g.y(g.hi)).toBeCloseTo(g.top, 9);
    expect(g.y(g.lo)).toBeCloseTo(g.bottom, 9);
  });

  test("non-finite inputs are ignored", () => {
    const g = layout({ ...base, prices: [Number.NaN, undefined, 80010] });
    expect(Number.isFinite(g.lo) && Number.isFinite(g.hi)).toBe(true);
  });
});
