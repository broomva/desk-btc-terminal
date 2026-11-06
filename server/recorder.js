import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  lstatSync,
  statfsSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const RECORDING_ID = /^[a-zA-Z0-9_-]{1,100}$/;

// Synchronous append keeps event order and applies disk backpressure. The file
// stays append-only; explicit session/end/gap events explain acquisition limits.
export class Recorder {
  constructor(
    directory,
    {
      maxBytes = 1024 * 1024 * 1024,
      maxDuration = 12 * 60 * 60 * 1000,
      maxEvents = 249000,
      maxDirectoryBytes = 2 * 1024 ** 3,
    } = {},
  ) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.maxDuration = maxDuration;
    this.maxEvents = maxEvents;
    this.maxDirectoryBytes = maxDirectoryBytes;
    this.defaults = { maxBytes, maxDuration, maxEvents };
    this.timer = null;
    this.capture = null;
    this.eventCount = 0;
    this.counts = {};
    this.clock = {
      observedMaxExchangeLeadMs: 0,
      observedMaxReceiptLagMs: 0,
      missingReceiveTimes: 0,
    };
    this.fd = null;
    this.id = null;
    this.bytes = 0;
    this.startedAt = null;
    this.lastBookAt = null;
    this.endReason = null;
    this.error = null;
  }

  get active() {
    return this.fd !== null;
  }

  storage() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let usedBytes = 0;
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".ndjson")) continue;
      const stat = lstatSync(join(this.directory, name));
      if (stat.isFile()) usedBytes += stat.size;
    }
    const disk = statfsSync(this.directory);
    return {
      usedBytes,
      quotaBytes: this.maxDirectoryBytes,
      freeDiskBytes: disk.bavail * disk.bsize,
    };
  }

  start(book = null, now = Date.now(), options = {}) {
    if (this.active) return this.id;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const planned = { ...this.defaults, ...options };
    const storage = this.storage();
    if (storage.usedBytes + planned.maxBytes > this.maxDirectoryBytes)
      throw new Error(
        "Recording storage quota cannot reserve this session; existing files were preserved.",
      );
    if (storage.freeDiskBytes < planned.maxBytes + 64 * 1024 * 1024)
      throw new Error(
        "Insufficient free disk space to reserve this session and 64 MiB headroom.",
      );
    this.error = null;
    this.maxBytes = planned.maxBytes;
    this.maxDuration = planned.maxDuration;
    this.maxEvents = planned.maxEvents;
    this.capture = structuredClone(options.experiment ?? null);
    this.eventCount = 0;
    this.counts = {};
    this.clock = {
      observedMaxExchangeLeadMs: 0,
      observedMaxReceiptLagMs: 0,
      missingReceiveTimes: 0,
    };
    this.id = `${new Date(now).toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
    this.fd = openSync(join(this.directory, `${this.id}.ndjson`), "ax", 0o600);
    this.bytes = 0;
    this.startedAt = now;
    this.lastBookAt = null;
    try {
      this.append({
        type: "session",
        experiment: this.capture,
        maxEvents: this.maxEvents,
        timestamp: now,
        id: this.id,
        schema: 1,
        source: "Kraken public BTC/USD",
        subscribedDepth: 500,
        recordedDepth: 300,
        bookSampleMs: 1000,
        observationSampleMs: 10000,
        observationPrice: "valid-book MID",
        observationImbalance: "top 25 levels per side",
        trades: "all received updates",
        maxBytes: this.maxBytes,
        maxDurationMs: this.maxDuration,
      });
      if (book?.valid)
        this.record({ type: "book", ...book, receiveTimestamp: now }, now);
      else
        this.append({
          type: "gap",
          timestamp: now,
          reason: "Recording started before a valid book snapshot",
          receiveTimestamp: now,
        });
    } catch (error) {
      const fd = this.fd;
      this.fd = null;
      try {
        closeSync(fd);
      } catch {
        /* preserve the original acquisition error */
      }
      throw error;
    }
    if (this.active) {
      this.endReason = null;
      this.timer = setTimeout(() => {
        try {
          this.stop("Recording duration limit reached");
        } catch (error) {
          this.error = `Recording failed: ${error.message}`;
          this.endReason = this.error;
        }
      }, this.maxDuration);
      this.timer.unref?.();
    }
    return this.id;
  }

  append(event) {
    if (!this.active) return;
    const line = `${JSON.stringify(event)}\n`;
    const buffer = Buffer.from(line);
    if (
      event.type !== "end" &&
      this.bytes + buffer.length + 1024 > this.maxBytes
    ) {
      if (event.type === "session")
        throw new Error("Recording byte limit cannot fit the session header.");
      this.stop(
        "Recording byte limit reached",
        event.receiveTimestamp ?? event.timestamp,
      );
      return;
    }
    if (event.type !== "end" && this.eventCount >= this.maxEvents - 1) {
      this.stop(
        "Recording event limit reached",
        event.receiveTimestamp ?? event.timestamp,
      );
      return;
    }
    let written = 0;
    while (written < buffer.length) {
      const size = writeSync(this.fd, buffer, written, buffer.length - written);
      if (!size) throw new Error("Recording write made no progress");
      written += size;
      this.bytes += size;
    }
    this.eventCount++;
    this.counts[event.type] = (this.counts[event.type] ?? 0) + 1;
  }

  record(event, now = Date.now()) {
    if (!this.active) return;
    if (
      this.bytes >= this.maxBytes ||
      now - this.startedAt >= this.maxDuration
    ) {
      this.stop(
        this.bytes >= this.maxBytes
          ? "Recording byte limit reached"
          : "Recording duration limit reached",
        now,
      );
      return;
    }
    if (event.type === "gap") this.lastBookAt = null;
    if (event.type === "book") {
      if (this.lastBookAt !== null && now - this.lastBookAt < 1000) return;
      this.lastBookAt = now;
    }
    if (["book", "trade"].includes(event.type)) {
      if (Number.isFinite(event.receiveTimestamp)) {
        this.clock.observedMaxExchangeLeadMs = Math.max(
          this.clock.observedMaxExchangeLeadMs,
          event.timestamp - event.receiveTimestamp,
        );
        this.clock.observedMaxReceiptLagMs = Math.max(
          this.clock.observedMaxReceiptLagMs,
          event.receiveTimestamp - event.timestamp,
        );
      } else this.clock.missingReceiveTimes++;
    }
    this.append(event);
  }

  stop(reason = "Stopped by user", now = Date.now()) {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.endReason = String(reason).slice(0, 200);
    try {
      const terminal = {
        type: "end",
        timestamp: now,
        reason: this.endReason,
        counts: Object.fromEntries(
          ["session", "book", "trade", "gap", "observation"].map((type) => [
            type,
            this.counts[type] ?? 0,
          ]),
        ),
        bytesBeforeEnd: this.bytes,
      };
      // JSON escaping (including lone surrogates) can expand a short reason.
      // Bound the actual UTF-8 terminal line, not its JavaScript string length.
      while (Buffer.byteLength(JSON.stringify(terminal)) + 1 > 1024)
        terminal.reason = terminal.reason.slice(0, -1);
      this.endReason = terminal.reason;
      this.append(terminal);
    } finally {
      const fd = this.fd;
      this.fd = null;
      closeSync(fd);
    }
  }

  info(file, size) {
    const fd = openSync(join(this.directory, file), "r");
    try {
      const first = Buffer.alloc(Math.min(size, 8192));
      readSync(fd, first, 0, first.length, 0);
      const last = Buffer.alloc(Math.min(size, 1024));
      readSync(fd, last, 0, last.length, Math.max(0, size - last.length));
      let header = null,
        end = null;
      try {
        header = JSON.parse(first.toString("utf8").split("\n")[0]);
      } catch {
        /* legacy or malformed metadata */
      }
      try {
        end = JSON.parse(last.toString("utf8").trim().split("\n").at(-1));
      } catch {
        /* interrupted capture */
      }
      return {
        purpose: header?.experiment?.purpose ?? "unassigned",
        complete: end?.type === "end",
        endReason: end?.type === "end" ? end.reason : "No end marker",
      };
    } finally {
      closeSync(fd);
    }
  }

  recordings() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    return readdirSync(this.directory)
      .filter(
        (file) =>
          file.endsWith(".ndjson") && RECORDING_ID.test(file.slice(0, -7)),
      )
      .map((file) => {
        const stat = statSync(join(this.directory, file));
        return {
          id: file.slice(0, -7),
          bytes: stat.size,
          modifiedAt: stat.mtimeMs,
          active: this.active && file === `${this.id}.ndjson`,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, 200)
      .map((row) => ({ ...row, ...this.info(`${row.id}.ndjson`, row.bytes) }));
  }
}
