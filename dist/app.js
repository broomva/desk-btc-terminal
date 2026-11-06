import {
  WINDOW_SECONDS,
  STALE_MS,
  random,
  normal,
  clamp,
  model,
  bestEdge,
  createSession,
  paperBuy,
  settle,
  freshness,
  parseTicker,
  fillsCSV,
} from "./engine.js";
import { createChart } from "./chart.js";

const $ = (id) => document.getElementById(id);
const money = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signed = (n) => `${n < 0 ? "−" : "+"}${money(Math.abs(n))}`;
const clock = (time) => new Date(time).toISOString().slice(11, 19);
const rng = random(2710);
const state = {
  mode: "demo",
  paused: false,
  elapsed: 120,
  reference: 80337.83,
  price: 80340.97,
  history: [],
  lastTick: Date.now(),
  volatility: 1,
  threshold: 5,
  paths: 120,
  upAsk: 0.49,
  downAsk: 0.53,
  bookSide: "UP",
  session: createSession(),
  windowId: 1,
  liveWindow: null,
  socket: null,
  connection: "DEMO ENGINE CONNECTED",
};
const canvas = $("market-chart");
const chart = createChart(canvas, () => state, onProjection);
let latestProjection = null;
let lastConnection = "";
let logIndex = 0;
let toastTimer;
let connectionTimer;
let generation = 0;

function seedDemo() {
  state.reference = 80337.83;
  state.price = 80340.97;
  state.elapsed = 120;
  state.history = [];
  for (let t = 0; t <= 120; t += 2) {
    const texture = Math.sin(t / 9) * 12 + Math.sin(t / 25) * 55;
    const textureEnd = Math.sin(120 / 9) * 12 + Math.sin(120 / 25) * 55;
    const y =
      state.reference +
      Math.sin(t / 22) * 12 +
      Math.sin(t / 8) * 3 +
      t * 0.11 +
      texture -
      (t / 120) * textureEnd;
    state.history.push({ t, price: y });
  }
  state.price = state.history.at(-1).price;
  state.lastTick = Date.now();
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 3200);
}

function dailyGrid() {
  const daily = random(981);
  const cells = [];
  let traded = 0;
  for (let i = 0; i < 288; i++) {
    const value = daily();
    const result = value < 0.26 ? "win" : value < 0.37 ? "loss" : "";
    if (result) traded++;
    const cell = document.createElement("span");
    cell.className = `window-cell ${result}${i === 196 ? " current" : ""}`;
    cell.title = `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")} · DEMO ${result || "skip"}`;
    cells.push(cell);
  }
  $("window-grid").replaceChildren(...cells);
  $("window-traded").textContent = `${traded} / 288`;
  $("participation").textContent = `${((traded / 288) * 100).toFixed(1)}%`;
}

function renderBook() {
  const ask = state.bookSide === "UP" ? state.upAsk : state.downAsk;
  const bookRng = random(
    Math.floor(state.elapsed / 3) + (state.bookSide === "UP" ? 20 : 40),
  );
  const build = (isAsk) => {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const level = isAsk ? 4 - i : i;
      const price = clamp(
        ask + (isAsk ? level * 0.01 : -0.02 - level * 0.01),
        0.001,
        0.999,
      );
      const shares = Math.floor(240 + bookRng() * 1600);
      const row = document.createElement("div");
      row.className = `book-row ${isAsk ? "ask" : "bid"}`;
      row.style.setProperty("--depth", (shares / 1900).toFixed(3));
      const priceEl = document.createElement("span");
      const sharesEl = document.createElement("span");
      priceEl.textContent = price.toFixed(3);
      sharesEl.textContent = shares.toLocaleString("en-US");
      row.append(priceEl, sharesEl);
      rows.push(row);
    }
    return rows;
  };
  $("asks").replaceChildren(...build(true));
  $("bids").replaceChildren(...build(false));
  $("spread").textContent = (ask - clamp(ask - 0.02, 0.001, 0.999)).toFixed(3);
}

function renderSession() {
  $("pnl").textContent = signed(state.session.pnl);
  $("balance").textContent = money(state.session.cash);
  $("positions").textContent = state.session.fills.filter(
    (f) => f.status === "OPEN",
  ).length;
  if (!state.session.fills.length) {
    $("fills").innerHTML =
      '<div class="empty-fills">No paper fills yet.<br><span class="dim">Place a demo entry below.</span></div>';
    return;
  }
  $("fills").replaceChildren(
    ...state.session.fills.slice(0, 80).map((fill) => {
      const row = document.createElement("div");
      row.className = "fill-row";
      row.title = `${fill.status} · ${fill.status === "OPEN" ? "settles at demo window close" : signed(fill.pnl)}`;
      for (const value of [
        clock(fill.time),
        fill.side,
        fill.ask.toFixed(2),
        fill.stake.toFixed(0),
      ]) {
        const span = document.createElement("span");
        span.textContent = value;
        row.append(span);
      }
      row.children[1].className = fill.side === "UP" ? "yellow" : "dim";
      return row;
    }),
  );
}

function render() {
  const left = Math.max(0, WINDOW_SECONDS - state.elapsed);
  const fresh = freshness(state.lastTick, Date.now());
  state.visualStale = fresh.stale;
  document.body.classList.toggle("motion-paused", state.paused || fresh.stale);
  const hasPrice = state.lastTick !== null;
  const prob = model(state.price, state.reference, left, state.volatility);
  const edge = bestEdge(
    prob,
    state.upAsk,
    state.downAsk,
    state.threshold,
    left,
  );
  const observing = state.mode === "live";
  const inactive = state.paused || fresh.stale;
  $("countdown").textContent =
    `T−${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`;
  $("price").textContent = hasPrice ? money(state.price) : "—";
  $("reference").textContent = hasPrice
    ? money(state.reference)
    : "WAITING FOR TICK";
  $("price-delta").replaceChildren();
  $("price-delta").append(
    document.createTextNode(
      hasPrice
        ? `${signed(state.price - state.reference)} `
        : "Waiting for Coinbase ",
    ),
  );
  const deltaNote = document.createElement("span");
  deltaNote.className = "dim";
  deltaNote.textContent = "vs. window reference";
  $("price-delta").append(deltaNote);
  $("scan-state").textContent = state.paused
    ? "PAUSED"
    : fresh.stale
      ? hasPrice
        ? "STALE FEED"
        : "CONNECTING"
      : observing
        ? "OBSERVING"
        : edge.ready
          ? `PAPER ${edge.side}`
          : "SCANNING";
  $("scan-detail").textContent = observing
    ? " / spot feed only"
    : left > 180
      ? " / waiting for entry zone"
      : " / entry zone active";
  $("tick-age").textContent =
    fresh.age === null
      ? "NO TICKS RECEIVED"
      : `TICK AGE ${(fresh.age / 1000).toFixed(1)}s${fresh.stale ? " · STALE" : ""}`;
  document.body.classList.toggle("stale", fresh.stale);
  $("signal").textContent = inactive
    ? state.paused
      ? "PAUSED"
      : "STALE"
    : observing
      ? "DEMO"
      : edge.ready
        ? edge.side
        : "WATCH";
  $("edge").textContent = `${edge.edge >= 0 ? "+" : ""}${edge.edge.toFixed(1)}`;
  $("prob-up").textContent = `${(prob.up * 100).toFixed(1)}%`;
  $("prob-bar").style.width = `${prob.up * 100}%`;
  for (const side of ["up", "down"]) {
    $(`${side}-ask`).textContent = state[`${side}Ask`].toFixed(2);
    $(`${side}-fair`).textContent = prob[side].toFixed(3);
    $(`${side}-edge`).textContent =
      `${edge[side] >= 0 ? "+" : ""}${edge[side].toFixed(1)}`;
  }
  $("ticker-state").textContent = observing ? "SPOT" : "SCOUT";
  $("ticker-message").textContent = observing
    ? "Coinbase BTC-USD · reference = first observed tick · lower panels are illustrations"
    : inactive
      ? "Demo paused or stale · paper entries unavailable"
      : `Best ${edge.side} · ask ${state[`${edge.side.toLowerCase()}Ask`].toFixed(2)} vs fair ${prob[edge.side.toLowerCase()].toFixed(3)} · ${edge.edge.toFixed(1)} pts · ${edge.ready ? "illustrative edge found" : "watching the window"}`;
  $("connection").textContent = state.connection;
  $("render-state").textContent = state.paused
    ? "PAUSED"
    : fresh.stale
      ? "WAITING FOR DATA"
      : "RUNNING";
  $("clock").textContent = `${clock(Date.now())} UTC`;
  const start =
    observing && state.liveWindow !== null
      ? state.liveWindow * 300_000
      : Date.now() - state.elapsed * 1000;
  $("window-range").textContent =
    `${clock(start).slice(0, 5)}—${clock(start + 300_000).slice(0, 5)} UTC`;
  $("buy-up").disabled = observing || inactive || state.session.cash < 10;
  $("buy-down").disabled = observing || inactive || state.session.cash < 10;
  if (state.connection !== lastConnection) {
    addLog(
      state.mode === "live" ? "FEED" : "SYS",
      state.connection.toLowerCase(),
    );
    lastConnection = state.connection;
  }
  $("console-status").textContent = state.paused
    ? "simulation paused"
    : fresh.stale
      ? "waiting for fresh data"
      : "simulation engine active";
  if (latestProjection) showProjection(latestProjection);
  renderBook();
}

function drawChart() {
  chart.draw();
}

function addLog(level, text) {
  const log = $("run-log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const row = document.createElement("div");
  row.className = "log-row";
  for (const [value, className] of [
    [String(++logIndex).padStart(2, "0"), "log-index"],
    [clock(Date.now()), "log-time"],
    [level, `log-level ${level.toLowerCase()}`],
    [text, "log-message"],
  ]) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = value;
    row.append(span);
  }
  log.append(row);
  while (log.children.length > 60) log.firstElementChild.remove();
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function showProjection(projection, refreshGrid = false) {
  const last = projection.median.length - 1;
  const low = state.price + projection.p10[last];
  const high = state.price + projection.p90[last];
  const median = state.price + projection.median[last];
  $("forecast-median").textContent = money(median);
  $("forecast-high").textContent = money(high);
  $("forecast-low").textContent = money(low);
  $("forecast-spread").textContent = money(high - low);
  $("median-marker").style.left =
    `${clamp((median - low) / Math.max(1e-8, high - low), 0, 1) * 100}%`;
  $("sample-total").textContent = `${projection.count} SAMPLES`;
  $("paths-up").textContent = projection.up;
  $("paths-down").textContent = projection.down;
  const agreement =
    (Math.max(projection.up, projection.down) / projection.count) * 100;
  $("agreement-value").textContent = `${agreement.toFixed(0)}%`;
  $("agreement-bar").style.width = `${agreement}%`;
  $("regime-label").textContent =
    agreement < 60
      ? "BALANCED"
      : projection.up > projection.down
        ? "UP BIAS"
        : "DOWN BIAS";
  $("regime-label").classList.toggle(
    "down-bias",
    projection.down > projection.up && agreement >= 60,
  );
  $("sample-grid").setAttribute(
    "aria-label",
    `${projection.up} simulated paths end up; ${projection.down} end down; ${projection.count} total`,
  );
  if (refreshGrid) {
    const cells = Array.from({ length: projection.count }, (_, i) => {
      const cell = document.createElement("i");
      cell.className = i < projection.up ? "sample-up" : "sample-down";
      cell.style.setProperty("--cell-index", i % 20);
      return cell;
    });
    $("sample-grid").replaceChildren(...cells);
  }
}

function onProjection(projection) {
  latestProjection = projection;
  showProjection(projection, true);
  addLog(
    "SIM",
    `${projection.count} paths · ${(300 - state.elapsed).toFixed(0)}s horizon · median ${money(state.price + projection.median.at(-1))}`,
  );
}

function updateDemo() {
  if (state.paused) return;
  state.elapsed++;
  if (state.elapsed >= 300) {
    settle(state.session, state.windowId, state.price, state.reference);
    state.windowId++;
    state.reference = state.price;
    state.elapsed = 0;
    state.history = [{ t: 0, price: state.price }];
    renderSession();
    toast("Window closed. Paper positions settled.");
  } else {
    state.price += normal(rng) * 2.8 * state.volatility;
    state.history.push({ t: state.elapsed, price: state.price });
  }
  state.lastTick = Date.now();
  const probability = model(
    state.price,
    state.reference,
    300 - state.elapsed,
    state.volatility,
  );
  const deviation = Math.sin(state.elapsed / 26) * 0.065;
  state.upAsk =
    Math.round(clamp(probability.up + deviation + 0.01, 0.03, 0.97) * 100) /
    100;
  state.downAsk =
    Math.round(clamp(1 - state.upAsk + 0.02, 0.03, 0.97) * 100) / 100;
}

function disconnect() {
  generation++;
  clearTimeout(connectionTimer);
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.onerror = null;
    state.socket.close();
    state.socket = null;
  }
}

function connectLive() {
  disconnect();
  const currentGeneration = generation;
  state.lastTick = null;
  state.history = [];
  state.liveWindow = null;
  state.connection = "CONNECTING TO COINBASE";
  const fail = (message) => {
    if (generation !== currentGeneration) return;
    state.connection = message;
    clearTimeout(connectionTimer);
    if (state.socket) {
      state.socket.onclose = null;
      state.socket.close();
      state.socket = null;
    }
    render();
    drawChart();
    toast("Live feed unavailable. Re-select Live to retry, or choose Demo.");
  };
  try {
    const socket = new WebSocket("wss://ws-feed.exchange.coinbase.com");
    state.socket = socket;
    connectionTimer = setTimeout(
      () => fail("COINBASE CONNECTION TIMED OUT"),
      15_000,
    );
    socket.onopen = () => {
      if (generation !== currentGeneration) return;
      socket.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: ["BTC-USD"],
          channels: ["ticker"],
        }),
      );
    };
    socket.onmessage = (event) => {
      if (generation !== currentGeneration || state.mode !== "live") return;
      const price = parseTicker(event.data);
      if (price === null) return;
      clearTimeout(connectionTimer);
      const now = Date.now();
      const window = Math.floor(now / 300_000);
      if (state.liveWindow !== window) {
        state.liveWindow = window;
        state.reference = price;
        state.history = [];
      }
      state.elapsed = (now % 300_000) / 1000;
      state.price = price;
      state.lastTick = now;
      const previous = state.history.at(-1);
      if (!previous || state.elapsed - previous.t > 0.5)
        state.history.push({ t: state.elapsed, price });
      else previous.price = price;
      state.connection = "COINBASE BTC-USD CONNECTED";
    };
    socket.onerror = () => fail("COINBASE CONNECTION ERROR");
    socket.onclose = () => fail("COINBASE DISCONNECTED");
  } catch {
    fail("LIVE FEED UNSUPPORTED");
  }
}

function switchSource() {
  const nextMode = $("source").value;
  if (nextMode === state.mode) return;
  if (
    nextMode === "live" &&
    state.session.fills.some((f) => f.status === "OPEN")
  ) {
    $("source").value = "demo";
    toast(
      "Open demo positions must settle, or reset the paper session in settings.",
    );
    return;
  }
  state.mode = nextMode;
  latestProjection = null;
  for (const id of [
    "forecast-median",
    "forecast-high",
    "forecast-low",
    "forecast-spread",
    "paths-up",
    "paths-down",
    "agreement-value",
  ])
    $(id).textContent = "—";
  $("sample-grid").replaceChildren();
  $("regime-label").textContent = "WAITING";
  state.paused = false;
  $("pause").textContent = "Ⅱ";
  $("pause").setAttribute("aria-pressed", "false");
  $("pause").setAttribute("aria-label", "Pause demo");
  $("pause").disabled = nextMode === "live";
  $("feed-label").textContent =
    nextMode === "live" ? "LIVE SPOT / DEMO ANALYTICS" : "SIMULATED MARKET";
  $("spot-source").textContent = nextMode === "live" ? "/ COINBASE" : "/ DEMO";
  $("reference-label").textContent =
    nextMode === "live" ? "FIRST OBSERVED SPOT" : "WINDOW REFERENCE";
  $("chart-caption").textContent =
    nextMode === "live" ? "COINBASE SPOT · NOT SETTLEMENT" : "OBSERVED IN DEMO";
  if (nextMode === "live") connectLive();
  else {
    disconnect();
    seedDemo();
    state.connection = "DEMO ENGINE CONNECTED";
  }
  render();
  drawChart();
}

function togglePause() {
  if (state.mode !== "demo") return;
  state.paused = !state.paused;
  if (!state.paused) state.lastTick = Date.now();
  $("pause").textContent = state.paused ? "▶" : "Ⅱ";
  $("pause").setAttribute("aria-pressed", String(state.paused));
  $("pause").setAttribute(
    "aria-label",
    state.paused ? "Resume demo" : "Pause demo",
  );
  addLog("SYS", state.paused ? "demo paused by operator" : "demo resumed");
  render();
  drawChart();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast(
      "Full screen is unavailable in this view. Open the dashboard directly.",
    );
  }
}

function buy(side) {
  if (
    state.mode !== "demo" ||
    state.paused ||
    freshness(state.lastTick, Date.now()).stale
  )
    return;
  if (
    !paperBuy(
      state.session,
      side,
      state[`${side.toLowerCase()}Ask`],
      state.windowId,
      Date.now(),
    )
  ) {
    toast("Insufficient paper cash.");
    return;
  }
  renderSession();
  render();
  addLog(
    "PAPER",
    `${side} entry · $10 · ask ${state[`${side.toLowerCase()}Ask`].toFixed(2)}`,
  );
  toast(`Paper ${side} filled · $10 · settles at window close`);
}

$("source").addEventListener("change", switchSource);
$("pause").addEventListener("click", togglePause);
$("fullscreen").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () =>
  $("fullscreen").setAttribute(
    "aria-label",
    document.fullscreenElement ? "Exit full screen" : "Enter full screen",
  ),
);
$("settings").addEventListener("click", () => $("settings-dialog").showModal());
$("about").addEventListener("click", () => $("about-dialog").showModal());
for (const close of document.querySelectorAll(".close-dialog"))
  close.addEventListener("click", () => close.closest("dialog").close());
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("settings-dialog").close();
});
$("volatility").addEventListener("input", (event) => {
  state.volatility = Number(event.target.value);
  $("vol-value").textContent = `${state.volatility.toFixed(1)}×`;
  render();
  drawChart();
});
$("min-edge").addEventListener("input", (event) => {
  state.threshold = Number(event.target.value);
  $("edge-value").textContent = `${state.threshold.toFixed(1)} pts`;
  $("threshold-label").textContent =
    `MIN EDGE ${state.threshold.toFixed(1)} pts`;
  render();
});
$("paths").addEventListener("change", (event) => {
  state.paths = Number(event.target.value);
  $("path-count").textContent = state.paths;
  drawChart();
});
$("reset-session").addEventListener("click", () => {
  state.session = createSession();
  renderSession();
  render();
  toast("Paper session reset · $1,000 starting cash");
});
for (const side of ["UP", "DOWN"]) {
  $(`buy-${side.toLowerCase()}`).addEventListener("click", () => buy(side));
  $(`book-${side.toLowerCase()}`).addEventListener("click", () => {
    state.bookSide = side;
    $("book-up").setAttribute("aria-pressed", String(side === "UP"));
    $("book-down").setAttribute("aria-pressed", String(side === "DOWN"));
    renderBook();
  });
}
$("export").addEventListener("click", () => {
  if (!state.session.fills.length) {
    toast("No fills to export. Place a paper entry first.");
    return;
  }
  const url = URL.createObjectURL(
    new Blob([fillsCSV(state.session.fills)], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `desk-paper-fills-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Paper fills exported.");
});
document.addEventListener("keydown", (event) => {
  if (
    event.target.closest("input,select,button,a,dialog") ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  if (
    event.code === "Space" &&
    !document.body.classList.contains("research-active")
  ) {
    event.preventDefault();
    togglePause();
  }
  if (event.key.toLowerCase() === "f") toggleFullscreen();
});
$("motion-toggle").addEventListener("change", (event) => {
  chart.setMotion(event.target.checked);
  document.body.classList.toggle("motion-off", !event.target.checked);
  addLog(
    "SYS",
    event.target.checked ? "ambient motion enabled" : "ambient motion disabled",
  );
});
window.addEventListener("beforeunload", disconnect);
seedDemo();
addLog("SYS", "DESK observatory initialized · v1.1");
addLog("SYS", "tick candles · sample quantiles · no AI model connected");
dailyGrid();
renderSession();
render();
setInterval(() => {
  if (state.mode === "demo") updateDemo();
  else if (state.lastTick !== null) {
    state.elapsed = (Date.now() % 300_000) / 1000;
    if (Date.now() - state.lastTick > STALE_MS)
      state.connection = "COINBASE FEED STALE · RESELECT LIVE TO RETRY";
  }
  render();
  drawChart();
}, 1000);
