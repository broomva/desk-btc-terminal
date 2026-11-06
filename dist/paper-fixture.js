import { indexRecording } from "./replay.js";

// Deliberately artificial fills exercise accounting; never a performance sample.
export function paperFixture() {
  const start = Date.UTC(2026, 10, 5, 12);
  const events = [];
  for (let second = 0; second <= 900; second++) {
    const timestamp = start + second * 1000;
    const mid =
      10000 +
      Math.sin(second / 45) * 12 +
      (second > 300 && second < 480
        ? (second - 300) * 0.5
        : second >= 480
          ? 90
          : 0);
    events.push({
      type: "book",
      timestamp,
      receiveTimestamp: timestamp,
      valid: true,
      bids: [[mid - 1, 1]],
      asks: [[mid + 1, 1]],
    });
    if (second % 7 === 1) {
      const side = second % 2 ? "sell" : "buy";
      events.push({
        type: "trade",
        timestamp: timestamp + 100,
        receiveTimestamp: timestamp + 150,
        side,
        price: mid + (side === "sell" ? -22 : 22),
        qty: 0.0004,
      });
    }
  }
  return indexRecording(events, {
    source: "SYNTHETIC PAPER FIXTURE",
    synthetic: true,
    trades: "all generated events",
    bookSampleMs: 1000,
  });
}
