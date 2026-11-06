// Summaries are descriptive and local to this browser. Full input remains in the
// separately exported paper receipt and original recording, never localStorage.
export const HISTORY_KEY = "desk-paper-history-v1";
const utf8Size = (text) => new TextEncoder().encode(text).byteLength;
export function experimentSummary(receipt, now = Date.now()) {
  const { input, result } = receipt;
  const declaration = input.metadata?.experiment;
  const frozen = declaration?.paperConfig;
  const matching =
    frozen &&
    Object.entries(result.config).every(
      ([key, value]) => frozen[key] === value,
    );
  const recordedEnd = Object.hasOwn(input.metadata ?? {}, "recordingEndedAt")
    ? input.metadata.recordingEndedAt
    : input.metadata?.endedAt;
  const complete =
    Number.isFinite(recordedEnd) &&
    typeof input.metadata?.endReason === "string" &&
    Boolean(input.metadata.endReason);
  const fullSession = complete && result.end === recordedEnd;
  const synthetic = receipt.sourceLabel === "SYNTHETIC PAPER FIXTURE";
  const declaredPurpose = ["development", "evaluation"].includes(
    declaration?.purpose,
  )
    ? declaration.purpose
    : "unassigned";
  const purpose = synthetic ? "synthetic" : declaredPurpose;
  const plannedStop = [
    "Recording duration limit reached",
    "Recording byte limit reached",
    "Recording event limit reached",
  ].includes(input.metadata?.endReason);
  const mode =
    !synthetic &&
    purpose === "evaluation" &&
    matching &&
    fullSession &&
    plannedStop &&
    declaration.engineVersion === result.version
      ? "DECLARED EVALUATION"
      : "EXPLORATORY";
  const gaps = input.events.filter((e) => e.type === "gap").length;
  const fills = result.policies.reduce((n, p) => n + p.metrics.fillCount, 0);
  const issues = [
    !complete && "MISSING END / INCOMPLETE",
    !fullSession && complete && "PARTIAL REPLAY",
    complete && !plannedStop && "UNPLANNED / MANUAL STOP",
    gaps > 0 && `${gaps} GAP EVENTS`,
    !result.valuation.fresh && "STALE FINAL VALUATION",
    result.timing.missingReceiveTimes > 0 && "RECEIVE TIMES MISSING",
    !fills && "NO FILLS",
    frozen && !matching && "CONFIG OVERRIDE",
    !frozen && "NO CAPTURE PLAN",
    declaration &&
      declaredPurpose === "unassigned" &&
      "INVALID CAPTURE PURPOSE",
    declaration?.engineVersion !== undefined &&
      declaration.engineVersion !== result.version &&
      "ENGINE VERSION DIFFERS",
    "INSUFFICIENT EVIDENCE OF SKILL",
  ].filter(Boolean);
  return {
    version: 1,
    key: `${result.version}:${receipt.inputSha256}:${JSON.stringify(result.config)}`,
    inputSha256: receipt.inputSha256,
    sourceLabel: receipt.sourceLabel,
    sessionId: input.metadata?.id ?? null,
    savedAt: now,
    start: result.start,
    end: result.end,
    purpose,
    mode,
    configMatchesCapture: Boolean(matching),
    capturePlan: declaration ?? null,
    config: result.config,
    engineVersion: result.version,
    complete,
    endReason:
      typeof input.metadata?.endReason === "string"
        ? input.metadata.endReason
        : "Missing or invalid end metadata",
    gaps,
    eventCount: input.events.length,
    timing: result.timing,
    valuation: result.valuation,
    issues,
    policies: result.policies.map((p) => ({
      id: p.id,
      label: p.label,
      metrics: p.metrics,
    })),
    comparison: result.comparison,
  };
}
function validSummary(row) {
  return (
    row?.version === 1 &&
    typeof row.key === "string" &&
    typeof row.inputSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(row.inputSha256) &&
    Number.isFinite(row.start) &&
    row.start >= 0 &&
    row.start <= 8640000000000000 &&
    Number.isFinite(row.end) &&
    row.end >= row.start &&
    row.end <= 8640000000000000 &&
    ["synthetic", "development", "evaluation", "unassigned"].includes(
      row.purpose,
    ) &&
    ["DECLARED EVALUATION", "EXPLORATORY"].includes(row.mode) &&
    typeof row.sourceLabel === "string" &&
    typeof row.endReason === "string" &&
    Array.isArray(row.issues) &&
    row.issues.every((issue) => typeof issue === "string") &&
    Array.isArray(row.policies) &&
    row.policies.length === 2 &&
    row.policies.every(
      (policy) =>
        typeof policy?.label === "string" &&
        policy.metrics &&
        typeof policy.metrics === "object" &&
        policy.metrics.markouts?.["60s"] &&
        typeof policy.metrics.markouts["60s"] === "object",
    )
  );
}
export function saveExperiment(summary, storage) {
  if (!validSummary(summary))
    throw new Error("Experiment summary is invalid; no history was changed.");
  const saved = readExperiments(storage);
  if (saved.some((row) => row.key === summary.key)) return saved;
  if (saved.length >= 100)
    throw new Error(
      "History is full (100 results). Export summaries; no existing result was removed.",
    );
  const next = [summary, ...saved];
  const text = JSON.stringify(next);
  if (utf8Size(text) > 2 * 1024 * 1024)
    throw new Error(
      "History would exceed 2 MiB; no existing result was removed.",
    );
  storage.setItem(HISTORY_KEY, text);
  return next;
}
export function readExperiments(storage) {
  const text = storage.getItem(HISTORY_KEY);
  if (!text) return [];
  if (utf8Size(text) > 2 * 1024 * 1024)
    throw new Error(
      "Stored experiment history exceeds 2 MiB; existing data was preserved.",
    );
  const rows = JSON.parse(text);
  if (
    !Array.isArray(rows) ||
    rows.length > 100 ||
    rows.some((row) => !validSummary(row))
  )
    throw new Error(
      "Stored experiment history is invalid; existing data was preserved.",
    );
  return rows;
}

// All browser writers must share this origin-scoped lock. No unlocked fallback:
// an unavailable lock leaves the current full receipt exportable, not lost.
export async function saveExperimentLocked(summary, storage, locks) {
  if (!locks?.request)
    throw new Error(
      "Safe cross-tab history saving requires Web Locks on localhost.",
    );
  return locks.request(
    HISTORY_KEY,
    { mode: "exclusive", signal: AbortSignal.timeout(5000) },
    () => saveExperiment(summary, storage),
  );
}
