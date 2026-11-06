import { paperConfiguration } from "../dist/paper-engine.js";
export const CAPTURE_DEFAULTS = Object.freeze({
  maxDurationMs: 30 * 60000,
  maxBytes: 48 * 1024 ** 2,
  maxEvents: 200000,
  purpose: "development",
});
export function captureOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Capture settings must be an object.");
  for (const key of Object.keys(value))
    if (![...Object.keys(CAPTURE_DEFAULTS), "paperConfig"].includes(key))
      throw new Error(`Unknown capture setting: ${key}`);
  const plan = { ...CAPTURE_DEFAULTS, ...value };
  for (const [key, min, max] of [
    ["maxDurationMs", 1000, 12 * 3600000],
    ["maxBytes", 4096, 60 * 1024 ** 2],
    ["maxEvents", 4, 249000],
  ]) {
    if (!Number.isSafeInteger(plan[key]) || plan[key] < min || plan[key] > max)
      throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  if (!["development", "evaluation"].includes(plan.purpose))
    throw new Error("Choose development or evaluation purpose before capture.");
  if (
    value.paperConfig !== undefined &&
    (!value.paperConfig ||
      typeof value.paperConfig !== "object" ||
      Array.isArray(value.paperConfig))
  )
    throw new Error("Paper configuration must be an object.");
  const paperConfig = paperConfiguration(value.paperConfig ?? {});
  return {
    maxDuration: plan.maxDurationMs,
    maxBytes: plan.maxBytes,
    maxEvents: plan.maxEvents,
    experiment: {
      purpose: plan.purpose,
      paperConfig,
      engineVersion: 2,
      policies: ["baseline", "filter"],
      declaredAt: Date.now(),
      declaration:
        "Self-declared purpose; not proof of untouched data or exchange execution.",
    },
  };
}
