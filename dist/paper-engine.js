// A deterministic paper experiment, never an order router. Both policies see the
// same acquisition-time stream; future books are used only to settle markouts.
export const PAPER_DEFAULTS = Object.freeze({
  makerFeeBps: 10,
  halfSpreadBps: 15,
  orderQty: 0.001,
  maxInventory: 0.01,
  initialBase: 0.01,
  initialCash: 10000,
  quoteIntervalMs: 60000,
  quoteLatencyMs: 250,
  maxBookAgeMs: 5000,
  maxClockSkewMs: 1000,
  filterWindowMs: 60000,
  filterWarmupMs: 30000,
  maxRangeBps: 30,
  maxDriftBps: 15,
});

const bounds = {
  makerFeeBps: [0, 1000],
  halfSpreadBps: [0.01, 1000],
  orderQty: [0.00000001, 100],
  maxInventory: [0.00000001, 1000],
  initialBase: [0, 1000],
  initialCash: [0, 1e9],
  quoteIntervalMs: [1000, 3600000],
  quoteLatencyMs: [0, 60000],
  maxBookAgeMs: [1, 60000],
  maxClockSkewMs: [0, 60000],
  filterWindowMs: [1000, 3600000],
  filterWarmupMs: [1000, 3600000],
  maxRangeBps: [0, 10000],
  maxDriftBps: [0, 10000],
};
const markHorizons = { "1s": 1000, "10s": 10000, "60s": 60000 };
const eventTime = (event) => event.receiveTimestamp ?? event.timestamp;
const orderedLevels = (rows, descending) =>
  Array.isArray(rows) &&
  rows.length > 0 &&
  rows.every(
    (row, i) =>
      Array.isArray(row) &&
      Number.isFinite(row[0]) &&
      row[0] > 0 &&
      Number.isFinite(row[1]) &&
      row[1] > 0 &&
      (!i || (descending ? rows[i - 1][0] > row[0] : rows[i - 1][0] < row[0])),
  );
const bookAge = (book, now, config) =>
  Math.max(
    0,
    now - eventTime(book),
    now - book.timestamp + config.maxClockSkewMs,
  );
const bookExpiry = (book, config) =>
  Math.min(
    eventTime(book) + config.maxBookAgeMs,
    book.timestamp + config.maxBookAgeMs - config.maxClockSkewMs,
  );
const midpoint = (book) => (book.bids[0][0] + book.asks[0][0]) / 2;

function configuration(overrides) {
  for (const key of Object.keys(overrides))
    if (!(key in bounds)) throw new Error(`Unknown paper parameter: ${key}`);
  const config = { ...PAPER_DEFAULTS, ...overrides };
  for (const [key, [min, max]] of Object.entries(bounds))
    if (!Number.isFinite(config[key]) || config[key] < min || config[key] > max)
      throw new Error(`Paper ${key} must be between ${min} and ${max}.`);
  if (config.filterWarmupMs > config.filterWindowMs)
    throw new Error("Filter warmup must fit within its trailing window.");
  if (config.quoteLatencyMs >= config.quoteIntervalMs)
    throw new Error("Quote latency must be shorter than its refresh interval.");
  if (config.maxClockSkewMs >= config.maxBookAgeMs)
    throw new Error(
      "Clock uncertainty must be smaller than the book-age tolerance.",
    );
  return config;
}

function stream(recording, config) {
  if (recording.metadata?.replaySampling)
    throw new Error(
      "Execution requires a raw recording: compact replay drops trades.",
    );
  const events = recording.events ?? [
    ...(recording.books ?? []),
    ...(recording.trades ?? []),
    ...(recording.gaps ?? []),
  ];
  if (!events.length || events.length > 250000)
    throw new Error("Paper execution needs 1–250,000 recorded events.");
  const relevant = events.filter((e) =>
    ["book", "trade", "gap"].includes(e.type),
  );
  for (const event of relevant) {
    if (
      !Number.isFinite(eventTime(event)) ||
      eventTime(event) < 0 ||
      eventTime(event) > 8640000000000000
    )
      throw new Error("Paper event has invalid acquisition time.");
    if (
      !Number.isFinite(event.timestamp) ||
      event.timestamp < 0 ||
      event.timestamp > eventTime(event) + config.maxClockSkewMs
    )
      throw new Error(
        "Paper event exchange time is invalid or later than acquisition time beyond the configured clock bound.",
      );
    if (event.type === "book" && event.valid !== false) {
      if (
        !Number.isFinite(event.timestamp) ||
        !orderedLevels(event.bids, true) ||
        !orderedLevels(event.asks, false) ||
        !Number.isFinite(midpoint(event)) ||
        event.bids[0][0] <= 0 ||
        event.bids[0][0] >= event.asks[0][0]
      )
        throw new Error("Paper event has invalid book.");
    }
    if (
      event.type === "trade" &&
      (!Number.isFinite(event.price) ||
        event.price <= 0 ||
        !Number.isFinite(event.qty) ||
        event.qty <= 0 ||
        !["buy", "sell"].includes(event.side))
    )
      throw new Error("Paper event has invalid trade.");
  }
  return relevant.toSorted((a, b) => eventTime(a) - eventTime(b));
}

function makePolicy(id, label, config) {
  return {
    id,
    label,
    quotes: [],
    fills: [],
    decisions: [],
    equity: [],
    cash: config.initialCash,
    inventory: config.initialBase,
    openQuote: null,
    lastDecision: -Infinity,
    fees: 0,
    peak: null,
    maxDrawdown: 0,
    maxExposureUsd: 0,
  };
}

function mark(policy, timestamp, mid, initialEquity, initialMid, config) {
  const equity = policy.cash + policy.inventory * mid;
  const pnl = equity - initialEquity;
  const passiveHoldPnl = config.initialBase * (mid - initialMid);
  policy.peak = Math.max(policy.peak ?? equity, equity);
  policy.maxDrawdown = Math.max(policy.maxDrawdown, policy.peak - equity);
  policy.maxExposureUsd = Math.max(
    policy.maxExposureUsd,
    policy.inventory * mid,
  );
  const row = {
    timestamp,
    equity,
    pnl,
    passiveHoldPnl,
    excessOverHold: pnl - passiveHoldPnl,
    inventory: policy.inventory,
    cash: policy.cash,
    mid,
  };
  if (policy.equity.at(-1)?.timestamp === timestamp) policy.equity.pop();
  policy.equity.push(row);
}

function filterState(history, now, config) {
  const rows = history.filter(
    (row) => row.timestamp >= now - config.filterWindowMs,
  );
  if (!rows.length || now - rows[0].timestamp < config.filterWarmupMs)
    return {
      quote: false,
      reason: "FILTER WARMUP",
      rangeBps: null,
      driftBps: null,
    };
  let low = Infinity,
    high = -Infinity;
  for (const row of rows) {
    low = Math.min(low, row.mid);
    high = Math.max(high, row.mid);
  }
  const driftBps = (rows.at(-1).mid / rows[0].mid - 1) * 10000;
  const rangeBps = (high / low - 1) * 10000;
  return {
    quote:
      rangeBps <= config.maxRangeBps &&
      Math.abs(driftBps) <= config.maxDriftBps,
    reason:
      rangeBps > config.maxRangeBps || Math.abs(driftBps) > config.maxDriftBps
        ? "FILTER PAUSED"
        : "FILTER QUOTING",
    rangeBps,
    driftBps,
  };
}

function decide(policy, book, now, gate, config) {
  if (now - policy.lastDecision < config.quoteIntervalMs) return;
  policy.lastDecision = now;
  policy.openQuote = null;
  policy.decisions.push({ timestamp: now, ...gate });
  if (!gate.quote) return;
  const mid = midpoint(book);
  const bid = Math.min(
    book.bids[0][0],
    mid * (1 - config.halfSpreadBps / 10000),
  );
  const ask = Math.max(
    book.asks[0][0],
    mid * (1 + config.halfSpreadBps / 10000),
  );
  const lower = Math.max(0, config.initialBase - config.maxInventory);
  const upper = config.initialBase + config.maxInventory;
  const buyQty = Math.max(
    0,
    Math.min(
      config.orderQty,
      upper - policy.inventory,
      policy.cash / (bid * (1 + config.makerFeeBps / 10000)),
    ),
  );
  const sellQty = Math.max(
    0,
    Math.min(config.orderQty, policy.inventory - lower),
  );
  const quote = {
    timestamp: now,
    activeAt: now + config.quoteLatencyMs,
    expiresAt: now + config.quoteIntervalMs,
    bid,
    ask,
    buyQty,
    sellQty,
    mid,
  };
  policy.quotes.push(quote);
  policy.openQuote = { ...quote, activated: false };
}

function fill(policy, trade, now, currentBook, config) {
  const quote = policy.openQuote;
  if (
    !quote ||
    now <= quote.timestamp ||
    now < quote.activeAt ||
    trade.timestamp - config.maxClockSkewMs < quote.activeAt ||
    now >= quote.expiresAt ||
    !quote.activated
  )
    return;
  const buying = trade.side === "sell";
  const price = buying ? quote.bid : quote.ask;
  const tolerance = price * 1e-12;
  if (
    buying ? trade.price >= price - tolerance : trade.price <= price + tolerance
  )
    return;
  const available = buying ? quote.buyQty : quote.sellQty;
  const qty = Math.min(trade.qty, available);
  if (qty <= 1e-12) return;
  const fee = (qty * price * config.makerFeeBps) / 10000;
  policy.cash += buying ? -(qty * price + fee) : qty * price - fee;
  policy.inventory += buying ? qty : -qty;
  policy.fees += fee;
  if (buying) quote.buyQty -= qty;
  else quote.sellQty -= qty;
  const mid = midpoint(currentBook);
  policy.fills.push({
    timestamp: now,
    exchangeTimestamp: trade.timestamp,
    quoteTimestamp: quote.timestamp,
    side: buying ? "buy" : "sell",
    price,
    qty,
    fee,
    mid,
    effectiveHalfSpreadBps:
      ((buying ? mid - price : price - mid) / mid) * 10000,
    markouts: { "1s": null, "10s": null, "60s": null },
  });
}

function settleMarkouts(policy, books, gaps, config) {
  for (const execution of policy.fills) {
    for (const [name, horizon] of Object.entries(markHorizons)) {
      const target = execution.timestamp + horizon;
      let lo = 0,
        hi = books.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (books[mid].timestamp < target) lo = mid + 1;
        else hi = mid;
      }
      const book = books[lo];
      if (!book || book.timestamp - target > config.maxBookAgeMs) continue;
      // Never settle across a gap; missing observations are unresolved, not zero.
      let gl = 0,
        gh = gaps.length;
      while (gl < gh) {
        const mid = (gl + gh) >>> 1;
        if (gaps[mid] <= execution.timestamp) gl = mid + 1;
        else gh = mid;
      }
      if (gaps[gl] !== undefined && gaps[gl] <= book.timestamp) continue;
      execution.markouts[name] =
        ((execution.side === "buy"
          ? book.mid - execution.price
          : execution.price - book.mid) /
          execution.price) *
        10000;
    }
  }
}

function summarize(policy, config) {
  const last = policy.equity.at(-1);
  const weightedMean = (rows, value) => {
    let sum = 0,
      qty = 0;
    for (const row of rows)
      if (value(row) !== null) {
        sum += value(row) * row.qty;
        qty += row.qty;
      }
    return qty ? sum / qty : null;
  };
  const markouts = {};
  for (const name of Object.keys(markHorizons)) {
    const count = policy.fills.filter(
      (row) => row.markouts[name] !== null,
    ).length;
    markouts[name] = {
      meanBps: weightedMean(policy.fills, (row) => row.markouts[name]),
      count,
      unresolved: policy.fills.length - count,
    };
  }
  return {
    id: policy.id,
    label: policy.label,
    quotes: policy.quotes,
    fills: policy.fills,
    decisions: policy.decisions,
    equity: policy.equity,
    metrics: {
      pnl: last?.pnl ?? 0,
      finalEquity: last?.equity ?? null,
      passiveHoldPnl: last?.passiveHoldPnl ?? 0,
      excessOverHold: last?.excessOverHold ?? 0,
      fees: policy.fees,
      finalInventory: policy.inventory,
      initialInventory: config.initialBase,
      finalCash: policy.cash,
      maxDrawdown: policy.maxDrawdown,
      maxExposureUsd: policy.maxExposureUsd,
      fillCount: policy.fills.length,
      quoteCount: policy.quotes.length,
      decisionCount: policy.decisions.length,
      quotedDecisions: policy.decisions.filter((row) => row.quote).length,
      filledQty: policy.fills.reduce((sum, row) => sum + row.qty, 0),
      effectiveHalfSpreadBps: weightedMean(
        policy.fills,
        (row) => row.effectiveHalfSpreadBps,
      ),
      realizedSpreadBps:
        markouts["60s"].meanBps === null ? null : 2 * markouts["60s"].meanBps,
      markouts,
    },
  };
}

export function runPaperExperiment(recording, overrides = {}) {
  const config = configuration(overrides);
  if (
    recording.metadata?.endedAt !== undefined &&
    (!Number.isFinite(recording.metadata.endedAt) ||
      recording.metadata.endedAt < 0)
  )
    throw new Error("Invalid recording end time.");
  const events = stream(recording, config);
  const policies = [
    makePolicy("baseline", "Always quote", config),
    makePolicy("filter", "Past volatility / trend filter", config),
  ];
  let currentBook = null,
    initialMid = null,
    initialEquity = null;
  let history = [],
    historyStart = 0;
  const validBooks = [],
    gaps = [];
  for (const event of events) {
    const now = eventTime(event);
    if (
      event.type === "gap" ||
      (event.type === "book" && event.valid === false)
    ) {
      gaps.push(now);
      currentBook = null;
      history = [];
      historyStart = 0;
      for (const policy of policies) policy.openQuote = null;
      continue;
    }
    if (
      currentBook &&
      bookAge(currentBook, now, config) > config.maxBookAgeMs
    ) {
      gaps.push(bookExpiry(currentBook, config));
      currentBook = null;
      history = [];
      historyStart = 0;
      for (const policy of policies) policy.openQuote = null;
    }
    // Activate against the last known book BEFORE consuming this event.
    // A later adverse book must not retrospectively reject an arrived quote.
    for (const policy of policies) {
      const quote = policy.openQuote;
      if (currentBook && quote && !quote.activated && now >= quote.activeAt) {
        if (quote.bid >= currentBook.asks[0][0]) quote.buyQty = 0;
        if (quote.ask <= currentBook.bids[0][0]) quote.sellQty = 0;
        quote.activated = true;
      }
    }
    if (event.type === "book") {
      if (bookAge(event, now, config) > config.maxBookAgeMs) continue;
      currentBook = event;
      const mid = midpoint(event);
      if (initialMid === null) {
        initialMid = mid;
        initialEquity = config.initialCash + config.initialBase * mid;
      }
      validBooks.push({
        timestamp: now,
        mid,
        exchangeTimestamp: event.timestamp,
      });
      history.push({ timestamp: now, mid });
      while (
        historyStart < history.length &&
        history[historyStart].timestamp < now - config.filterWindowMs
      )
        historyStart++;
      if (historyStart > 10000 && historyStart > history.length / 2) {
        history = history.slice(historyStart);
        historyStart = 0;
      }
      for (const policy of policies) {
        mark(policy, now, mid, initialEquity, initialMid, config);
        if (now - policy.lastDecision < config.quoteIntervalMs) continue;
        decide(
          policy,
          event,
          now,
          policy.id === "baseline"
            ? {
                quote: true,
                reason: "BASELINE QUOTING",
                rangeBps: null,
                driftBps: null,
              }
            : filterState(history.slice(historyStart), now, config),
          config,
        );
      }
    } else if (
      event.type === "trade" &&
      currentBook &&
      bookAge(currentBook, now, config) <= config.maxBookAgeMs
    ) {
      for (const policy of policies) {
        fill(policy, event, now, currentBook, config);
        mark(
          policy,
          now,
          midpoint(currentBook),
          initialEquity,
          initialMid,
          config,
        );
      }
    }
    for (const policy of policies)
      if (
        policy.fills.length + policy.quotes.length + policy.decisions.length >
        50000
      )
        throw new Error(
          "Paper audit exceeds 50,000 rows per policy; use a shorter recording.",
        );
  }
  if (!validBooks.length)
    throw new Error("No fresh valid book available for paper execution.");
  for (const policy of policies)
    settleMarkouts(policy, validBooks, gaps, config);
  const output = policies.map((policy) => summarize(policy, config));
  const end = Math.max(
    eventTime(events.at(-1)),
    recording.metadata?.endedAt ?? 0,
  );
  if (!Number.isFinite(end) || end > 8640000000000000)
    throw new Error("Invalid recording end time.");
  return {
    version: 2,
    config,
    source: recording.metadata?.source ?? "Unverified imported recording",
    start: eventTime(events[0]),
    end,
    valuation: {
      timestamp: validBooks.at(-1).timestamp,
      mid: validBooks.at(-1).mid,
      ageMs: end - validBooks.at(-1).timestamp,
      worstCaseAgeMs: Math.max(
        0,
        end - validBooks.at(-1).timestamp,
        end - validBooks.at(-1).exchangeTimestamp + config.maxClockSkewMs,
      ),
      fresh:
        currentBook !== null &&
        bookAge(currentBook, end, config) <= config.maxBookAgeMs,
    },
    policies: output,
    comparison: {
      pnlDifference: output[1].metrics.pnl - output[0].metrics.pnl,
      feeDifference: output[1].metrics.fees - output[0].metrics.fees,
      conclusion:
        "Descriptive fixed-policy comparison; no statistical edge established.",
    },
    timing: {
      maxClockSkewMs: config.maxClockSkewMs,
      observedMaxExchangeLeadMs: events.reduce(
        (max, e) => Math.max(max, e.timestamp - eventTime(e)),
        0,
      ),
      fillTimingRule:
        "A trade must be after quote arrival even if the exchange clock leads local time by maxClockSkewMs.",
      missingReceiveTimes: events.filter(
        (e) => e.receiveTimestamp === undefined,
      ).length,
    },
    limitations: [
      "Receive times are used where present; missing receive times fall back to exchange time and cannot establish acquisition latency.",
      "Quote activation uses the last known sampled book before the first event at or after arrival; intra-sample book changes are unknown.",
      "Simulated execution only; raw sampled L2 and trades cannot establish exchange queue position.",
      "Strict trade-through fills are capped by each observed trade's volume per policy; queue ahead is assumed zero.",
      "Maker fees, quote latency and spreads are explicit assumptions, not a verified account fee tier.",
      "Exchange/local clock offset is assumed within the configured bound, not measured synchronization; ambiguous near-arrival trades cannot fill. Book freshness uses worst-case exchange age and receive age.",
      "Long-only inventory is bounded around starting base; unfilled orders cancel immediately at policy refresh, gaps or staleness.",
      "Inventory is marked at the last valid mid, without a simulated final liquidation or its costs.",
      "Markouts use the first valid book at or after each horizon within the freshness tolerance; missing or gapped horizons remain unresolved.",
      "Policies and thresholds are fixed before replay; this recording is not proof of out-of-sample profitability.",
    ],
  };
}

export { configuration as paperConfiguration };
