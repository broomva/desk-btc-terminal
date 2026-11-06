import { expect, test } from "bun:test";
import { paperFixture } from "../dist/paper-fixture.js";
import { runPaperExperiment } from "../dist/paper-engine.js";
import {
  experimentSummary,
  saveExperiment,
  saveExperimentLocked,
  readExperiments,
} from "../dist/experiment-results.js";
function receipt() {
  const input = paperFixture();
  const result = runPaperExperiment(input);
  input.metadata.endedAt = result.end;
  input.metadata.endReason = "Recording duration limit reached";
  input.metadata.experiment = {
    purpose: "evaluation",
    paperConfig: { ...result.config },
    engineVersion: 2,
  };
  return {
    input,
    result,
    inputSha256: "a".repeat(64),
    sourceLabel: "IMPORTED / SELF-DECLARED: Kraken",
  };
}
test("evaluation declaration requires same frozen config and full ended session; changing assumptions is exploratory", () => {
  const r = receipt();
  expect(experimentSummary(r).mode).toBe("DECLARED EVALUATION");
  r.result.config.makerFeeBps++;
  expect(experimentSummary(r).mode).toBe("EXPLORATORY");
  expect(experimentSummary(r).issues).toContain("CONFIG OVERRIDE");
});
test("incomplete and partial captures cannot become declared evaluation; synthetic never real evaluation", () => {
  const r = receipt();
  r.input.metadata.endedAt++;
  expect(experimentSummary(r).mode).toBe("EXPLORATORY");
  expect(experimentSummary(r).issues).toContain("PARTIAL REPLAY");
  delete r.input.metadata.endReason;
  expect(experimentSummary(r).issues).toContain("MISSING END / INCOMPLETE");
  r.sourceLabel = "SYNTHETIC PAPER FIXTURE";
  expect(experimentSummary(r).purpose).toBe("synthetic");
  expect(experimentSummary(r).mode).toBe("EXPLORATORY");
});
test("history retains different assumptions, deduplicates exact runs, and never evicts existing results", () => {
  let value;
  const storage = {
    getItem: () => value,
    setItem: (_, v) => {
      value = v;
    },
  };
  const s = experimentSummary(receipt());
  expect(saveExperiment(s, storage)).toHaveLength(1);
  expect(saveExperiment(s, storage)).toHaveLength(1);
  for (let i = 1; i < 100; i++)
    saveExperiment({ ...s, key: String(i) }, storage);
  expect(() => saveExperiment({ ...s, key: "overflow" }, storage)).toThrow(
    /full/,
  );
  expect(readExperiments(storage)).toHaveLength(100);
  expect(readExperiments(storage)[99].inputSha256).toBe(s.inputSha256);
});

test("original acquisition end prevents a scrubbed replay being labeled evaluation", () => {
  const r = receipt();
  r.input.metadata.recordingEndedAt = r.result.end + 1000;
  expect(experimentSummary(r).mode).toBe("EXPLORATORY");
  expect(experimentSummary(r).issues).toContain("PARTIAL REPLAY");
  r.input.metadata.recordingEndedAt = r.result.end;
  r.input.metadata.experiment.engineVersion = 1;
  expect(experimentSummary(r).mode).toBe("EXPLORATORY");
});
test("blocked storage fails without altering current result or corrupting existing history", () => {
  const s = experimentSummary(receipt());
  const old = JSON.stringify([s]);
  const blocked = {
    getItem: () => old,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  expect(() => saveExperiment({ ...s, key: "new" }, blocked)).toThrow(
    /QuotaExceededError/,
  );
  expect(readExperiments(blocked)).toHaveLength(1);
  expect(s.policies).toHaveLength(2);
});

test("unsupported cross-tab locking refuses saving instead of silently falling back", async () => {
  const s = experimentSummary(receipt());
  let wrote = false;
  await expect(
    saveExperimentLocked(
      s,
      {
        getItem: () => null,
        setItem: () => {
          wrote = true;
        },
      },
      null,
    ),
  ).rejects.toThrow(/Web Locks/);
  expect(wrote).toBe(false);
});

test("malformed optional import purpose becomes unassigned and cannot poison history", () => {
  const r = receipt();
  r.input.metadata.experiment.purpose = { unexpected: true };
  const s = experimentSummary(r);
  expect(s.purpose).toBe("unassigned");
  expect(s.mode).toBe("EXPLORATORY");
  expect(s.issues).toContain("INVALID CAPTURE PURPOSE");
  let value;
  const storage = {
    getItem: () => value,
    setItem: (_, v) => {
      value = v;
    },
  };
  saveExperiment(s, storage);
  expect(readExperiments(storage)[0].purpose).toBe("unassigned");
  expect(() =>
    saveExperiment({ ...s, key: "bad", purpose: {} }, storage),
  ).toThrow(/invalid/);
  expect(readExperiments(storage)).toHaveLength(1);
});

test("unplanned stops are exploratory and oversized summaries cannot poison future reads", () => {
  const r = receipt();
  for (const reason of [
    "Server stopped",
    "Recording failed: ENOSPC",
    "Stopped by user",
  ]) {
    r.input.metadata.endReason = reason;
    expect(experimentSummary(r).mode).toBe("EXPLORATORY");
    expect(experimentSummary(r).issues).toContain("UNPLANNED / MANUAL STOP");
  }
  let value;
  const storage = {
    getItem: () => value,
    setItem: (_, v) => {
      value = v;
    },
  };
  const s = experimentSummary(r);
  expect(() =>
    saveExperiment({ ...s, sourceLabel: "x".repeat(3 * 1024 ** 2) }, storage),
  ).toThrow(/exceed 2 MiB/);
  expect(readExperiments(storage)).toHaveLength(0);
  expect(() => saveExperiment({ version: 1, policies: [] }, storage)).toThrow(
    /invalid/,
  );
});

test("history byte budget uses UTF-8 for save and read without overwriting existing data", () => {
  const s = experimentSummary(receipt());
  let text = null;
  const storage = {
    getItem: () => text,
    setItem: (_, value) => {
      text = value;
    },
  };
  saveExperiment(s, storage);
  const original = text;
  expect(() =>
    saveExperiment(
      { ...s, key: "unicode", endReason: "漢".repeat(750000) },
      storage,
    ),
  ).toThrow(/exceed 2 MiB/);
  expect(text).toBe(original);
  text = JSON.stringify([{ ...s, endReason: "漢".repeat(750000) }]);
  const oversized = text;
  expect(() => readExperiments(storage)).toThrow(/exceeds 2 MiB/);
  expect(text).toBe(oversized);
});
