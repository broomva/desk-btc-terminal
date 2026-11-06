// A bounded configuration search over empirical block-bootstrap forecasts.
// No LLM, trained model, execution strategy, or profit estimate is involved.
const MINUTE = 60_000;
const QUANTILES = [0.1, 0.5, 0.9];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const bounded = (value, fallback, low, high) =>
  clamp(Number.isFinite(value) ? Math.floor(value) : fallback, low, high);

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * clamp(probability, 0, 1);
  const lower = Math.floor(position);
  return (
    sorted[lower] +
    (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
  );
}

export function pinballLoss(actual, predicted, probability) {
  const error = actual - predicted;
  return Math.max(probability * error, (probability - 1) * error);
}

// The last observed minute is still open. Missing minutes are never filled.
// Timestamp is the bucket's closing boundary, when its value becomes available.
export function minuteObservations(observations) {
  if (!Array.isArray(observations)) return [];
  const buckets = new Map();
  let latest = -Infinity;
  for (const point of observations.slice(-200_000)) {
    if (
      !point ||
      !Number.isFinite(point.timestamp) ||
      point.timestamp < 0 ||
      !Number.isFinite(point.price) ||
      point.price <= 0
    )
      continue;
    const minute = Math.floor(point.timestamp / MINUTE);
    latest = Math.max(latest, minute);
    const existing = buckets.get(minute);
    if (!existing || point.timestamp >= existing.observedAt) {
      buckets.set(minute, {
        timestamp: (minute + 1) * MINUTE,
        observedAt: point.timestamp,
        price: point.price,
        imbalance: Number.isFinite(point.imbalance)
          ? clamp(point.imbalance, -1, 1)
          : 0,
      });
    }
  }
  return [...buckets.entries()]
    .filter(([minute]) => minute < latest)
    .sort(([a], [b]) => a - b)
    .map(([, point]) => point);
}

function contiguousTail(points) {
  let start = points.length - 1;
  while (
    start > 0 &&
    points[start].timestamp - points[start - 1].timestamp === MINUTE
  )
    start--;
  return points.slice(Math.max(0, start), points.length).slice(-1440);
}

const INITIAL = [
  ["Balanced", 60, 5, 0, 1, false],
  ["Momentum", 30, 3, 0.5, 1, false],
  ["Reversion", 45, 3, -0.5, 1, false],
  ["Long memory", 90, 10, 0.1, 1, false],
  ["Fast tape", 15, 1, 0, 1, false],
  ["Narrow fan", 60, 5, 0, 0.75, false],
  ["Wide fan", 45, 5, 0, 1.3, false],
  ["Book tilt", 60, 5, 0.1, 1, true],
];
const BASELINE = {
  lookback: 60,
  blockLength: 1,
  drift: 0,
  volScale: 1,
  bookImbalance: false,
};

function initializeAgents() {
  return INITIAL.map(
    ([name, lookback, blockLength, drift, volScale, book], i) => ({
      id: `agent-${i + 1}`,
      name,
      config: { lookback, blockLength, drift, volScale, bookImbalance: book },
      weight: 1,
      floorRounds: 0,
      score: null,
      state: "active",
      generation: 0,
    }),
  );
}

function returnWindow(points, origin, config) {
  const begin = Math.max(0, origin - config.lookback);
  const returns = [];
  for (let i = begin + 1; i <= origin; i++)
    returns.push(Math.log(points[i].price / points[i - 1].price));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const deviation = Math.sqrt(
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      returns.length,
  );
  return { returns, mean, deviation };
}

function samplePaths(points, origin, config, horizon, count, seed) {
  const { returns, mean, deviation } = returnWindow(points, origin, config);
  const rng = random(seed);
  const tilt = config.bookImbalance
    ? points[origin].imbalance * deviation * 0.2
    : 0;
  const drift = mean * config.drift + tilt;
  const blockLength = Math.min(config.blockLength, returns.length);
  return Array.from({ length: count }, () => {
    const path = [points[origin].price];
    let block = 0;
    for (let step = 0; step < horizon; step++) {
      if (step % blockLength === 0)
        block = Math.floor(rng() * (returns.length - blockLength + 1));
      const move =
        (returns[block + (step % blockLength)] - mean) * config.volScale +
        drift;
      path.push(path.at(-1) * Math.exp(clamp(move, -0.2, 0.2)));
    }
    return path;
  });
}

function terminalScore(paths, target) {
  const sorted = paths.map((path) => path.at(-1)).sort((a, b) => a - b);
  return (
    QUANTILES.reduce(
      (sum, probability) =>
        sum + pinballLoss(target, quantile(sorted, probability), probability),
      0,
    ) / QUANTILES.length
  );
}

function scoreConfig(points, origins, config, horizon, count, seed) {
  return (
    origins.reduce((sum, origin) => {
      // Same random stream for incumbent and candidate at every origin.
      const paths = samplePaths(
        points,
        origin,
        config,
        horizon,
        count,
        seed + origin * 31,
      );
      return sum + terminalScore(paths, points[origin + horizon].price);
    }, 0) / origins.length
  );
}

function originsBetween(start, end, horizon) {
  const origins = [];
  for (let origin = start; origin + horizon < end; origin += horizon)
    origins.push(origin);
  return origins;
}

function mutate(config, rng, round) {
  const fields = [
    "lookback",
    "blockLength",
    "drift",
    "volScale",
    "bookImbalance",
  ];
  const field = fields[round % fields.length];
  const next = { ...config };
  const direction = rng() < 0.5 ? -1 : 1;
  if (field === "lookback")
    next.lookback = clamp(config.lookback + direction * 15, 15, 90);
  if (field === "blockLength")
    next.blockLength = clamp(config.blockLength + direction * 2, 1, 12);
  if (field === "drift")
    next.drift =
      Math.round(clamp(config.drift + direction * 0.25, -1, 1) * 100) / 100;
  if (field === "volScale")
    next.volScale =
      Math.round(clamp(config.volScale + direction * 0.15, 0.4, 1.8) * 100) /
      100;
  if (field === "bookImbalance") next.bookImbalance = !config.bookImbalance;
  return { config: next, field, from: config[field], to: next[field] };
}

function weightedMixture(points, origin, agents, horizon, count, seed) {
  const active = agents.filter((agent) => agent.state === "active");
  const total = active.reduce((sum, agent) => sum + agent.weight, 0);
  const rng = random(seed ^ 0x5a52);
  const allocations = active.map(() => 0);
  for (let i = 0; i < count; i++) {
    let position = rng() * total;
    let index = 0;
    while (index < active.length - 1 && position >= active[index].weight) {
      position -= active[index].weight;
      index++;
    }
    allocations[index]++;
  }
  return active.flatMap((agent, index) =>
    samplePaths(
      points,
      origin,
      agent.config,
      horizon,
      allocations[index],
      seed + index * 997,
    ),
  );
}

function scoreMixture(points, origins, agents, horizon, count, seed) {
  return (
    origins.reduce(
      (sum, origin) =>
        sum +
        terminalScore(
          weightedMixture(
            points,
            origin,
            agents,
            horizon,
            count,
            seed + origin * 31,
          ),
          points[origin + horizon].price,
        ),
      0,
    ) / origins.length
  );
}

function summarizeForecast(paths, horizon, timestamp) {
  const quantiles = { median: [], p10: [], p90: [] };
  for (let step = 0; step <= horizon; step++) {
    const sorted = paths.map((path) => path[step]).sort((a, b) => a - b);
    quantiles.median.push(quantile(sorted, 0.5));
    quantiles.p10.push(quantile(sorted, 0.1));
    quantiles.p90.push(quantile(sorted, 0.9));
  }
  const reference = paths[0][0];
  const up = paths.filter((path) => path.at(-1) > reference).length;
  return {
    paths,
    horizonMinutes: horizon,
    timestamp,
    reference,
    above: up / paths.length,
    up,
    down: paths.length - up,
    median: quantiles.median.at(-1),
    p10: quantiles.p10.at(-1),
    p90: quantiles.p90.at(-1),
    quantiles,
    calibrated: false,
    method: "weighted moving-block bootstrap",
  };
}

export function runTournament(options = {}) {
  const horizon = bounded(options.horizonMinutes, 15, 1, 30);
  const rounds = bounded(options.rounds, 12, 0, 32);
  const count = bounded(options.pathCount, 400, 40, 400);
  const futureCount = bounded(options.forecastPaths, 1000, 40, 1000);
  const seed = bounded(options.seed, 2710, 0, 0x7fffffff);
  const points = contiguousTail(minuteObservations(options.observations));
  const required = Math.max(240, 90 + horizon * 12 + 2);
  const agents = initializeAgents();
  if (points.length < required)
    return {
      status: "insufficient",
      reason: `Need ${required} consecutive completed minutes for past-only lookback, 8 calibration decisions and 4 untouched test decisions; have ${points.length}. Gaps restart the eligible segment.`,
      requiredMinutes: required,
      availableMinutes: points.length,
      agents,
      mutations: [],
      forecast: null,
      evaluation: null,
    };

  // These chronological boundaries depend on timestamps/count only, never prices.
  const trainCount = Math.max(
    90,
    Math.floor((points.length - 12 * horizon - 2) / 2),
  );
  const validationCount = Math.max(
    8 * horizon + 1,
    Math.floor((points.length - trainCount) * 0.65),
  );
  const testBegin = trainCount + validationCount;
  const validation = originsBetween(trainCount, testBegin, horizon);
  const test = originsBetween(testBegin, points.length, horizon);
  // Long inputs still use a fixed trial budget, retaining recent origins.
  const calibrationOrigins = validation.slice(-16);
  const testOrigins = test.slice(-8);
  const score = (config) =>
    scoreConfig(points, calibrationOrigins, config, horizon, count, seed);
  const baselineScore = score(BASELINE);
  for (const agent of agents) agent.score = score(agent.config);
  const mutations = [];
  const evolution = random(seed ^ 0x1827);
  const lifecycle = [];

  for (let round = 0; round < rounds; round++) {
    const ranked = agents
      .filter((a) => a.state === "active")
      .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
    const worst = ranked.at(-1);
    const candidate = mutate(worst.config, evolution, round);
    const beforeConfig = { ...worst.config };
    const candidateScore = score(candidate.config);
    const before = worst.score;
    const accepted = candidateScore < before - 1e-10;
    if (accepted) {
      worst.config = candidate.config;
      worst.score = candidateScore;
      worst.generation++;
    }
    mutations.push({
      round: round + 1,
      agentId: worst.id,
      change: `${candidate.field}: ${candidate.from} → ${candidate.to}`,
      field: candidate.field,
      beforeConfig,
      candidateConfig: candidate.config,
      before,
      after: candidateScore,
      accepted,
    });
    const reranked = agents
      .filter((a) => a.state === "active")
      .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
    const quartile = Math.max(1, Math.floor(reranked.length / 4));
    for (let rank = 0; rank < reranked.length; rank++) {
      const agent = reranked[rank];
      if (rank < quartile) agent.weight = Math.min(2.5, agent.weight * 1.05);
      if (rank >= reranked.length - quartile)
        agent.weight = Math.max(0.3, agent.weight * 0.95);
      agent.floorRounds = agent.weight <= 0.3 ? agent.floorRounds + 1 : 0;
      if (agent.floorRounds >= 8) {
        // Replace only the extinct slot; no claim of semantic knowledge-gap detection.
        const from = agent.id;
        const replacement = mutate(reranked[0].config, evolution, round + 1);
        lifecycle.push({
          round: round + 1,
          type: "replacement",
          agentId: from,
          reason: "eight rounds at minimum weight",
        });
        agent.name = `Replacement ${round + 1}`;
        agent.config = replacement.config;
        agent.score = score(agent.config);
        agent.weight = 1;
        agent.floorRounds = 0;
        agent.generation++;
      }
    }
  }

  // The final window is first scored after the entire configuration/weight search.
  // It is never used for mutation, agent selection, replacement or weighting.
  const testScore = scoreMixture(
    points,
    testOrigins,
    agents,
    horizon,
    count,
    seed + 452,
  );
  const baselineTestScore = scoreConfig(
    points,
    testOrigins,
    BASELINE,
    horizon,
    count,
    seed + 452,
  );
  const ensembleScore = scoreMixture(
    points,
    calibrationOrigins,
    agents,
    horizon,
    count,
    seed + 452,
  );
  const paths = weightedMixture(
    points,
    points.length - 1,
    agents,
    horizon,
    futureCount,
    seed + 829,
  );
  // The live forecast can start at the newest actual observation. Rebase the
  // already sampled percentage moves; partial-minute ticks never enter scoring.
  let latest = points.at(-1);
  for (const point of options.observations.slice(-200_000)) {
    if (
      point &&
      Number.isFinite(point.timestamp) &&
      Number.isFinite(point.price) &&
      point.price > 0 &&
      point.timestamp >= latest.timestamp
    )
      latest = point;
  }
  const rebase = latest.price / points.at(-1).price;
  for (const path of paths)
    for (let step = 0; step < path.length; step++) path[step] *= rebase;
  const describeOrigin = (origin) => ({
    timestamp: points[origin].timestamp,
    historyEnd: points[origin].timestamp,
    targetAt: points[origin + horizon].timestamp,
  });
  return {
    status: "ready",
    agents,
    mutations,
    lifecycle,
    forecast: summarizeForecast(paths, horizon, latest.timestamp),
    evaluation: {
      trainStart: points[0].timestamp,
      trainEnd: points[trainCount - 1].timestamp,
      validationStart: points[trainCount].timestamp,
      validationEnd: points[testBegin - 1].timestamp,
      testStart: points[testBegin].timestamp,
      testEnd: points.at(-1).timestamp,
      baselineScore,
      ensembleScore,
      testScore,
      baselineTestScore,
      observations: points.length,
      validationDecisions: calibrationOrigins.length,
      testDecisions: testOrigins.length,
      decisions: calibrationOrigins.length + testOrigins.length,
      heldOut: true,
      horizonMinutes: horizon,
      originStrideMinutes: horizon,
      trials: rounds,
      pathsPerTrial: count,
      seed,
      origins: {
        validation: calibrationOrigins.map(describeOrigin),
        test: testOrigins.map(describeOrigin),
      },
      metric: "mean pinball loss across p10 / p50 / p90, USD",
      warning:
        "Exploratory single-session holdout. Re-running on the same history reuses it; independent later sessions are still required. No trading costs or execution are modeled.",
    },
  };
}
