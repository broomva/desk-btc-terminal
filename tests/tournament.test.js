import { describe, expect, test } from "bun:test";
import {
  minuteObservations,
  pinballLoss,
  quantile,
  runTournament,
} from "../dist/tournament.js";

const start = Date.UTC(2026, 10, 1);
const fixture = (count = 360) =>
  Array.from({ length: count }, (_, i) => ({
    timestamp: start + i * 60_000,
    price: 80_000 + i * 0.3 + Math.sin(i / 5) * 14,
    imbalance: Math.sin(i / 12) * 0.2,
  }));
const options = { pathCount: 40, forecastPaths: 80, rounds: 3, seed: 27 };

describe("bounded forecasting research", () => {
  test("quantiles interpolate and pinball rewards the correct quantile", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(pinballLoss(10, 10, 0.9)).toBe(0);
    expect(pinballLoss(10, 8, 0.9)).toBeCloseTo(1.8);
    expect(pinballLoss(10, 12, 0.9)).toBeCloseTo(0.2);
  });

  test("minute closes contain only observed, completed minutes", () => {
    const input = [
      { timestamp: start + 4_000, price: 10 },
      { timestamp: start + 59_000, price: 11 },
      { timestamp: start + 121_000, price: 12 },
      { timestamp: start + 180_000, price: 13 },
      { timestamp: start + 181_000, price: NaN },
    ];
    const result = minuteObservations(input);
    expect(result.map((p) => p.timestamp)).toEqual([
      start + 60_000,
      start + 180_000,
    ]);
    expect(result.map((p) => p.price)).toEqual([11, 12]);
  });

  test("short or gapped data cannot masquerade as a research run", () => {
    expect(
      runTournament({ observations: fixture(120), ...options }).status,
    ).toBe("insufficient");
    const sparse = fixture(400).filter((_, i) => i % 5 === 0);
    expect(runTournament({ observations: sparse, ...options }).status).toBe(
      "insufficient",
    );
    expect(runTournament({ observations: [] }).reason).toMatch(/minutes/i);
  });

  test("the tournament is reproducible with mature chronological labels", () => {
    const observations = fixture();
    const a = runTournament({ observations, ...options });
    const b = runTournament({ observations, ...options });
    expect(a).toEqual(b);
    expect(a.status).toBe("ready");
    expect(a.agents).toHaveLength(8);
    expect(a.mutations).toHaveLength(3);
    expect(a.evaluation.heldOut).toBe(true);
    expect(a.evaluation.validationDecisions).toBeGreaterThanOrEqual(8);
    expect(a.evaluation.testDecisions).toBeGreaterThanOrEqual(4);
    expect(a.evaluation.validationEnd).toBeLessThan(a.evaluation.testStart);
    for (const origin of a.evaluation.origins.validation) {
      expect(origin.targetAt).toBeLessThan(a.evaluation.testStart);
      expect(origin.historyEnd).toBe(origin.timestamp);
    }
    for (const origin of a.evaluation.origins.test) {
      expect(origin.timestamp).toBeGreaterThanOrEqual(a.evaluation.testStart);
      expect(origin.targetAt).toBeLessThanOrEqual(a.evaluation.testEnd);
    }
    expect(a.forecast.paths).toHaveLength(80);
    expect(a.forecast.timestamp).toBe(observations.at(-1).timestamp);
    expect(a.forecast.reference).toBeCloseTo(observations.at(-1).price);
    expect(a.forecast.paths.every((p) => p.length === 16)).toBe(true);
    expect(a.forecast.paths.every((p) => p[0] === a.forecast.reference)).toBe(
      true,
    );
    expect(a.forecast.p10).toBeLessThanOrEqual(a.forecast.median);
    expect(a.forecast.median).toBeLessThanOrEqual(a.forecast.p90);
    expect(a.forecast.above).toBeGreaterThanOrEqual(0);
    expect(a.forecast.above).toBeLessThanOrEqual(1);
  });

  test("untouched final values cannot alter mutation decisions or weights", () => {
    const observations = fixture();
    const first = runTournament({ observations, ...options });
    const changed = observations.map((point) =>
      point.timestamp >= first.evaluation.testStart
        ? { ...point, price: point.price * 1.2 }
        : point,
    );
    const second = runTournament({ observations: changed, ...options });
    expect(second.mutations).toEqual(first.mutations);
    expect(
      second.agents.map(({ config, weight, score }) => ({
        config,
        weight,
        score,
      })),
    ).toEqual(
      first.agents.map(({ config, weight, score }) => ({
        config,
        weight,
        score,
      })),
    );
    expect(second.evaluation.testScore).not.toBe(first.evaluation.testScore);
  });

  test("constant prices produce exact no-change baseline forecasts", () => {
    const result = runTournament({
      observations: fixture().map((p) => ({ ...p, price: 100, imbalance: 0 })),
      ...options,
    });
    expect(result.evaluation.baselineScore).toBe(0);
    expect(result.evaluation.baselineTestScore).toBe(0);
    expect(result.forecast.paths.flat().every((p) => p === 100)).toBe(true);
    expect(result.mutations.every((m) => m.accepted === false)).toBe(true);
  });

  test("current partial-minute prices rebase NOW without changing the frozen experiment", () => {
    const observations = fixture();
    const first = runTournament({ observations, ...options });
    const latest = observations.at(-1);
    const second = runTournament({
      observations: [
        ...observations,
        {
          ...latest,
          timestamp: latest.timestamp + 10_000,
          price: latest.price + 500,
        },
      ],
      ...options,
    });
    expect(second.evaluation).toEqual(first.evaluation);
    expect(second.mutations).toEqual(first.mutations);
    expect(second.forecast.reference).toBeCloseTo(latest.price + 500);
    expect(second.forecast.timestamp).toBe(latest.timestamp + 10_000);
  });

  test("default path counts and trial budgets are bounded", () => {
    const result = runTournament({ observations: fixture(273), rounds: 0 });
    expect(result.status).toBe("ready");
    expect(result.forecast.paths).toHaveLength(1000);
    expect(result.mutations).toHaveLength(0);
    expect(result.evaluation.testDecisions).toBe(4);
    expect(result.evaluation.pathsPerTrial).toBe(400);
  });
});
