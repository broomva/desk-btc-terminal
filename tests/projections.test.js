import { expect, test } from "bun:test";
import { sampleProjection } from "../dist/projections.js";

test("sample summaries preserve each trajectory and calculate actual quantiles", () => {
  const sample = sampleProjection(101, 180, 1, 712);
  const endpoints = sample.paths
    .map((path) => path.at(-1))
    .sort((a, b) => a - b);
  expect(sample.paths).toHaveLength(101);
  expect(sample.median.at(-1)).toBe(endpoints[50]);
  expect(sample.p10.at(-1)).toBe(endpoints[10]);
  expect(sample.p90.at(-1)).toBe(endpoints[90]);
  expect(sample.up + sample.down).toBe(101);
  for (let i = 0; i < 33; i++) {
    expect(sample.p10[i]).toBeLessThanOrEqual(sample.median[i]);
    expect(sample.median[i]).toBeLessThanOrEqual(sample.p90[i]);
  }
});

test("seeded samples are stable and start from the same observed point", () => {
  const sample = sampleProjection(60, 120, 1, 42);
  expect(sample).toEqual(sampleProjection(60, 120, 1, 42));
  expect(sample).not.toEqual(sampleProjection(60, 120, 1, 43));
  expect(sample.paths.every((path) => path[0] === 0)).toBe(true);
});

test("volatility scales dispersion without changing sample direction counts", () => {
  const low = sampleProjection(120, 180, 1, 42);
  const high = sampleProjection(120, 180, 2, 42);
  expect(high.up).toBe(low.up);
  expect(high.p90.at(-1) - high.p10.at(-1)).toBeCloseTo(
    2 * (low.p90.at(-1) - low.p10.at(-1)),
    8,
  );
});
