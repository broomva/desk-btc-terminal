// Explicit network smoke; never part of the offline `bun test` suite.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeskServer } from "../server/index.js";
import { parseRecording, replayFrame } from "../dist/replay.js";
import { runPaperExperiment } from "../dist/paper-engine.js";
import { runTournament } from "../dist/tournament.js";

const captureMs = Number(process.env.DESK_CAPTURE_MS || 12000);
assert.ok(
  Number.isSafeInteger(captureMs) && captureMs >= 1000 && captureMs <= 1800000,
);
const dataDir = mkdtempSync(join(tmpdir(), "desk-v2-live-"));
const desk = createDeskServer({ port: 0, dataDir });
const url = (path) => new URL(path, desk.server.url);
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error("Kraken book timed out"));
    }, 20000);
    const timer = setInterval(() => {
      if (desk.status().bookValid) {
        clearTimeout(timeout);
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
  const market = await (await fetch(url("/api/market"))).json();
  assert.equal(market.book.bids.length, 300);
  assert.equal(market.book.asks.length, 300);
  assert.equal(market.status.bookValid, true);
  const started = await (
    await fetch(url("/api/record/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxDurationMs: captureMs,
        purpose: "development",
      }),
    })
  ).json();
  assert.equal(started.recording, true);
  await new Promise((resolve) => setTimeout(resolve, captureMs + 250));
  assert.equal(
    desk.status().recording,
    false,
    "deadline auto-stops real acquisition",
  );
  const stopped = await (
    await fetch(url("/api/record/stop"), { method: "POST" })
  ).json();
  assert.equal(stopped.recording, false);
  assert.equal(stopped.recordingError, null);
  const raw = await (
    await fetch(url(`/api/recordings/${started.sessionId}.ndjson`))
  ).text();
  const compact = await (
    await fetch(url(`/api/recordings/${started.sessionId}/replay.ndjson`))
  ).text();
  const rawParsed = parseRecording(raw);
  assert.equal(
    rawParsed.metadata.endReason,
    "Recording duration limit reached",
  );
  const paper = runPaperExperiment(
    rawParsed,
    rawParsed.metadata.experiment.paperConfig,
  );
  assert.equal(paper.policies.length, 2);
  assert.ok(paper.source.includes("Kraken"));
  assert.throws(
    () => runPaperExperiment(parseRecording(compact)),
    /raw recording/,
  );
  writeFileSync(
    join(dataDir, "paper-result.json"),
    JSON.stringify(paper, null, 2),
  );
  const parsed = parseRecording(compact);
  const frame = replayFrame(parsed, parsed.end);
  assert.equal(frame.book.valid, true);
  assert.ok(frame.history.length > 0);
  const short = runTournament({ observations: frame.history });
  assert.equal(short.status, "insufficient");
  assert.match(short.reason, /minute|history/i);
  writeFileSync(join(dataDir, "compact-replay.ndjson"), compact);
  const receipt = {
    result: "PASS",
    source: "Kraken public BTC/USD",
    timestamp: new Date().toISOString(),
    bids: market.book.bids.length,
    asks: market.book.asks.length,
    gaps: stopped.gaps,
    books: parsed.books.length,
    trades: parsed.trades.length,
    observations: parsed.observations.length,
    rawBytes: Buffer.byteLength(raw),
    compactBytes: Buffer.byteLength(compact),
    recording: started.sessionId,
    dataDir,
    research: short.status,
    paper: paper.policies.map((p) => ({ id: p.id, metrics: p.metrics })),
  };
  writeFileSync(
    join(dataDir, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
} finally {
  desk.stop();
}
