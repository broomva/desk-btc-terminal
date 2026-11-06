import { normal, random } from "./engine.js";

// Illustrative random walks, independent of the live spot feed and odds model.
export function sampleProjection(count, secondsLeft, volatility, seed) {
  const rng = random(seed);
  const steps = 32;
  const paths = Array.from({ length: count }, () => {
    let value = 0;
    return Array.from({ length: steps + 1 }, (_, i) => {
      if (i > 0)
        value +=
          normal(rng) *
          3.8 *
          volatility *
          Math.sqrt(Math.max(secondsLeft, 1) / steps);
      return value;
    });
  });
  const quantile = (values, q) => {
    const position = (values.length - 1) * q;
    const lower = Math.floor(position);
    return (
      values[lower] +
      (values[Math.ceil(position)] - values[lower]) * (position - lower)
    );
  };
  const median = [],
    p10 = [],
    p90 = [];
  for (let step = 0; step <= steps; step++) {
    const sorted = paths.map((path) => path[step]).sort((a, b) => a - b);
    median.push(quantile(sorted, 0.5));
    p10.push(quantile(sorted, 0.1));
    p90.push(quantile(sorted, 0.9));
  }
  const up = paths.filter((path) => path.at(-1) >= 0).length;
  return { paths, median, p10, p90, up, down: count - up, count };
}
