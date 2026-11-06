import { afterEach, expect, test } from "bun:test";
import {
  closeSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeskServer } from "../server/index.js";
import { checksum } from "../server/market.js";
import { Recorder } from "../server/recorder.js";

const disposals = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "desk-recorder-test-"));
  disposals.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function app() {
  const desk = createDeskServer({
    port: 0,
    dataDir: temporary(),
    connect: false,
  });
  disposals.push(() => desk.stop());
  const request = (path, options = {}) =>
    fetch(new URL(path, desk.server.url), options);
  return { ...desk, request };
}
const snapshot = () => {
  const asks = [{ price: "100.1", qty: "1.00000000" }];
  const bids = [{ price: "100.0", qty: "2.00000000" }];
  return {
    channel: "book",
    type: "snapshot",
    data: [
      {
        symbol: "BTC/USD",
        asks,
        bids,
        checksum: checksum(asks, bids),
        timestamp: "2026-11-04T12:00:00Z",
      },
    ],
  };
};

test("local API has explicit empty state; returns static assets; rejects Origin, Host, traversal", async () => {
  const desk = app();
  expect((await (await desk.request("/api/market")).json()).book).toEqual({
    asks: [],
    bids: [],
    timestamp: null,
    valid: false,
  });
  expect((await desk.request("/")).status).toBe(200);
  expect(
    (
      await desk.request("/api/record/start", {
        method: "POST",
        headers: { Origin: "https://attacker.test" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await desk.request("/api/status", { headers: { Host: "attacker.test" } }))
      .status,
  ).toBe(403);
  expect((await desk.request("/api/recordings/a%2F..%2Fsecret")).status).toBe(
    400,
  );
  expect((await desk.request("/api/recordings/missing")).status).toBe(404);
});

test("recorded export contains actual book, trades, gap and end; malformed book invalidates state", async () => {
  const desk = app();
  expect(desk.ingest(JSON.stringify(snapshot()), 1000)).toBe(true);
  expect(desk.status().bookValid).toBe(true);
  let response = await desk.request("/api/record/start", { method: "POST" });
  const first = await response.json();
  response = await desk.request("/api/record/start", { method: "POST" });
  expect((await response.json()).sessionId).toBe(first.sessionId);
  desk.ingest(
    JSON.stringify({
      channel: "trade",
      type: "update",
      data: [
        {
          symbol: "BTC/USD",
          price: 100.1,
          qty: 0.01,
          side: "buy",
          trade_id: 1,
          timestamp: "2026-11-04T12:00:01Z",
        },
      ],
    }),
  );
  // Same trade id must not be counted twice following a retry.
  desk.ingest(
    JSON.stringify({
      channel: "trade",
      type: "update",
      data: [
        {
          symbol: "BTC/USD",
          price: 100.1,
          qty: 0.01,
          side: "buy",
          trade_id: 1,
          timestamp: "2026-11-04T12:00:01Z",
        },
      ],
    }),
  );
  const bad = snapshot();
  bad.type = "update";
  bad.data[0].checksum = 0;
  expect(desk.ingest(JSON.stringify(bad))).toBe(false);
  expect(desk.status().bookValid).toBe(false);
  expect(desk.status().gaps).toBe(1);
  await desk.request("/api/record/stop", { method: "POST" });
  const rows = (
    await (
      await desk.request(`/api/recordings/${first.sessionId}.ndjson`)
    ).text()
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  expect(rows.map((row) => row.type)).toEqual([
    "session",
    "book",
    "trade",
    "gap",
    "end",
  ]);
  expect(rows[1].bids[0]).toEqual([100, 2]);
  expect(rows[2].price).toBe(100.1);
  expect(
    (await (await desk.request("/api/recordings")).json()).recordings[0].id,
  ).toBe(first.sessionId);
  expect(
    (await (await desk.request("/api/market")).json()).trades,
  ).toHaveLength(1);
});

test("recorder samples book cadence, appends all trades, and closes explicitly at duration limit", () => {
  const dir = temporary();
  const recorder = new Recorder(dir, { maxDuration: 2000 });
  recorder.start(null, 10000);
  recorder.record(
    { type: "book", timestamp: 10000, bids: [], asks: [] },
    10000,
  );
  recorder.record(
    { type: "book", timestamp: 10100, bids: [], asks: [] },
    10100,
  );
  recorder.record(
    { type: "trade", timestamp: 10100, price: 100, qty: 1 },
    10100,
  );
  recorder.record(
    { type: "trade", timestamp: 10110, price: 101, qty: 1 },
    10110,
  );
  recorder.record(
    { type: "book", timestamp: 11000, bids: [], asks: [] },
    11000,
  );
  recorder.record(
    { type: "trade", timestamp: 12000, price: 102, qty: 1 },
    12000,
  );
  expect(recorder.active).toBe(false);
  const rows = readFileSync(join(dir, `${recorder.id}.ndjson`), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  expect(rows.filter((row) => row.type === "book")).toHaveLength(2);
  expect(rows.filter((row) => row.type === "trade")).toHaveLength(2);
  expect(rows.at(-1).reason).toBe("Recording duration limit reached");
  expect(recorder.endReason).toBe("Recording duration limit reached");
});

test("socket subscribes to public depth500 and trades; checksum corruption closes the stream once", () => {
  const messages = [];
  const socket = {
    send(value) {
      messages.push(JSON.parse(value));
    },
    close() {
      this.onclose?.();
    },
  };
  const desk = createDeskServer({
    port: 0,
    dataDir: temporary(),
    socketFactory: () => socket,
  });
  disposals.push(() => desk.stop());
  socket.onopen();
  expect(messages.map((message) => message.params.channel)).toEqual([
    "book",
    "trade",
  ]);
  expect(messages[0].params.depth).toBe(500);
  expect(messages[1].params.snapshot).toBe(false);
  expect(desk.status().connected).toBe(true);
  socket.onmessage({ data: JSON.stringify(snapshot()) });
  expect(desk.status().bookValid).toBe(true);
  const corrupt = snapshot();
  corrupt.type = "update";
  corrupt.data[0].checksum = 1;
  socket.onmessage({ data: JSON.stringify(corrupt) });
  expect(desk.status().bookValid).toBe(false);
  expect(desk.status().connected).toBe(false);
  expect(desk.status().gaps).toBe(1);
  expect(desk.status().error).toMatch(/checksum/);
});

test("invalid recording fd closes logical recording state and leaves server shutdown safe", async () => {
  const desk = app();
  await desk.request("/api/record/start", { method: "POST" });
  closeSync(desk.recorder.fd);
  desk.ingest(JSON.stringify(snapshot()));
  expect(desk.status().recording).toBe(false);
  expect(desk.recorder.fd).toBe(null);
  expect(desk.status().recordingError).toMatch(/EBADF|Bad file descriptor/i);
  desk.ingest(JSON.stringify(snapshot()));
  expect(desk.status().recordingError).toMatch(/EBADF|Bad file descriptor/i);
  expect(() => desk.stop()).not.toThrow();
});

test("capture defaults admit a 272-minute research session and disclose cadence and limits", () => {
  const dir = temporary();
  const recorder = new Recorder(dir);
  recorder.start(null, 0);
  recorder.record(
    { type: "trade", timestamp: 273 * 60000, price: 100, qty: 1, side: "buy" },
    273 * 60000,
  );
  expect(recorder.active).toBe(true);
  recorder.stop("Test complete", 273 * 60000);
  const rows = readFileSync(join(dir, `${recorder.id}.ndjson`), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  expect(rows[0].maxDurationMs).toBe(12 * 60 * 60 * 1000);
  expect(rows[0].maxBytes).toBe(1024 * 1024 * 1024);
  expect(rows[0].bookSampleMs).toBe(1000);
  expect(rows.filter((row) => row.type === "trade")).toHaveLength(1);
});

test("live history retains 24h at 10s cadence and represents every completed minute", async () => {
  const desk = app();
  const start = Date.UTC(2026, 10, 3);
  for (let i = 0; i < 9000; i++) {
    const message = snapshot();
    message.data[0].timestamp = new Date(start + i * 10000).toISOString();
    desk.ingest(JSON.stringify(message), start + i * 10000);
  }
  const market = await (await desk.request("/api/market")).json();
  expect(market.history).toHaveLength(8640);
  expect(market.history.at(-1).timestamp - market.history[0].timestamp).toBe(
    8639 * 10000,
  );
  const minutes = new Set(
    market.history.map((point) => Math.floor(point.timestamp / 60000)),
  );
  expect(minutes.size).toBeGreaterThan(1439);
});

test("compact replay streams sampled actual events, retains gaps/final events, and preserves raw export", async () => {
  const desk = app();
  const id = "compact-test";
  const rows = [
    { type: "session", timestamp: 0 },
    {
      type: "book",
      timestamp: 0,
      bids: [[99, 1]],
      asks: [[101, 1]],
      valid: true,
    },
    { type: "trade", timestamp: 1000, price: 101, qty: 0.1, side: "buy" },
    { type: "trade", timestamp: 2000, price: 100, qty: 0.7, side: "sell" },
    {
      type: "book",
      timestamp: 20000,
      bids: [[98, 3]],
      asks: [[102, 2]],
      valid: true,
    },
    { type: "gap", timestamp: 25000, reason: "disconnected" },
    {
      type: "book",
      timestamp: 30000,
      bids: [[97, 3]],
      asks: [[103, 2]],
      valid: true,
    },
    { type: "trade", timestamp: 31000, price: 102, qty: 0.2, side: "buy" },
    { type: "end", timestamp: 32000 },
  ];
  const original = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(join(desk.recorder.directory, `${id}.ndjson`), original);
  const response = await desk.request(`/api/recordings/${id}/replay.ndjson`);
  expect(response.status).toBe(200);
  const compact = (await response.text()).trim().split("\n").map(JSON.parse);
  expect(compact[0].replaySampling.tradeSampleMs).toBe(10000);
  expect(
    compact
      .filter((row) => row.type === "book")
      .map((row) => row.timestamp)
      .sort((a, b) => a - b),
  ).toEqual([20000, 30000]);
  expect(
    compact
      .filter((row) => row.type === "trade")
      .map((row) => row.qty)
      .sort(),
  ).toEqual([0.2, 0.7]);
  expect(
    compact.some((row) => row.type === "gap" && row.reason === "disconnected"),
  ).toBe(true);
  expect(await (await desk.request(`/api/recordings/${id}`)).text()).toBe(
    original,
  );
  const status = await (
    await desk.request("/api/record/start", { method: "POST" })
  ).json();
  expect(
    (await desk.request(`/api/recordings/${status.sessionId}/replay.ndjson`))
      .status,
  ).toBe(409);
  await desk.request("/api/record/stop", { method: "POST" });
});

test("disk failure survives valid book updates and clears only after a successful new recording", async () => {
  const desk = app();
  const base = Date.now();
  const message = snapshot();
  message.data[0].timestamp = new Date(base).toISOString();
  desk.ingest(JSON.stringify(message), base);
  await desk.request("/api/record/start", { method: "POST" });
  const append = desk.recorder.append;
  desk.recorder.append = () => {
    throw new Error("ENOSPC: no space left on device");
  };
  message.data[0].timestamp = new Date(base + 2000).toISOString();
  desk.ingest(JSON.stringify(message), base + 2000);
  expect(desk.status().recording).toBe(false);
  expect(desk.status().recordingError).toMatch(/ENOSPC/);
  expect(desk.status().recordingEndReason).toMatch(/ENOSPC/);
  message.data[0].timestamp = new Date(base + 2100).toISOString();
  desk.ingest(JSON.stringify(message), base + 2100);
  expect(desk.status().bookValid).toBe(true);
  expect(desk.status().error).toMatch(/ENOSPC/);
  expect(desk.status().recordingError).toMatch(/ENOSPC/);
  expect(
    (await desk.request("/api/record/start", { method: "POST" })).status,
  ).toBe(500);
  expect(desk.status().recordingError).toMatch(/ENOSPC/);
  desk.recorder.append = append;
  expect(
    (await desk.request("/api/record/start", { method: "POST" })).status,
  ).toBe(200);
  expect(desk.status().recordingError).toBe(null);
  expect(desk.status().recordingEndReason).toBe(null);
  await desk.request("/api/record/stop", { method: "POST" });
  message.data[0].timestamp = new Date(base + 2200).toISOString();
  desk.ingest(JSON.stringify(message), base + 2200);
  expect(desk.status().recordingEndReason).toBe("Stopped by user");
});

test("byte-limit stop reason remains visible after subsequent healthy market updates", async () => {
  const desk = app();
  await desk.request("/api/record/start", { method: "POST" });
  desk.recorder.maxBytes = 1;
  desk.ingest(JSON.stringify(snapshot()));
  desk.ingest(JSON.stringify(snapshot()));
  expect(desk.status().recording).toBe(false);
  expect(desk.status().recordingEndReason).toBe("Recording byte limit reached");
  expect(desk.status().recordingError).toBe(null);
});

test("recorded and compact observations equal live MID/top25 history; trades cannot contaminate features", async () => {
  const desk = app();
  const base = Date.now();
  const status = await (
    await desk.request("/api/record/start", { method: "POST" })
  ).json();
  const message = snapshot();
  const data = message.data[0];
  data.bids = Array.from({ length: 26 }, (_, i) => ({
    price: (100 - i * 0.1).toFixed(1),
    qty: i === 25 ? "1000.0" : "2.0",
  }));
  data.asks = Array.from({ length: 26 }, (_, i) => ({
    price: (100.1 + i * 0.1).toFixed(1),
    qty: "1.0",
  }));
  data.checksum = checksum(data.asks, data.bids);
  for (const offset of [1000, 2000, 11000, 21000]) {
    data.timestamp = new Date(base + offset).toISOString();
    desk.ingest(JSON.stringify(message), base + offset + 500);
  }
  desk.ingest(
    JSON.stringify({
      channel: "trade",
      type: "update",
      data: [
        {
          symbol: "BTC/USD",
          price: 900,
          qty: 1,
          side: "buy",
          trade_id: 1000,
          timestamp: new Date(base + 22000).toISOString(),
        },
      ],
    }),
    base + 22500,
  );
  const market = await (await desk.request("/api/market")).json();
  expect(market.history).toHaveLength(3);
  expect(market.history[0].price).toBeCloseTo(100.05, 10);
  expect(market.history[0].imbalance).toBeCloseTo(1 / 3, 10);
  expect(market.history.every((point) => point.price !== 900)).toBe(true);
  await desk.request("/api/record/stop", { method: "POST" });
  const decode = async (path) =>
    (await (await desk.request(path)).text())
      .trim()
      .split("\n")
      .map(JSON.parse);
  const raw = await decode(`/api/recordings/${status.sessionId}`);
  const compact = await decode(
    `/api/recordings/${status.sessionId}/replay.ndjson`,
  );
  for (const rows of [raw, compact]) {
    const observations = rows.filter((event) => event.type === "observation");
    expect(
      observations.map(({ timestamp, price, imbalance }) => ({
        timestamp,
        price,
        imbalance,
      })),
    ).toEqual(market.history);
    expect(observations[0].receiveTimestamp).toBe(base + 1500);
  }
  // A corrupt stream clears the usable feature segment; trade tape remains separate.
  const bad = snapshot();
  bad.data[0].checksum = 0;
  desk.ingest(JSON.stringify(bad), base + 23000);
  desk.ingest(
    JSON.stringify({
      channel: "trade",
      type: "update",
      data: [
        {
          symbol: "BTC/USD",
          price: 900,
          qty: 1,
          side: "buy",
          trade_id: 1001,
          timestamp: new Date(base + 24000).toISOString(),
        },
      ],
    }),
    base + 24500,
  );
  expect((await (await desk.request("/api/market")).json()).history).toEqual(
    [],
  );
});

test("live trade API is chronological and the UI tail selects the newest nine", async () => {
  const desk = app();
  for (let i = 1; i <= 120; i++) {
    expect(
      desk.ingest(
        JSON.stringify({
          channel: "trade",
          type: "update",
          data: [
            {
              symbol: "BTC/USD",
              price: 100 + i,
              qty: 1,
              side: "buy",
              trade_id: i,
              timestamp: new Date(i * 1000).toISOString(),
            },
          ],
        }),
        i * 1000,
      ),
    ).toBe(true);
  }
  const payload = await (
    await fetch(new URL("/api/market", desk.server.url))
  ).json();
  expect(payload.trades).toHaveLength(100);
  expect(
    payload.trades
      .map((t) => t.price)
      .slice(-9)
      .reverse(),
  ).toEqual([220, 219, 218, 217, 216, 215, 214, 213, 212]);
  expect(payload.history).toHaveLength(0); // trade prints never replace book-mid research observations
});
