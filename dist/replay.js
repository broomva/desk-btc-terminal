// Recording data stays local. These functions contain no DOM or network effects.
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const positive = (n) => finite(n) && n > 0;

function levels(rows) {
  return (
    Array.isArray(rows) &&
    rows.length <= 1000 &&
    rows.every(
      (row) => Array.isArray(row) && positive(row[0]) && positive(row[1]),
    )
  );
}

export function parseRecording(text) {
  if (text.length > 64 * 1024 * 1024)
    throw new Error("Recording exceeds the 64 MB local replay limit.");
  const events = [];
  let metadata = {};
  let sessionSeen = false;
  const lines = text.split(/\r?\n/);
  if (lines.length > 250000)
    throw new Error("Recording has too many events. Import a shorter session.");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      throw new Error(`Invalid JSON on line ${i + 1}.`);
    }
    if (event?.type === "session") {
      if (sessionSeen)
        throw new Error("Import one recording session at a time.");
      sessionSeen = true;
      metadata = { ...event };
      continue;
    }
    if (event?.type === "end") {
      if (
        !finite(event.timestamp) ||
        event.timestamp < 0 ||
        event.timestamp > 8640000000000000
      )
        throw new Error(`Invalid session end on line ${i + 1}.`);
      metadata.endedAt = event.timestamp;
      metadata.endReason = event.reason ?? "End marker without reason";
      metadata.captureCounts = event.counts ?? null;
      continue;
    }
    if (event?.type === "status") continue;
    if (
      !finite(event?.timestamp) ||
      event.timestamp < 0 ||
      event.timestamp > 8640000000000000
    )
      throw new Error(`Missing event time on line ${i + 1}.`);
    if (
      event.receiveTimestamp !== undefined &&
      (!finite(event.receiveTimestamp) ||
        event.receiveTimestamp < 0 ||
        event.receiveTimestamp > 8640000000000000)
    )
      throw new Error(`Invalid receive time on line ${i + 1}.`);
    if (event.type === "book") {
      if (!levels(event.bids) || !levels(event.asks))
        throw new Error(`Invalid depth on line ${i + 1}.`);
      if (event.valid === false) {
        events.push({
          type: "gap",
          timestamp: event.timestamp,
          reason: "Invalid recorded book",
          ...(event.receiveTimestamp === undefined
            ? {}
            : { receiveTimestamp: event.receiveTimestamp }),
        });
        continue;
      }
      const bids = event.bids.toSorted((a, b) => b[0] - a[0]);
      const asks = event.asks.toSorted((a, b) => a[0] - b[0]);
      if (
        !bids.length ||
        !asks.length ||
        bids[0][0] >= asks[0][0] ||
        new Set(bids.map((r) => r[0])).size !== bids.length ||
        new Set(asks.map((r) => r[0])).size !== asks.length
      )
        throw new Error(`Invalid or crossed depth on line ${i + 1}.`);
      events.push({
        type: "book",
        timestamp: event.timestamp,
        ...(event.receiveTimestamp === undefined
          ? {}
          : { receiveTimestamp: event.receiveTimestamp }),
        bids,
        asks,
        valid: true,
      });
    } else if (event.type === "trade") {
      if (
        !positive(event.price) ||
        !positive(event.qty) ||
        !["buy", "sell"].includes(event.side)
      )
        throw new Error(`Invalid trade on line ${i + 1}.`);
      events.push(event);
    } else if (event.type === "observation") {
      if (
        !positive(event.price) ||
        !finite(event.imbalance) ||
        Math.abs(event.imbalance) > 1
      )
        throw new Error(`Invalid observation on line ${i + 1}.`);
      events.push({
        type: "observation",
        timestamp: event.timestamp,
        price: event.price,
        imbalance: event.imbalance,
      });
    } else if (event.type === "gap") events.push(event);
    else throw new Error(`Unknown event type on line ${i + 1}.`);
  }
  if (!events.some((e) => e.type === "book"))
    throw new Error("No valid book snapshots found in this recording.");
  return indexRecording(events, metadata);
}

// Limit bytes during acquisition, before allocating an arbitrarily large text.
export async function readRecordingResponse(response) {
  const limit = 64 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error(
      "Recording exceeds 64 MB. Record a shorter raw session for the paper lab.",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Recording exceeds the 64 MB local replay limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function upperBound(rows, timestamp) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].timestamp <= timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function indexRecording(input, metadata = {}) {
  const events = input.toSorted((a, b) => a.timestamp - b.timestamp);
  const books = events.filter((e) => e.type === "book");
  const trades = events.filter((e) => e.type === "trade");
  const gaps = events.filter((e) => e.type === "gap");
  const observations = [];
  let lastSecond = -1;
  const explicitObservations = events.some(
    (event) => event.type === "observation",
  );
  for (const event of events) {
    if (
      explicitObservations
        ? event.type !== "observation"
        : event.type !== "book"
    )
      continue;
    const second = Math.floor(event.timestamp / 1000);
    const price =
      event.type === "observation"
        ? event.price
        : (event.bids[0][0] + event.asks[0][0]) / 2;
    const imbalance =
      event.type === "observation" ? event.imbalance : bookImbalance(event);
    if (second === lastSecond)
      observations[observations.length - 1] = {
        timestamp: event.timestamp,
        price,
        imbalance: imbalance ?? observations.at(-1).imbalance,
      };
    else {
      observations.push({ timestamp: event.timestamp, price, imbalance });
      lastSecond = second;
    }
  }
  return {
    events: input,
    metadata,
    books,
    trades,
    gaps,
    observations,
    start: events.reduce(
      (min, e) => Math.min(min, e.timestamp, e.receiveTimestamp ?? e.timestamp),
      Infinity,
    ),
    end: events.reduce(
      (max, e) => Math.max(max, e.timestamp, e.receiveTimestamp ?? e.timestamp),
      metadata.endedAt ?? 0,
    ),
    count: events.length,
  };
}

export function bookImbalance(book) {
  const sum = (rows) => rows.slice(0, 25).reduce((s, row) => s + row[1], 0);
  const bids = sum(book.bids),
    asks = sum(book.asks);
  return bids + asks ? (bids - asks) / (bids + asks) : 0;
}

export function replayFrame(recording, timestamp) {
  const index = upperBound(recording.books, timestamp) - 1;
  const book = recording.books[index] ?? {
    bids: [],
    asks: [],
    timestamp: null,
  };
  const gap = recording.gaps[upperBound(recording.gaps, timestamp) - 1];
  const valid = index >= 0 && (!gap || gap.timestamp < book.timestamp);
  const end = upperBound(recording.observations, timestamp);
  const tradeEnd = upperBound(recording.trades, timestamp);
  return {
    book: { ...book, valid },
    history: recording.observations.slice(
      gap ? upperBound(recording.observations, gap.timestamp) : 0,
      end,
    ),
    trades: recording.trades.slice(Math.max(0, tradeEnd - 30), tradeEnd),
    status: {
      bookValid: valid,
      connected: false,
      recording: false,
      gaps: upperBound(recording.gaps, timestamp),
      lastGapAt: gap?.timestamp ?? null,
      lastMessageAt: book.timestamp,
    },
  };
}

export function demoRecording() {
  let seed = 7319;
  const rng = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const start = Date.UTC(2026, 10, 3, 10);
  const events = [];
  let price = 77850;
  for (let minute = 0; minute <= 600; minute++) {
    price += (rng() - 0.49) * 32 + Math.sin(minute / 24) * 2;
    const timestamp = start + minute * 60000;
    const make = (side) =>
      Array.from({ length: 100 }, (_, i) => [
        Math.round((price + side * (2 + i * 2.4)) * 10) / 10,
        Number((0.1 + rng() * 1.6 + (i % 19 === 0 ? 7 : 0)).toFixed(5)),
      ]);
    events.push({
      type: "book",
      timestamp,
      bids: make(-1),
      asks: make(1),
      valid: true,
    });
    events.push({
      type: "trade",
      timestamp,
      price,
      qty: Number((0.01 + rng() * 1.8).toFixed(5)),
      side: rng() > 0.5 ? "buy" : "sell",
    });
  }
  return indexRecording(events);
}
