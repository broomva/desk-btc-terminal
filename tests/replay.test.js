import { expect, test } from "bun:test";
import { demoRecording, parseRecording, replayFrame } from "../dist/replay.js";

const book = (timestamp, bid = 100) => ({
  type: "book",
  timestamp,
  valid: true,
  bids: [[bid, 2]],
  asks: [[bid + 1, 3]],
});
const trade = (timestamp, price) => ({
  type: "trade",
  timestamp,
  price,
  qty: 1,
  side: "buy",
});
const text = (events) => events.map(JSON.stringify).join("\n");

test("replay never exposes a later book, trade or observation", () => {
  const recording = parseRecording(
    text([book(1000), trade(1500, 100.5), book(3000, 200), trade(3500, 201)]),
  );
  const frame = replayFrame(recording, 2000);
  expect(frame.book.bids[0][0]).toBe(100);
  expect(frame.trades.map((t) => t.price)).toEqual([100.5]);
  expect(frame.history.every((o) => o.timestamp <= 2000)).toBe(true);
  expect(replayFrame(recording, 500).book.valid).toBe(false);
});

test("recorded gaps invalidate the book until a subsequent valid snapshot", () => {
  const recording = parseRecording(
    text([
      book(1000),
      { type: "gap", timestamp: 2000, reason: "checksum" },
      book(4000, 102),
    ]),
  );
  expect(replayFrame(recording, 3000).book.valid).toBe(false);
  expect(replayFrame(recording, 4000).book.valid).toBe(true);
  expect(replayFrame(recording, 4000).status.gaps).toBe(1);
});

test("imports reject malformed data instead of producing plausible prices", () => {
  expect(() => parseRecording("{not JSON}")).toThrow("line 1");
  expect(() => parseRecording(text([book("2026-11-04")]))).toThrow(
    "event time",
  );
  expect(() =>
    parseRecording(text([{ ...book(1000), asks: [[-10, 1]] }])),
  ).toThrow("Invalid depth");
  expect(() =>
    parseRecording(text([book(1000), trade(1100, Infinity)])),
  ).toThrow("Invalid trade");
});

test("unsorted compact streams replay deterministically, demo is explicitly generated", () => {
  const a = parseRecording(
    text([book(3000, 102), trade(1500, 100.5), book(1000)]),
  );
  const b = parseRecording(
    text([book(1000), trade(1500, 100.5), book(3000, 102)]),
  );
  expect(replayFrame(a, 2000)).toEqual(replayFrame(b, 2000));
  const demo = demoRecording();
  expect(demo.end - demo.start).toBe(600 * 60000);
  expect(demo.observations.length).toBe(601);
  expect(demoRecording().observations).toEqual(demo.observations);
});

test("crossed, duplicate and zero-size depth cannot masquerade as a valid import", () => {
  for (const bids of [
    [[102, 1]],
    [
      [100, 1],
      [100, 2],
    ],
    [[100, 0]],
  ]) {
    expect(() => parseRecording(text([{ ...book(1000), bids }]))).toThrow();
  }
  expect(() => parseRecording(text([book(1e30)]))).toThrow("event time");
});

test("replay carries only past imbalance and excludes history preceding a recorded gap", () => {
  const r = parseRecording(
    text([
      book(1000),
      trade(2500, 101),
      { type: "gap", timestamp: 3000 },
      book(4500, 103),
      trade(5500, 104),
    ]),
  );
  expect(replayFrame(r, 2600).history.at(-1).imbalance).toBe(-0.2);
  const resumed = replayFrame(r, 6000);
  expect(resumed.history.map((row) => row.timestamp)).toEqual([4500]);
  expect(resumed.status.lastGapAt).toBe(3000);
});

test("explicit recorded MID observations preserve research inputs without trade-print contamination", () => {
  const observations = [
    { type: "observation", timestamp: 1500, price: 100.5, imbalance: 0.2 },
    { type: "observation", timestamp: 11500, price: 101.5, imbalance: -0.4 },
  ];
  const r = parseRecording(
    text([
      book(1000),
      observations[0],
      trade(2000, 999),
      book(11000, 101),
      observations[1],
      trade(12000, 500),
    ]),
  );
  expect(r.observations).toEqual(
    observations.map(({ timestamp, price, imbalance }) => ({
      timestamp,
      price,
      imbalance,
    })),
  );
  expect(replayFrame(r, 10000).history.map((p) => p.price)).toEqual([100.5]);
});

test("raw metadata and acquisition ordering survive chart indexing; compact provenance stays explicit", () => {
  const events = [book(2000), { ...trade(1000, 101), receiveTimestamp: 2500 }];
  const raw = parseRecording(
    text([
      { type: "session", source: "Kraken public BTC/USD", schema: 1 },
      ...events,
    ]),
  );
  expect(raw.metadata.source).toBe("Kraken public BTC/USD");
  expect(raw.events[0].type).toBe("book");
  expect(raw.events[1].receiveTimestamp).toBe(2500);
  const compact = parseRecording(
    text([
      { type: "session", replaySampling: { tradeSampleMs: 10000 } },
      book(1000),
    ]),
  );
  expect(compact.metadata.replaySampling.tradeSampleMs).toBe(10000);
  expect(() =>
    parseRecording(text([{ ...book(1000), receiveTimestamp: "yesterday" }])),
  ).toThrow("receive time");
});

test("stream acquisition rejects oversized content before reading body", async () => {
  const { readRecordingResponse } = await import("../dist/replay.js");
  const response = new Response("not read", {
    headers: { "content-length": String(65 * 1024 * 1024) },
  });
  await expect(readRecordingResponse(response)).rejects.toThrow("64 MB");
  expect(await readRecordingResponse(new Response("a\nβ"))).toBe("a\nβ");
});
