import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeskServer } from "../server/index.js";
import { checksum } from "../server/market.js";
import { Recorder } from "../server/recorder.js";
import { parseRecording, replayFrame } from "../dist/replay.js";
const cleanup = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function directory() {
  const d = mkdtempSync(join(tmpdir(), "desk-review-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
function wireBook(timestamp, depth = 1) {
  const bids = Array.from({ length: depth }, (_, i) => ({
    price: String(1000 - i),
    qty: "1.00000000",
  }));
  const asks = Array.from({ length: depth }, (_, i) => ({
    price: String(1001 + i),
    qty: "1.00000000",
  }));
  return JSON.stringify({
    channel: "book",
    type: "snapshot",
    data: [
      {
        symbol: "BTC/USD",
        bids,
        asks,
        checksum: checksum(asks, bids),
        timestamp: new Date(timestamp).toISOString(),
      },
    ],
  });
}
function wireTrades(ids, timestamp) {
  return JSON.stringify({
    channel: "trade",
    data: ids.map((id, i) => ({
      symbol: "BTC/USD",
      trade_id: id,
      price: 1000 + i,
      qty: 0.01,
      side: "buy",
      timestamp: new Date(timestamp + i).toISOString(),
    })),
  });
}
function server() {
  const app = createDeskServer({
    port: 0,
    dataDir: directory(),
    connect: false,
  });
  cleanup.push(() => app.stop());
  return app;
}
function recorded(app) {
  return readFileSync(
    join(app.recorder.directory, `${app.recorder.id}.ndjson`),
    "utf8",
  );
}

test("unseen out-of-order trade IDs are retained and repeats deduplicated in raw acquisition", () => {
  const app = server(),
    now = Date.now();
  app.ingest(wireBook(now), now);
  app.recorder.start(app.book.snapshot(), now);
  app.ingest(wireTrades([102, 101, 102], now + 1), now + 10);
  app.recorder.stop("test", now + 20);
  const rows = recorded(app).trim().split("\n").map(JSON.parse);
  expect(rows.filter((e) => e.type === "trade")).toHaveLength(2);
  expect(rows.filter((e) => e.type === "trade").map((e) => e.price)).toEqual([
    1000, 1001,
  ]);
});
test("gap marker preserves valid pre-failure exchange frames despite recorder clock offset", () => {
  const app = server();
  app.ingest(wireBook(10000), 12000);
  app.recorder.start(app.book.snapshot(), 12000);
  app.ingest('{"success":false,"error":"fixture disconnect"}', 15000);
  app.recorder.stop("test", 15001);
  const parsed = parseRecording(recorded(app));
  expect(parsed.gaps[0].timestamp).toBe(13000);
  expect(parsed.gaps[0].receiveTimestamp).toBe(15000);
  expect(replayFrame(parsed, 12500).book.valid).toBe(true);
  expect(replayFrame(parsed, 13000).book.valid).toBe(false);
});
test("first recovery book after a gap bypasses cadence throttle", () => {
  const d = directory(),
    r = new Recorder(d);
  r.start(null, 0);
  r.record(
    {
      type: "book",
      timestamp: 10,
      receiveTimestamp: 10,
      bids: [[100, 1]],
      asks: [[101, 1]],
      valid: true,
    },
    10,
  );
  r.record(
    {
      type: "gap",
      timestamp: 250,
      receiveTimestamp: 250,
      reason: "disconnect",
    },
    250,
  );
  r.record(
    {
      type: "book",
      timestamp: 500,
      receiveTimestamp: 500,
      bids: [[100, 2]],
      asks: [[101, 2]],
      valid: true,
    },
    500,
  );
  r.stop("test", 600);
  const parsed = parseRecording(
    readFileSync(join(d, `${r.id}.ndjson`), "utf8"),
  );
  expect(parsed.books).toHaveLength(2);
  expect(replayFrame(parsed, 600).book.valid).toBe(true);
});
test("timer end-write failure reaches status and a successful immediate-limit start clears it", async () => {
  const app = server(),
    now = Date.now();
  app.ingest(wireBook(now, 300), now);
  const started = await fetch(new URL("/api/record/start", app.server.url), {
    method: "POST",
    body: JSON.stringify({ maxDurationMs: 1000 }),
  });
  expect(started.status).toBe(200);
  const append = app.recorder.append;
  app.recorder.append = function (event) {
    if (event.type === "end") throw new Error("ENOSPC: timer fixture");
    return append.call(this, event);
  };
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(app.status().recording).toBe(false);
  expect(app.status().recordingError).toMatch(/ENOSPC/);
  expect(app.status().error).toMatch(/ENOSPC/);
  app.recorder.append = append;
  const restarted = await fetch(new URL("/api/record/start", app.server.url), {
    method: "POST",
    body: JSON.stringify({ maxBytes: 4096 }),
  });
  expect(restarted.status).toBe(200);
  const state = await restarted.json();
  expect(state.recording).toBe(false);
  expect(state.recordingEndReason).toMatch(/byte limit/);
  expect(state.recordingError).toBe(null);
  expect(state.error).toBe(null);
});
test("heartbeats and trades do not refresh the book receipt clock", () => {
  const app = server();
  app.ingest(wireBook(10000), 11000);
  app.ingest('{"channel":"heartbeat"}', 40000);
  app.ingest(wireTrades([5], 40000), 40000);
  expect(app.status().lastMessageAt).toBe(40000);
  expect(app.status().lastBookMessageAt).toBe(11000);
  expect(app.book.snapshot().timestamp).toBe(10000);
});
