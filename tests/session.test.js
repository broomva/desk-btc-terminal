import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder } from "../server/recorder.js";
import { createDeskServer } from "../server/index.js";
const cleanup = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function dir() {
  const d = mkdtempSync(join(tmpdir(), "desk-session-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
function rows(r) {
  return readFileSync(join(r.directory, `${r.id}.ndjson`), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
}
test("strict byte cap reserves an end marker and never appends an oversized event", () => {
  const r = new Recorder(dir(), { maxBytes: 4096 });
  r.start(null, 0);
  r.record({ type: "trade", timestamp: 1, payload: "x".repeat(5000) }, 1);
  expect(r.active).toBe(false);
  expect(
    statSync(join(r.directory, `${r.id}.ndjson`)).size,
  ).toBeLessThanOrEqual(4096);
  expect(rows(r).at(-1).type).toBe("end");
  expect(rows(r).some((e) => e.type === "trade")).toBe(false);
});
test("line cap includes session and end; quota refuses a new session without deleting files", () => {
  const d = dir();
  const r = new Recorder(d, {
    maxEvents: 4,
    maxBytes: 4096,
    maxDirectoryBytes: 8192,
  });
  r.start(null, 0);
  r.record({ type: "trade", timestamp: 1 }, 1);
  r.record({ type: "trade", timestamp: 2 }, 2);
  expect(r.active).toBe(false);
  expect(rows(r)).toHaveLength(4);
  expect(rows(r).at(-1).reason).toMatch(/event limit/);
  writeFileSync(join(d, "other.ndjson"), "x".repeat(8192));
  expect(() => r.start(null, 3)).toThrow(/storage quota/);
  expect(statSync(join(d, "other.ndjson")).size).toBe(8192);
});
test("silent capture stops on deadline without needing market messages", async () => {
  const r = new Recorder(dir(), { maxDuration: 30 });
  r.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(r.active).toBe(false);
  expect(rows(r).at(-1).reason).toMatch(/duration limit/);
});
test("API freezes capture purpose/config, validates bounds, and rejects active raw reads", async () => {
  const app = createDeskServer({ port: 0, dataDir: dir(), connect: false });
  cleanup.push(() => app.stop());
  const req = (p, body) =>
    fetch(
      new URL(p, app.server.url),
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  const bad = await req("/api/record/start", { maxBytes: 70 * 1024 * 1024 });
  expect(bad.status).toBe(400);
  const res = await req("/api/record/start", {
    maxBytes: 4096,
    maxDurationMs: 60000,
    purpose: "evaluation",
    paperConfig: { makerFeeBps: 12 },
  });
  expect(res.status).toBe(200);
  const status = await res.json();
  expect(status.capture.purpose).toBe("evaluation");
  expect(status.capture.paperConfig.makerFeeBps).toBe(12);
  expect((await req(`/api/recordings/${status.sessionId}`)).status).toBe(409);
  await req("/api/record/stop", {});
  const text = await (await req(`/api/recordings/${status.sessionId}`)).text();
  expect(
    JSON.parse(text.split("\n")[0]).experiment.paperConfig.makerFeeBps,
  ).toBe(12);
  expect((await req("/api/status")).status).toBe(200);
});

test("a stopped session's old timer cannot close the next session; UTF-8 bytes stay under cap", async () => {
  const r = new Recorder(dir(), { maxBytes: 4096, maxDuration: 40 });
  r.start();
  r.stop();
  r.start(null, Date.now(), { maxDuration: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(r.active).toBe(true);
  r.record({
    type: "trade",
    timestamp: Date.now(),
    payload: "💥".repeat(1000),
  });
  expect(r.active).toBe(false);
  expect(
    statSync(join(r.directory, `${r.id}.ndjson`)).size,
  ).toBeLessThanOrEqual(4096);
  expect(rows(r).at(-1).type).toBe("end");
});
test("an oversized initial book produces a closed, bounded file rather than an over-cap session", () => {
  const r = new Recorder(dir(), { maxBytes: 4096 });
  r.start(
    {
      valid: true,
      timestamp: 0,
      bids: [[100, 1]],
      asks: [[101, 1]],
      payload: "x".repeat(5000),
    },
    0,
  );
  expect(r.active).toBe(false);
  expect(rows(r).map((e) => e.type)).toEqual(["session", "end"]);
  expect(
    statSync(join(r.directory, `${r.id}.ndjson`)).size,
  ).toBeLessThanOrEqual(4096);
});

test("API rejects malformed/oversized plans, preserves frozen active plan, and reports quota without deleting", async () => {
  const d = dir();
  const app = createDeskServer({ port: 0, dataDir: d, connect: false });
  cleanup.push(() => app.stop());
  const post = (body) =>
    fetch(new URL("/api/record/start", app.server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const bad of [
    null,
    [],
    { purpose: "profit" },
    { maxDurationMs: 999 },
    { maxEvents: 4.5 },
    { unknown: 1 },
    { paperConfig: null },
    { paperConfig: { makerFeeBps: -1 } },
  ])
    expect((await post(bad)).status).toBe(400);
  expect((await post({ padding: "x".repeat(9000) })).status).toBe(413);
  const first = await (
    await post({
      maxBytes: 4096,
      purpose: "evaluation",
      paperConfig: { makerFeeBps: 14 },
    })
  ).json();
  expect((await post({ paperConfig: { makerFeeBps: 0 } })).status).toBe(409);
  expect((await post({})).status).toBe(200);
  expect(app.status().capture.paperConfig.makerFeeBps).toBe(14);
  expect(app.status().sessionId).toBe(first.sessionId);
  app.recorder.stop();
  writeFileSync(join(d, "preserved.ndjson"), "untouched");
  app.recorder.maxDirectoryBytes = 4096;
  expect((await post({ maxBytes: 4096 })).status).toBe(507);
  expect(readFileSync(join(d, "preserved.ndjson"), "utf8")).toBe("untouched");
});
test("capture config is cloned at start and clock lead is observed rather than certified", () => {
  const r = new Recorder(dir(), { maxBytes: 8192 });
  const plan = { purpose: "evaluation", paperConfig: { makerFeeBps: 12 } };
  r.start(null, 10000, { experiment: plan });
  plan.paperConfig.makerFeeBps = 0;
  r.record(
    {
      type: "trade",
      timestamp: 12500,
      receiveTimestamp: 10001,
      price: 100,
      qty: 1,
      side: "buy",
    },
    10001,
  );
  expect(r.capture.paperConfig.makerFeeBps).toBe(12);
  expect(r.clock.observedMaxExchangeLeadMs).toBe(2499);
  r.stop("done", 10002);
  expect(rows(r)[0].experiment.paperConfig.makerFeeBps).toBe(12);
});

test("escaped terminal reasons fit the reserved UTF-8 end record", () => {
  const r = new Recorder(dir(), { maxBytes: 4096 });
  r.start(null, 0);
  for (let i = 1; i < 200 && r.active && r.bytes < 2850; i++)
    r.record(
      { type: "trade", timestamp: i, price: 100, qty: 1, side: "buy" },
      i,
    );
  expect(r.active).toBe(true);
  r.stop("\ud800".repeat(200), 500);
  expect(
    statSync(join(r.directory, `${r.id}.ndjson`)).size,
  ).toBeLessThanOrEqual(4096);
  expect(
    Buffer.byteLength(JSON.stringify(rows(r).at(-1))) + 1,
  ).toBeLessThanOrEqual(1024);
});
