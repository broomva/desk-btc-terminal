import { createPaperPanel } from "./paper-panel.js";
import { createDepthChart } from "./depth-chart.js";
import {
  bookImbalance,
  demoRecording,
  parseRecording,
  readRecordingResponse,
  replayFrame,
} from "./replay.js";

const $ = (id) => document.getElementById(id);
const priceText = (n) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "—";
const number = (n, digits = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "—";
const time = (n) =>
  Number.isFinite(n) ? new Date(n).toISOString().slice(11, 19) : "—";
const state = {
  source: "demo",
  view: "depth",
  paused: false,
  visible: true,
  book: null,
  price: null,
  history: [],
  trades: [],
  depthFrames: [],
  forecast: null,
  recording: false,
  sessionId: null,
  status: {},
  cursor: 0,
};
let recording = demoRecording();
const demo = recording;
let result = null;
let worker = null;
let requestId = 0;
let generation = 0;
let livePayload = null;
let replayName = "";
let loadId = 0;
let evaluatedInput = null;
let running = false;
let apiAvailable = false;
let polling = false;
let recordedSession = null;
const paperPanel = createPaperPanel(() => ({
  source: state.source,
  recording,
  cursor: state.cursor,
}));
const chart = createDepthChart($("depth-canvas"), () => state);

function status(message, error = false) {
  $("research-status").textContent = message;
  $("research-status").dataset.error = String(error);
}
function cells(values, className) {
  const row = document.createElement("div");
  row.className = className;
  for (const value of values) {
    const span = document.createElement("span");
    span.textContent = value;
    row.append(span);
  }
  return row;
}
function clearResult(
  message = "Run the evaluator on observations up to the current view time.",
) {
  requestId++;
  worker?.terminate();
  worker = null;
  running = false;
  result = null;
  evaluatedInput = null;
  state.forecast = null;
  $("run-tournament").disabled = false;
  $("run-tournament").textContent = "RUN EVALUATOR ↗";
  $("evaluation-state").textContent = message;
  $("agent-rows").replaceChildren(
    cells(["No evaluated agents at this view time."], "research-placeholder"),
  );
  $("mutation-rows").replaceChildren(
    cells(
      ["Accepted and rejected edits appear after evaluation."],
      "research-small",
    ),
  );
  $("experiment-summary").textContent = "NO EVALUATION AT THIS VIEW TIME";
  $("evaluation-receipt").textContent =
    "Past-only features · chronological splits · frozen held-out test";
}
function applyFrame(frame) {
  state.book = frame.book;
  state.history = [...frame.history];
  if (
    frame.book.valid &&
    frame.book.bids.length &&
    frame.book.asks.length &&
    frame.book.timestamp > (state.history.at(-1)?.timestamp ?? 0)
  ) {
    state.history.push({
      timestamp: frame.book.timestamp,
      price: (frame.book.bids[0][0] + frame.book.asks[0][0]) / 2,
      imbalance: bookImbalance(frame.book),
    });
  }
  state.trades = frame.trades;
  state.status = frame.status;
  state.price =
    state.history.at(-1)?.price ??
    (frame.book.bids?.[0] && frame.book.asks?.[0]
      ? (frame.book.bids[0][0] + frame.book.asks[0][0]) / 2
      : null);
  if (state.source !== "live" && recording) {
    state.depthFrames = recording.books
      .filter(
        (b) =>
          b.timestamp <= state.cursor &&
          b.timestamp >= (frame.status.lastGapAt ?? 0),
      )
      .slice(-32);
  } else if (
    frame.book.valid &&
    (!state.depthFrames.length ||
      frame.book.timestamp - state.depthFrames.at(-1).timestamp >= 10000)
  ) {
    state.depthFrames.push(frame.book);
    if (state.depthFrames.length > 90) state.depthFrames.shift();
  }
  if (!frame.book.valid) state.depthFrames = [];
  render();
  chart.draw();
}
function render() {
  const live = state.source === "live",
    demoMode = state.source === "demo";
  const book = state.book;
  const valid = book?.valid && book.bids.length && book.asks.length;
  const age =
    live && book?.timestamp
      ? Math.max(0, Date.now() - book.timestamp) / 1000
      : null;
  const stale =
    live &&
    !state.paused &&
    (age === null || age > 10 || !state.status.connected);
  const source = demoMode ? "DEMO" : live ? "REAL / KRAKEN" : "REPLAY / LOCAL";
  $("depth-eyebrow").textContent =
    `BTC/USD · ${source} · ${state.view === "futures" ? "SIMULATED FUTURES" : "ORDER BOOK"}`;
  $("depth-price").textContent = priceText(state.price);
  $("depth-subline").textContent = state.forecast
    ? `${number(state.forecast.above * 100, 1)}% OF PATHS ABOVE ORIGIN · +15 MIN / SIM`
    : valid
      ? `TOUCH ${priceText(book.bids[0][0])} × ${priceText(book.asks[0][0])}`
      : "Awaiting a valid source snapshot";
  $("depth-bid").textContent = valid
    ? `${number(
        book.bids.reduce((s, r) => s + r[1], 0),
        1,
      )} BTC`
    : "—";
  $("depth-ask").textContent = valid
    ? `${number(
        book.asks.reduce((s, r) => s + r[1], 0),
        1,
      )} BTC`
    : "—";
  $("depth-spread").textContent = valid
    ? priceText(book.asks[0][0] - book.bids[0][0])
    : "—";
  $("depth-integrity").textContent = demoMode
    ? "SYNTHETIC"
    : state.paused && live
      ? "FROZEN VIEW"
      : !valid
        ? "INVALID / GAP"
        : stale
          ? "STALE"
          : live
            ? "CRC VERIFIED"
            : "RECORDED SNAPSHOT";
  $("depth-age").textContent =
    live && !state.paused
      ? age === null
        ? "NO BOOK YET"
        : `AGE ${age.toFixed(1)}s${stale ? " / STALE" : ""}`
      : `${time(book?.timestamp)} UTC / ${state.paused ? "FROZEN" : source}`;
  $("depth-empty").hidden = Boolean(valid);
  $("depth-empty").textContent =
    state.source === "replay" && !recording
      ? "Choose or import a local recording to begin"
      : state.status.error || "Waiting for a valid order-book snapshot";
  $("research-time").textContent =
    `${time(live ? book?.timestamp : state.cursor)} UTC`;
  $("book-level-count").textContent = valid
    ? `${Math.min(book.bids.length, book.asks.length)} LEVELS / SIDE`
    : "NO VALID BOOK";
  $("book-caption").textContent = demoMode
    ? "Synthetic depth / generated fixture"
    : live
      ? "Kraken L2 · 300 levels / side · sampled display"
      : "Recorded depth · sampled snapshots · view time above";
  $("tape-source").textContent = demoMode
    ? "SYNTHETIC"
    : live
      ? "KRAKEN"
      : "REPLAY / SAMPLED";
  const rows = [];
  if (valid)
    for (let i = 0; i < Math.min(9, book.bids.length, book.asks.length); i++) {
      const bid = book.bids[i],
        ask = book.asks[i];
      const row = cells(
        [
          number(bid[1], 4),
          number(bid[0], 2),
          number(ask[0], 2),
          number(ask[1], 4),
        ],
        "real-depth-row",
      );
      row.style.setProperty("--bid-size", `${Math.min(48, bid[1] * 6)}%`);
      row.style.setProperty("--ask-size", `${Math.min(48, ask[1] * 6)}%`);
      rows.push(row);
    }
  $("real-book-rows").replaceChildren(...rows);
  $("real-trade-rows").replaceChildren(
    ...state.trades
      .slice(-9)
      .reverse()
      .map((trade) => {
        const row = cells(
          [
            time(trade.timestamp),
            trade.side.toUpperCase(),
            number(trade.price),
            number(trade.qty, 4),
          ],
          "real-tape-row",
        );
        row.children[1].className = trade.side;
        return row;
      }),
  );
  const forecast = state.forecast;
  $("research-above").replaceChildren(
    document.createTextNode(
      forecast ? `${number(forecast.above * 100, 1)}%` : "—",
    ),
  );
  const small = document.createElement("small");
  small.textContent = "SIMULATED PATHS ABOVE ORIGIN";
  $("research-above").append(small);
  for (const q of ["p10", "median", "p90"])
    $(`research-${q}`).textContent = forecast ? priceText(forecast[q]) : "—";
  $("forecast-provenance").textContent = forecast
    ? `${demoMode ? "DEMO / " : ""}${forecast.paths.length} SIMULATED PATHS · +15 MIN · ${time(forecast.timestamp)} UTC`
    : "NO EVALUATED FUTURES AT THIS VIEW TIME";
  $("research-signal-title").textContent = state.paused
    ? "VIEW FROZEN"
    : demoMode
      ? "DEMO FIXTURE"
      : stale || !valid
        ? "SOURCE UNAVAILABLE"
        : live
          ? "PUBLIC MARKET DATA"
          : "DETERMINISTIC REPLAY";
  $("research-signal-detail").textContent =
    state.paused && live
      ? "Recording continues independently. Resume returns to the latest public feed and clears this forecast."
      : demoMode
        ? "Synthetic depth and prices. Explore the layout, then switch to Kraken or import a recording."
        : stale || !valid
          ? "The last available source remains visible. No demo data is substituted."
          : "Simulated path share is a model assumption. Pinball loss excludes fills, fees and trading returns.";
  $("capture-plan").hidden = !live;
  for (const id of ["capture-minutes", "capture-mib", "capture-purpose"])
    $(id).disabled = state.recording;
  $("record-download").hidden = !live || !recordedSession;
  $("record-download").disabled = !apiAvailable || state.recording;
  $("record-toggle").disabled = !live || !apiAvailable;
  $("record-toggle").textContent = state.recording
    ? "■ STOP RECORDING"
    : "● RECORD";
  $("record-toggle").setAttribute("aria-pressed", String(state.recording));
  $("research-pause").setAttribute("aria-pressed", String(state.paused));
  $("research-pause").textContent = state.paused
    ? state.source === "replay"
      ? "▶ PLAY REPLAY"
      : "▶ RESUME VIEW"
    : "Ⅱ PAUSE VIEW";
  $("replay-transport").hidden = live || !recording;
  if (recording) {
    $("replay-position").value = String(
      Math.round(
        ((state.cursor - recording.start) /
          Math.max(1, recording.end - recording.start)) *
          1000,
      ),
    );
    $("replay-start").textContent = time(state.cursor);
    $("replay-end").textContent = time(recording.end);
  }
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw new Error(
      (await response.json().catch(() => null))?.error ||
        `Local service returned ${response.status}`,
    );
  return response.json();
}
async function pollLive() {
  if (polling || state.source !== "live") return;
  polling = true;
  const current = generation;
  try {
    const payload = await api("/api/market");
    if (generation !== current || state.source !== "live") return;
    apiAvailable = true;
    livePayload = payload;
    state.recording = payload.status.recording;
    state.sessionId = payload.status.sessionId;
    const capture = payload.status;
    $("capture-health").textContent =
      `${capture.recording ? `RECORDING · ${Math.max(0, Math.ceil((capture.deadline - Date.now()) / 1000))}s remaining · ${number(capture.bytes / 1024 ** 2, 2)} MiB / ${number((capture.captureLimits?.maxBytes ?? 0) / 1024 ** 2, 0)} MiB · ${capture.eventCount ?? 0} lines · ${capture.capture?.purpose ?? "unassigned"}` : `IDLE · ${capture.recordingEndReason ?? "No session started"}`} · Book ${capture.bookValid ? "CRC VALID" : "UNAVAILABLE"} · feed gaps since server start ${capture.gaps ?? 0} · last message ${capture.lastMessageAt ? `${Math.max(0, Date.now() - capture.lastMessageAt)}ms ago` : "unavailable"}. Capture observed exchange lead ${capture.captureClock?.observedMaxExchangeLeadMs ?? 0}ms / receipt lag ${capture.captureClock?.observedMaxReceiptLagMs ?? 0}ms. Assumed bound ±${capture.capture?.paperConfig?.maxClockSkewMs ?? 1000}ms${(capture.captureClock?.observedMaxExchangeLeadMs ?? 0) > (capture.capture?.paperConfig?.maxClockSkewMs ?? 1000) ? " / CLOCK BOUND EXCEEDED" : " / NOT CLOCK SYNCHRONIZATION PROOF"}.`;
    if (state.sessionId) recordedSession = state.sessionId;
    const failure = payload.status.recordingError || payload.status.error;
    const label =
      failure ||
      (payload.status.bookValid ? "KRAKEN CONNECTED" : "CONNECTING TO KRAKEN");
    status(
      `${state.recording ? `● RECORDING · ${number(payload.status.bytes / 1024, 0)} KB · ` : ""}${label}`,
      Boolean(failure),
    );
    if (!state.paused) applyFrame(payload);
    else render();
  } catch (error) {
    if (generation !== current) return;
    apiAvailable = false;
    state.status = { ...state.status, connected: false, error: error.message };
    status("LOCAL SERVICE UNAVAILABLE", true);
    render();
  } finally {
    polling = false;
  }
}
async function listRecordings() {
  try {
    const data = await api("/api/recordings");
    if (data.storage)
      $("capture-storage").textContent =
        `Recording storage ${number(data.storage.usedBytes / 1024 ** 3, 3)} / ${number(data.storage.quotaBytes / 1024 ** 3, 1)} GiB · ${number(data.storage.freeDiskBytes / 1024 ** 3, 1)} GiB disk free. Each session reserves its file cap under one local recorder. No files are deleted. Stops at first duration/byte/200,000-line limit.`;
    $("recording-select").replaceChildren(
      new Option("Select local recording", ""),
      ...data.recordings.map(
        (r) =>
          new Option(
            `${r.id} · ${r.purpose ?? "unassigned"} · ${r.active ? "RECORDING" : r.complete ? "ENDED" : "INCOMPLETE"} · ${number(r.bytes / 1024, 0)} KB`,
            r.id,
          ),
      ),
    );
  } catch {
    status("Local server unavailable. Import an NDJSON file instead.", true);
  }
}
function chooseSource() {
  paperPanel.clear();
  generation++;
  loadId++;
  replayName = "";
  clearResult();
  state.source = $("research-source").value;
  state.paused = state.source === "replay";
  state.depthFrames = [];
  state.book = null;
  state.price = null;
  state.history = [];
  state.trades = [];
  state.status = {};
  state.recording = false;
  $("replay-toolbar").hidden = state.source !== "replay";
  if (state.source === "demo") {
    recording = demo;
    state.cursor = recording.end;
    status("DEMO / SYNTHETIC");
    applyFrame(replayFrame(recording, state.cursor));
    runEvaluation(false);
  } else if (state.source === "live") {
    recording = null;
    status("CONNECTING TO LOCAL SERVICE");
    render();
    pollLive();
  } else {
    recording = null;
    status("SELECT A RECORDING");
    render();
    listRecordings();
  }
  chart.draw();
}
function loadRecording(text, name) {
  const parsed = parseRecording(text);
  paperPanel.clear();
  clearResult();
  recording = parsed;
  paperPanel.useCaptureConfig(parsed);
  state.cursor = parsed.end;
  state.paused = true;
  replayName = name;
  $("replay-name").textContent = `${name} · ${number(parsed.count, 0)} events`;
  status("LOCAL REPLAY / LOADED");
  applyFrame(replayFrame(recording, state.cursor));
}
function runEvaluation(freeze = true) {
  if (running) return;
  if (!state.history.length) {
    $("evaluation-state").textContent =
      "No observations available. Connect a source or import a recording.";
    return;
  }
  if (freeze && state.source !== "demo") {
    state.paused = true;
    render();
    chart.draw();
  }
  running = true;
  const id = ++requestId;
  const options = {
    observations: state.history.map((row) => ({ ...row })),
    horizonMinutes: 15,
    rounds: 12,
    pathCount: 120,
    forecastPaths: 1000,
    seed: 3596,
  };
  $("run-tournament").disabled = true;
  $("run-tournament").textContent = "EVALUATING…";
  $("evaluation-state").textContent =
    "Scoring chronological calibration origins, then the frozen test…";
  try {
    worker = new Worker(new URL("./tournament-worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }) => {
      if (data.id !== requestId) return;
      running = false;
      worker?.terminate();
      worker = null;
      $("run-tournament").disabled = false;
      $("run-tournament").textContent = "RUN EVALUATOR ↗";
      if (data.error) {
        $("evaluation-state").textContent = data.error;
        return;
      }
      result = data.result;
      evaluatedInput = options;
      if (result.status !== "ready") {
        $("evaluation-state").textContent = result.reason;
        $("experiment-summary").textContent = "INSUFFICIENT HISTORY";
        return;
      }
      state.forecast = result.forecast;
      showEvaluation();
      render();
      chart.draw();
    };
    worker.onerror = (event) => {
      if (id !== requestId) return;
      running = false;
      worker?.terminate();
      worker = null;
      $("run-tournament").disabled = false;
      $("run-tournament").textContent = "RETRY EVALUATOR ↗";
      $("evaluation-state").textContent =
        `Evaluator unavailable: ${event.message}`;
    };
    worker.postMessage({
      id,
      options,
    });
  } catch (error) {
    running = false;
    $("run-tournament").disabled = false;
    $("evaluation-state").textContent =
      `Evaluator unavailable: ${error.message}`;
  }
}
function showEvaluation() {
  const e = result.evaluation;
  $("evaluation-state").textContent =
    `${state.source === "demo" ? "SYNTHETIC DEMO. " : ""}${e.warning}`;
  $("experiment-summary").textContent =
    `${state.source === "demo" ? "DEMO / " : ""}${result.mutations.length} EDITS · ${result.mutations.filter((m) => m.accepted).length} KEPT`;
  const receipt = [
    ["COMPLETE MINUTES", e.observations],
    ["CALIBRATION ORIGINS", e.validationDecisions],
    ["TEST ORIGINS", e.testDecisions],
    ["FROZEN TEST LOSS / USD", number(e.testScore, 3)],
    ["BASELINE TEST / USD", number(e.baselineTestScore, 3)],
    ["TEST WINDOW / UTC", `${time(e.testStart)}–${time(e.testEnd)}`],
  ];
  $("evaluation-receipt").replaceChildren(
    ...receipt.map(([key, value]) => {
      const el = document.createElement("span");
      el.append(document.createTextNode(`${key} `));
      const strong = document.createElement("strong");
      strong.textContent = value;
      el.append(strong);
      return el;
    }),
  );
  $("agent-rows").replaceChildren(
    ...result.agents.map((agent) => {
      const row = document.createElement("div");
      row.className = "agent-row";
      const identity = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = agent.name || agent.id;
      const config = document.createElement("small");
      config.textContent = `L${agent.config.lookback} / B${agent.config.blockLength} / V${number(agent.config.volScale)} / ${agent.config.bookImbalance ? "BOOK" : "PRICE"}`;
      identity.append(name, config);
      row.append(identity);
      for (const value of [
        `${number(agent.weight, 2)}×`,
        number(agent.score, 3),
        agent.state || "ACTIVE",
      ]) {
        const span = document.createElement("span");
        span.textContent = value;
        row.append(span);
      }
      return row;
    }),
  );
  $("mutation-rows").replaceChildren(
    ...result.mutations.toReversed().map((m) => {
      const change =
        typeof m.change === "string"
          ? m.change
          : m.change
            ? `${m.change.field}: ${m.change.from} → ${m.change.to}`
            : `${m.field}: ${m.from} → ${m.to}`;
      const row = cells(
        [
          String(m.round).padStart(2, "0"),
          m.agentId,
          change,
          m.accepted ? "KEPT" : "REJECTED",
        ],
        "mutation-row",
      );
      row.lastElementChild.className = m.accepted ? "accepted" : "rejected";
      return row;
    }),
  );
}
function selectView(view) {
  state.view = view;
  for (const button of document.querySelectorAll("[data-view]")) {
    const selected = button.dataset.view === view;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  $("depth-panel").hidden = view === "agents";
  $("agents-panel").hidden = view !== "agents";
  $("depth-panel").setAttribute(
    "aria-labelledby",
    `tab-${view === "agents" ? "depth" : view}`,
  );
  chart.setVisible(state.visible && view !== "agents");
  render();
}
function workspace(research) {
  state.visible = research;
  document.body.classList.toggle("research-active", research);
  $("research-desk").hidden = !research;
  $("legacy-terminal").hidden = research;
  $("workspace-research").setAttribute("aria-pressed", String(research));
  $("workspace-legacy").setAttribute("aria-pressed", String(!research));
  chart.setVisible(research && state.view !== "agents");
}
$("workspace-research").addEventListener("click", () => workspace(true));
$("workspace-legacy").addEventListener("click", () => workspace(false));
$("research-source").addEventListener("change", chooseSource);
for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => selectView(button.dataset.view));
  button.addEventListener("keydown", (event) => {
    const views = ["depth", "futures", "agents"];
    let i = views.indexOf(state.view);
    if (event.key === "ArrowRight") i = (i + 1) % 3;
    else if (event.key === "ArrowLeft") i = (i + 2) % 3;
    else if (event.key === "Home") i = 0;
    else if (event.key === "End") i = 2;
    else return;
    event.preventDefault();
    selectView(views[i]);
    $(`tab-${views[i]}`).focus();
  });
}
$("research-pause").addEventListener("click", () => {
  state.paused = !state.paused;
  if (!state.paused && state.source !== "demo") {
    clearResult();
    if (state.source === "live" && livePayload) applyFrame(livePayload);
  }
  render();
  chart.draw();
});
$("motion-toggle").addEventListener("change", (event) =>
  chart.setMotion(event.target.checked),
);
$("run-tournament").addEventListener("click", () => runEvaluation());
$("replay-position").addEventListener("input", () => {
  if (!recording) return;
  paperPanel.clear();
  clearResult();
  state.paused = true;
  state.cursor =
    recording.start +
    (Number($("replay-position").value) / 1000) *
      (recording.end - recording.start);
  applyFrame(replayFrame(recording, state.cursor));
});
$("refresh-recordings").addEventListener("click", listRecordings);
$("recording-select").addEventListener("change", async () => {
  const id = $("recording-select").value;
  if (!id) return;
  const current = generation;
  const currentLoad = ++loadId;
  status("LOADING LOCAL RECORDING");
  try {
    const response = await fetch(
      $("replay-quality").value === "compact"
        ? `/api/recordings/${encodeURIComponent(id)}/replay.ndjson`
        : `/api/recordings/${encodeURIComponent(id)}.ndjson`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok) throw new Error("Could not load this recording.");
    const text = await readRecordingResponse(response);
    if (current !== generation || currentLoad !== loadId) return;
    loadRecording(text, id);
  } catch (error) {
    if (current === generation && currentLoad === loadId)
      status(error.message, true);
  }
});
$("replay-quality").addEventListener("change", () => {
  $("recording-select").dispatchEvent(new Event("change"));
});
$("recording-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const current = generation;
  const currentLoad = ++loadId;
  try {
    if (file.size > 64 * 1024 * 1024)
      throw new Error(
        "File exceeds 64 MB. Use a shorter recording or select the server's compact replay.",
      );
    const text = await file.text();
    if (current === generation && currentLoad === loadId)
      loadRecording(text, file.name);
  } catch (error) {
    if (current === generation && currentLoad === loadId)
      status(error.message, true);
  }
});
function captureNumber(id) {
  if (!$(id).value.trim() || !$(id).checkValidity())
    throw new Error(
      "Enter valid paper fee and spread assumptions before recording.",
    );
  return Number($(id).value);
}
$("record-toggle").addEventListener("click", async () => {
  const button = $("record-toggle");
  button.disabled = true;
  try {
    const data = await api(
      `/api/record/${state.recording ? "stop" : "start"}`,
      state.recording
        ? { method: "POST" }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              maxDurationMs: Number($("capture-minutes").value) * 60000,
              maxBytes: Number($("capture-mib").value) * 1024 ** 2,
              purpose: $("capture-purpose").value,
              paperConfig: {
                makerFeeBps: captureNumber("paper-fee"),
                halfSpreadBps: captureNumber("paper-spread"),
              },
            }),
          },
    );
    state.recording = data.recording;
    state.sessionId = data.sessionId;
    if (data.sessionId) recordedSession = data.sessionId;
    await pollLive();
    await listRecordings();
  } catch (error) {
    status(error.message, true);
  } finally {
    render();
  }
});
$("record-download").addEventListener("click", () => {
  if (!recordedSession || !apiAvailable || state.recording) return;
  const a = document.createElement("a");
  a.href = `/api/recordings/${encodeURIComponent(recordedSession)}.ndjson`;
  a.download = `${recordedSession}.ndjson`;
  a.click();
});
$("research-export").addEventListener("click", () => {
  const exportData = {
    source: state.source,
    session: replayName || (state.source === "demo" ? "synthetic-demo" : null),
    exportedAt: Date.now(),
    result,
    input: evaluatedInput,
    observationCount: evaluatedInput?.observations.length ?? 0,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `desk-${state.source}-research.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
setInterval(() => {
  if (state.source === "live") {
    pollLive();
    return;
  }
  if (
    state.source !== "replay" ||
    state.paused ||
    !recording ||
    document.hidden
  )
    return;
  state.cursor = Math.min(
    recording.end,
    state.cursor + Number($("replay-speed").value) * 1000,
  );
  if (state.cursor === recording.end) state.paused = true;
  applyFrame(replayFrame(recording, state.cursor));
}, 1000);
state.cursor = recording.end;
applyFrame(replayFrame(recording, state.cursor));
runEvaluation(false);
window.addEventListener("beforeunload", () => worker?.terminate());

document.addEventListener("keydown", (event) => {
  if (
    !state.visible ||
    event.code !== "Space" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.target.closest("input,select,button,a,dialog")
  )
    return;
  event.preventDefault();
  $("research-pause").click();
});
