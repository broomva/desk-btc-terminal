import { expect, test } from "bun:test";
import { PAPER_DEFAULTS, runPaperExperiment } from "../dist/paper-engine.js";

const book = (timestamp, mid = 100, extra = {}) => ({
  type: "book",
  timestamp,
  valid: true,
  bids: [[mid - 0.01, 1]],
  asks: [[mid + 0.01, 1]],
  ...extra,
});
const trade = (
  timestamp,
  side = "sell",
  price = 99,
  qty = 0.0004,
  extra = {},
) => ({
  type: "trade",
  timestamp,
  side,
  price,
  qty,
  ...extra,
});
const recording = (events, metadata = {}) => ({ events, metadata });
const baseline = (events, config) =>
  runPaperExperiment(recording(events), { maxClockSkewMs: 0, ...config })
    .policies[0];
const fast = { quoteIntervalMs: 1000, quoteLatencyMs: 250 };

test("paper defaults are explicit assumptions and compact replay is refused", () => {
  expect(PAPER_DEFAULTS.makerFeeBps).toBe(10);
  expect(() =>
    runPaperExperiment(recording([book(0)], { replaySampling: {} })),
  ).toThrow("raw");
  for (const config of [
    { makerFeeBps: -1 },
    { orderQty: NaN },
    { quoteLatencyMs: 60000 },
    { secret: 1 },
  ])
    expect(() => runPaperExperiment(recording([book(0)]), config)).toThrow();
  expect(() => runPaperExperiment(recording([]))).toThrow();
  expect(() =>
    runPaperExperiment(
      recording([book(6001, 100, { receiveTimestamp: 4000 })]),
    ),
  ).toThrow("later than acquisition");
  expect(() => runPaperExperiment(recording([book(1e30)]))).toThrow(
    "acquisition time",
  );
  expect(() => runPaperExperiment(recording([trade(1)]))).toThrow("No fresh");
});

test("strict trade-through honors aggressor side, same-time and latency boundaries", () => {
  const result = baseline([
    book(1000),
    trade(1000),
    trade(1249),
    trade(1250, "buy", 99), // Buy aggressor never hits the bid.
    trade(1251, "sell", 99.85), // Touch is not strict trade-through.
    trade(1252, "sell", 99.84),
    trade(1253, "sell", 99.8, 10),
    trade(1254, "sell", 99.8, 10), // Exhausted bid is not filled again.
  ]);
  expect(result.fills).toHaveLength(2);
  expect(result.fills.map((f) => f.qty)).toEqual([
    0.0004, 0.0006000000000000001,
  ]);
  expect(result.fills[0].timestamp).toBe(1252);
  expect(result.fills.every((f) => f.side === "buy")).toBe(true);
  expect(result.metrics.filledQty).toBeCloseTo(0.001, 12);
});

test("partial buy and sell fills conserve cash, inventory and assumed fees", () => {
  const result = baseline([
    book(1000),
    trade(1300, "sell", 99, 0.0004),
    trade(1400, "buy", 101, 0.0003),
    book(2000, 102),
  ]);
  const buyNotional = 99.85 * 0.0004;
  const sellNotional = 100.15 * 0.0003;
  const fees = (buyNotional + sellNotional) * 0.001;
  const inventory = 0.01 + 0.0004 - 0.0003;
  const cash = 10000 - buyNotional + sellNotional - fees;
  expect(result.metrics.finalCash).toBeCloseTo(cash, 10);
  expect(result.metrics.finalInventory).toBeCloseTo(inventory, 12);
  expect(result.metrics.fees).toBeCloseTo(fees, 12);
  expect(result.metrics.finalEquity).toBeCloseTo(cash + inventory * 102, 10);
  expect(result.metrics.pnl).toBeCloseTo(cash + inventory * 102 - 10001, 10);
  expect(result.metrics.passiveHoldPnl).toBeCloseTo(0.02, 12);
  expect(result.metrics.excessOverHold).toBeCloseTo(
    result.metrics.pnl - 0.02,
    10,
  );
});

test("inventory and cash constraints prohibit synthetic shorts or excessive buys", () => {
  const events = [];
  for (let t = 0; t < 25000; t += 1000) {
    events.push(book(t), trade(t + 300, "sell", 99, 1));
  }
  const buys = baseline(events, fast);
  expect(buys.metrics.finalInventory).toBeCloseTo(0.02, 12);
  expect(buys.metrics.finalCash).toBeGreaterThanOrEqual(0);
  const sells = baseline(
    events.map((e) =>
      e.type === "trade" ? { ...e, side: "buy", price: 101 } : e,
    ),
    fast,
  );
  expect(sells.metrics.finalInventory).toBeCloseTo(0, 12);
  const broke = baseline([book(0), trade(300)], { initialCash: 0 });
  expect(broke.fills).toHaveLength(0);
});

test("gaps and stale books cancel outstanding quotes without fabricating liquidation", () => {
  const result = baseline(
    [
      book(0),
      { type: "gap", timestamp: 300 },
      trade(400),
      book(1000),
      trade(1300),
      trade(7000),
      book(8000, 110),
    ],
    fast,
  );
  expect(result.fills).toHaveLength(1);
  expect(result.fills[0].timestamp).toBe(1300);
  expect(result.metrics.finalInventory).toBeCloseTo(0.0104, 12);
  expect(result.fills[0].markouts["10s"]).toBeNull();
  const stale = baseline(
    [book(0, 100, { receiveTimestamp: 6000 }), trade(6300), book(7000)],
    fast,
  );
  expect(stale.fills).toHaveLength(0);
});

test("receive time controls ordering and delayed trades cannot precede their quote", () => {
  const result = baseline([
    trade(100, "sell", 99, 0.0004, { receiveTimestamp: 1500 }),
    trade(1400, "sell", 99, 0.0004, { receiveTimestamp: 1600 }),
    book(0, 100, { receiveTimestamp: 1000 }),
    trade(100, "sell", 99, 0.0004, { receiveTimestamp: 1000 }),
  ]);
  expect(result.fills).toHaveLength(1);
  expect(result.fills[0].timestamp).toBe(1600);
  expect(result.fills[0].exchangeTimestamp).toBe(1400);
});

test("markouts settle at future horizons only and unresolved horizons remain null", () => {
  const result = baseline(
    [
      book(0),
      trade(300),
      book(1000, 100),
      book(1300, 101),
      book(10300, 102),
      book(60300, 103),
    ],
    { maxBookAgeMs: 60000 },
  );
  const fill = result.fills[0];
  expect(fill.markouts["1s"]).toBeCloseTo(((101 - 99.85) / 99.85) * 10000, 8);
  expect(fill.markouts["10s"]).toBeCloseTo(((102 - 99.85) / 99.85) * 10000, 8);
  expect(fill.markouts["60s"]).toBeCloseTo(((103 - 99.85) / 99.85) * 10000, 8);
  expect(result.metrics.realizedSpreadBps).toBeCloseTo(
    2 * fill.markouts["60s"],
    8,
  );
  const short = baseline([book(0), trade(300), book(1300, 101)]);
  expect(short.metrics.markouts["60s"]).toEqual({
    meanBps: null,
    count: 0,
    unresolved: 1,
  });
  expect(short.metrics.realizedSpreadBps).toBeNull();
});

test("markouts do not settle across explicit or inferred stale-data gaps", () => {
  const explicit = baseline([
    book(0),
    trade(300),
    { type: "gap", timestamp: 500 },
    book(1300, 105),
  ]);
  expect(explicit.fills[0].markouts["1s"]).toBeNull();
  const inferred = baseline([book(0), trade(300), book(10300, 105)]);
  expect(inferred.fills[0].markouts["10s"]).toBeNull();
});

test("filter uses only past books, needs warmup, and pauses on fixed drift threshold", () => {
  const prefix = [
    book(0),
    book(10000),
    book(20000),
    book(30000),
    book(40000, 101),
  ];
  const config = { quoteIntervalMs: 1000, maxBookAgeMs: 60000 };
  const a = runPaperExperiment(recording(prefix), config);
  const b = runPaperExperiment(
    recording([...prefix, book(50000, 900)]),
    config,
  );
  const decisions = a.policies[1].decisions;
  expect(decisions[0].reason).toBe("FILTER WARMUP");
  expect(decisions[3].quote).toBe(true);
  expect(decisions[4].reason).toBe("FILTER PAUSED");
  expect(b.policies[1].decisions.slice(0, decisions.length)).toEqual(decisions);
  expect(a.policies[0].decisions.every((d) => d.quote)).toBe(true);
});

test("inferred stale gaps reset filter warmup rather than inventing continuous history", () => {
  const result = runPaperExperiment(recording([book(0), book(30000)]), fast);
  expect(result.policies[1].decisions.at(-1).reason).toBe("FILTER WARMUP");
});

test("equity and drawdown include inventory repricing and fees, without trading", () => {
  const result = baseline([book(0, 100), book(1000, 200), book(2000, 50)]);
  expect(result.metrics.pnl).toBeCloseTo(-0.5, 10);
  expect(result.metrics.maxDrawdown).toBeCloseTo(1.5, 10);
  expect(result.metrics.passiveHoldPnl).toBeCloseTo(-0.5, 10);
  expect(result.metrics.excessOverHold).toBeCloseTo(0, 10);
  expect(result.metrics.maxExposureUsd).toBe(2);
});

test("experiment is deterministic and reports assumptions rather than claiming an edge", () => {
  const input = recording([book(0), trade(300), book(1300)], {
    source: "Kraken public BTC/USD",
  });
  const a = runPaperExperiment(input);
  expect(runPaperExperiment(input)).toEqual(a);
  expect(a.source).toBe("Kraken public BTC/USD");
  expect(a.comparison.pnlDifference).toBeCloseTo(
    a.policies[1].metrics.pnl - a.policies[0].metrics.pnl,
    12,
  );
  expect(a.comparison.conclusion).toContain("no statistical edge");
  expect(a.limitations.join(" ")).toContain("queue position");
});

test("quote arrival is independent of the first trade and retains adverse fills", () => {
  const books = Array.from({ length: 20 }, (_, i) => book(i * 1000));
  const suffix = [book(20000, 98), trade(20100, "sell", 97.9)];
  const a = baseline([...books, ...suffix]);
  const b = baseline([...books, trade(500, "sell", 99.9), ...suffix]);
  expect(a.fills).toHaveLength(1);
  expect(a.fills).toEqual(b.fills);
  expect(a.fills[0].effectiveHalfSpreadBps).toBeLessThan(0);
});

test("raw full-cursor input retains delayed final events and silent capture tail", async () => {
  const { parseRecording } = await import("../dist/replay.js");
  const data = [
    book(1000, 100, { receiveTimestamp: 1000 }),
    trade(1500, "sell", 99, 0.001, { receiveTimestamp: 2000 }),
    { type: "end", timestamp: 2100 },
  ];
  const parsed = parseRecording(data.map(JSON.stringify).join("\n"));
  expect(parsed.end).toBe(2100);
  const panelInput = {
    ...parsed,
    events: parsed.events.filter(
      (e) => (e.receiveTimestamp ?? e.timestamp) <= parsed.end,
    ),
  };
  const full = runPaperExperiment(parsed, { maxClockSkewMs: 0 });
  const panel = runPaperExperiment(panelInput, { maxClockSkewMs: 0 });
  expect(panel).toEqual(full);
  expect(panel.policies[0].fills).toHaveLength(1);
  expect(panel.end).toBe(2100);
  expect(panel.valuation.ageMs).toBe(1100);
});

test("receipt inputs reject unordered book levels and report exchange-time fallback", () => {
  expect(() =>
    runPaperExperiment(
      recording([
        book(1000, 100, {
          bids: [
            [90, 1],
            [99.99, 1],
          ],
        }),
      ]),
    ),
  ).toThrow("invalid book");
  const result = runPaperExperiment(recording([book(1000)]));
  expect(result.timing.missingReceiveTimes).toBe(1);
});

test("bounded clock differences admit valid packets without crediting ambiguous fills", () => {
  const r = runPaperExperiment(
    recording([
      book(1040, 100, { receiveTimestamp: 1000 }),
      trade(1300, "sell", 99, 0.0004, { receiveTimestamp: 1260 }),
      trade(2400, "sell", 99, 0.0004, { receiveTimestamp: 2360 }),
    ]),
  );
  expect(r.policies[0].fills).toHaveLength(1);
  expect(r.policies[0].fills[0].timestamp).toBe(2360);
  expect(r.timing.observedMaxExchangeLeadMs).toBe(40);
  expect(r.config.maxClockSkewMs).toBe(1000);
  expect(r.version).toBe(2);
  expect(() =>
    runPaperExperiment(
      recording([book(2001, 100, { receiveTimestamp: 1000 })]),
    ),
  ).toThrow("clock bound");
});

test("clock uncertainty tightens book freshness and preserves acquisition-order decisions", () => {
  const r = runPaperExperiment(
    recording([
      book(1040, 100, { receiveTimestamp: 1000 }),
      trade(5041, "sell", 99, 0.001, { receiveTimestamp: 5041 }),
    ]),
  );
  expect(r.policies[0].fills).toHaveLength(0);
  expect(r.valuation.fresh).toBe(false);
  expect(() =>
    runPaperExperiment(recording([book(1000)]), { maxClockSkewMs: 5000 }),
  ).toThrow("uncertainty");
});

test("clock-bound fill and quote-expiry edges are inclusive and exclusive respectively", () => {
  const events = [book(1000), trade(2250, "sell", 99, 0.0004)];
  expect(runPaperExperiment(recording(events)).policies[0].fills).toHaveLength(
    1,
  );
  expect(
    runPaperExperiment(recording([book(1000), trade(2249, "sell", 99)]))
      .policies[0].fills,
  ).toHaveLength(0);
  expect(baseline([book(1000), trade(2000)], fast).fills).toHaveLength(0);
});

test("end valuation uses worst-case age including clock uncertainty", () => {
  const fresh = runPaperExperiment(recording([book(1000)], { endedAt: 5000 }));
  const stale = runPaperExperiment(recording([book(1000)], { endedAt: 5001 }));
  expect(fresh.valuation.fresh).toBe(true);
  expect(fresh.valuation.worstCaseAgeMs).toBe(5000);
  expect(stale.valuation.fresh).toBe(false);
  expect(stale.valuation.worstCaseAgeMs).toBe(5001);
});

test("inferred gap starts at the conservative expiry before the next fresh book", () => {
  const r = runPaperExperiment(
    recording([book(1000), trade(2300), book(5500, 99)]),
  );
  expect(r.policies[0].fills).toHaveLength(1);
  expect(r.policies[0].fills[0].markouts["1s"]).toBeNull();
});
