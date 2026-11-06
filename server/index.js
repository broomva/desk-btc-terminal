import { join, resolve, sep } from "node:path";
import { Book, parseWire } from "./market.js";
import { Recorder, RECORDING_ID } from "./recorder.js";
import { captureOptions } from "./capture.js";
import { compactReplayStream } from "./compact.js";

const ROOT = resolve(import.meta.dir, "..");
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const failure = (message, status) => json({ error: message }, status);

export function createDeskServer({
  port = 5173,
  dataDir = join(ROOT, "data"),
  connect = true,
  socketFactory = (url) => new WebSocket(url),
} = {}) {
  const book = new Book(500);
  const recorder = new Recorder(dataDir);
  const trades = [];
  const history = [];
  let socket = null;
  let reconnectTimer = null;
  let closed = false;
  let attempt = 0;
  let receivedAt = null;
  let connected = false;
  let error = null;
  let recordingError = null;
  let gaps = 0;
  let streamBroken = false;
  let nextHistoryAt = 0;
  let lastBookTimestamp = null;
  let lastBookReceivedAt = null;
  const seenTradeIds = new Set();
  const status = () => ({
    connected,
    recording: recorder.active,
    sessionId: recorder.id,
    lastMessageAt: receivedAt,
    lastBookMessageAt: lastBookReceivedAt,
    error: recordingError || recorder.error || error,
    recordingError: recordingError || recorder.error,
    recordingEndReason: recorder.endReason,
    bookValid: book.valid,
    gaps,
    bytes: recorder.bytes,
    startedAt: recorder.startedAt,
    capture: recorder.capture,
    captureLimits: {
      maxBytes: recorder.maxBytes,
      maxDurationMs: recorder.maxDuration,
      maxEvents: recorder.maxEvents,
    },
    deadline:
      recorder.startedAt === null
        ? null
        : recorder.startedAt + recorder.maxDuration,
    eventCount: recorder.eventCount,
    counts: recorder.counts,
    captureClock: recorder.clock,
  });

  function record(event, now) {
    try {
      recorder.record({ ...event, receiveTimestamp: now ?? Date.now() }, now);
    } catch (cause) {
      recordingError = `Recording failed: ${cause.message}`;
      try {
        recorder.stop(recordingError);
      } catch {
        /* file may already be unavailable */
      }
    }
  }

  function gap(reason, now = Date.now()) {
    if (!streamBroken) {
      gaps++;
      record(
        {
          type: "gap",
          // Project the failure onto the exchange display axis using elapsed
          // receive time. The exact failure clock remains receiveTimestamp.
          timestamp:
            lastBookTimestamp === null
              ? now
              : lastBookTimestamp + Math.max(0, now - lastBookReceivedAt),
          timestampBasis: "last exchange book plus elapsed receive time",
          receiveTimestamp: now,
          reason,
        },
        now,
      );
    }
    streamBroken = true;
    history.length = 0;
    nextHistoryAt = 0;
    error = reason;
    book.invalidate();
  }

  function observe(price, timestamp, imbalance, now) {
    if (timestamp < nextHistoryAt) return;
    const observation = { timestamp, price, imbalance };
    history.push(observation);
    record({ type: "observation", ...observation }, now);
    // Keep about 24 hours while bounding browser transfer to 8,640 points.
    // Every completed minute remains represented for the research evaluator.
    nextHistoryAt = timestamp + 10000;
    if (history.length > 8640) history.splice(0, history.length - 8640);
  }

  function ingest(raw, now = Date.now()) {
    try {
      const message = parseWire(String(raw));
      receivedAt = now;
      if (message.success === false)
        throw new Error(message.error || "Kraken subscription rejected");
      if (message.channel === "book") {
        if (!Array.isArray(message.data) || message.data.length !== 1)
          throw new Error("Malformed book message");
        const snapshot = book.apply(message.type, message.data[0], now);
        lastBookTimestamp = snapshot.timestamp;
        lastBookReceivedAt = now;
        const bids = snapshot.bids
          .slice(0, 25)
          .reduce((sum, level) => sum + level[1], 0);
        const asks = snapshot.asks
          .slice(0, 25)
          .reduce((sum, level) => sum + level[1], 0);
        record({ type: "book", ...snapshot }, now);
        observe(
          (snapshot.bids[0][0] + snapshot.asks[0][0]) / 2,
          snapshot.timestamp,
          (bids - asks) / (bids + asks),
          now,
        );
        error = null;
        streamBroken = false;
        attempt = 0;
      } else if (message.channel === "trade") {
        if (!Array.isArray(message.data))
          throw new Error("Malformed trade message");
        for (const item of message.data) {
          if (item.symbol !== "BTC/USD") continue;
          const price = Number(item.price),
            qty = Number(item.qty),
            timestamp = Date.parse(item.timestamp);
          if (
            !(price > 0) ||
            !Number.isFinite(price) ||
            !(qty > 0) ||
            !Number.isFinite(qty) ||
            !Number.isFinite(timestamp) ||
            !["buy", "sell"].includes(item.side)
          )
            throw new Error("Malformed trade data");
          const id = Number(item.trade_id);
          if (Number.isSafeInteger(id)) {
            if (seenTradeIds.has(id)) continue;
            seenTradeIds.add(id);
            // Bounded cache covers more IDs than any complete raw capture can
            // hold; an unseen lower ID is not evidence of a duplicate.
            if (seenTradeIds.size > 250000)
              seenTradeIds.delete(seenTradeIds.values().next().value);
          }
          const trade = { timestamp, price, qty, side: item.side };
          trades.push(trade);
          trades.sort((a, b) => a.timestamp - b.timestamp);
          if (trades.length > 100) trades.shift();
          record({ type: "trade", ...trade }, now);
        }
      }
      return true;
    } catch (cause) {
      gap(cause.message, now);
      if (socket) socket.close();
      return false;
    }
  }

  function openFeed() {
    if (closed) return;
    try {
      socket = socketFactory("wss://ws.kraken.com/v2");
      socket.onopen = () => {
        if (closed) return socket.close();
        connected = true;
        receivedAt = Date.now();
        socket.send(
          JSON.stringify({
            method: "subscribe",
            params: {
              channel: "book",
              symbol: ["BTC/USD"],
              depth: 500,
              snapshot: true,
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "subscribe",
            params: { channel: "trade", symbol: ["BTC/USD"], snapshot: false },
          }),
        );
      };
      socket.onmessage = (event) => ingest(event.data);
      socket.onerror = () => {
        error = "Kraken connection error";
        socket.close();
      };
      socket.onclose = () => {
        connected = false;
        if (closed) return;
        gap(error || "Kraken disconnected; reconnecting");
        reconnectTimer = setTimeout(
          openFeed,
          Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)),
        );
      };
    } catch (cause) {
      gap(cause.message);
      reconnectTimer = setTimeout(
        openFeed,
        Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)),
      );
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      // Reject DNS rebinding and cross-origin mutating requests. All interfaces
      // are loopback-only and no cross-origin response permission is granted.
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        request.headers.get("host") !== url.host
      )
        return failure("Loopback Host required", 403);
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
        return failure("Same-origin access required", 403);
      const path = url.pathname;
      if (path.startsWith("/api/")) {
        try {
          if (request.method === "GET" && path === "/api/status")
            return json(status());
          if (request.method === "GET" && path === "/api/market")
            return json({
              book: book.snapshot(),
              trades,
              history,
              status: status(),
            });
          if (request.method === "GET" && path === "/api/recordings")
            return json({
              recordings: recorder.recordings(),
              storage: recorder.storage(),
            });
          if (request.method === "GET" && path.startsWith("/api/recordings/")) {
            const compact = path.endsWith("/replay.ndjson");
            const idPath = compact
              ? path.slice(0, -"/replay.ndjson".length)
              : path;
            const id = decodeURIComponent(
              idPath.slice("/api/recordings/".length),
            ).replace(/\.ndjson$/, "");
            if (!RECORDING_ID.test(id))
              return failure("Invalid recording id", 400);
            const file = Bun.file(join(dataDir, `${id}.ndjson`));
            if (!(await file.exists()))
              return failure("Recording not found", 404);
            if (recorder.active && recorder.id === id)
              return failure(
                "Stop this recording before loading its raw or compact replay",
                409,
              );
            return new Response(compact ? compactReplayStream(file) : file, {
              headers: {
                "Content-Type": "application/x-ndjson",
                "Content-Disposition": `attachment; filename="${id}${compact ? "-replay" : ""}.ndjson"`,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              },
            });
          }
          if (request.method === "POST" && path === "/api/record/start") {
            let options;
            try {
              let text = "",
                bytes = 0;
              const reader = request.body?.getReader();
              if (reader) {
                const decoder = new TextDecoder();
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  bytes += chunk.value.byteLength;
                  if (bytes > 8192) {
                    await reader.cancel();
                    return failure("Capture settings exceed 8 KiB", 413);
                  }
                  text += decoder.decode(chunk.value, { stream: true });
                }
                text += decoder.decode();
              }
              const value = text.trim() ? JSON.parse(text) : {};
              options = captureOptions(value);
              if (recorder.active) {
                if (Object.keys(value).length)
                  return failure(
                    "Stop the active session before changing its frozen capture plan.",
                    409,
                  );
                return json(status());
              }
            } catch (cause) {
              return failure(cause.message, 400);
            }
            try {
              recorder.start(book.snapshot(), Date.now(), options);
            } catch (cause) {
              recordingError = `Recording failed: ${cause.message}`;
              return failure(
                recordingError,
                /quota|free disk/.test(cause.message) ? 507 : 500,
              );
            }
            recordingError = null;
            return json(status());
          }
          if (request.method === "POST" && path === "/api/record/stop") {
            try {
              recorder.stop();
            } catch (cause) {
              recordingError = `Recording failed: ${cause.message}`;
              return failure(recordingError, 500);
            }
            return json(status());
          }
          return failure("Unknown API endpoint or method", 404);
        } catch (cause) {
          return failure(cause.message, 500);
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return failure("Method not allowed", 405);
      let name;
      try {
        name = decodeURIComponent(path);
      } catch {
        return failure("Invalid path", 400);
      }
      const asset = resolve(
        ROOT,
        "dist",
        `.${name === "/" ? "/index.html" : name}`,
      );
      if (!asset.startsWith(`${join(ROOT, "dist")}${sep}`))
        return failure("Invalid asset path", 400);
      const file = Bun.file(asset);
      if (!(await file.exists())) return failure("Not found", 404);
      return new Response(file, {
        headers: {
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  });
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (connected && receivedAt !== null && now - receivedAt > 20000) {
      gap("Kraken heartbeat timed out");
      socket?.close();
    }
    if (recorder.active && now - recorder.startedAt >= recorder.maxDuration) {
      try {
        recorder.stop("Recording duration limit reached");
      } catch (cause) {
        recordingError = `Recording failed: ${cause.message}`;
      }
    }
  }, 5000);
  if (connect) openFeed();

  return {
    server,
    status,
    ingest,
    book,
    recorder,
    stop() {
      closed = true;
      clearTimeout(reconnectTimer);
      clearInterval(watchdog);
      try {
        socket?.close();
      } catch (cause) {
        error = cause.message;
      }
      try {
        recorder.stop("Server stopped");
      } catch (cause) {
        recordingError = `Recording failed: ${cause.message}`;
      } finally {
        server.stop(true);
      }
    },
  };
}

if (import.meta.main) {
  const desk = createDeskServer({
    port: Number(process.env.PORT || 5173),
    dataDir: process.env.DESK_DATA_DIR || join(ROOT, "data"),
  });
  console.log(`DESK local server: ${desk.server.url}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      desk.stop();
      process.exit(0);
    });
}
