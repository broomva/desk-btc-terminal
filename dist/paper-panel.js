import { createExperimentHistory } from "./experiment-history.js";
import { paperFixture } from "./paper-fixture.js";
const $ = (id) => document.getElementById(id);
const money = (v) =>
  Number.isFinite(v)
    ? v.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 4,
      })
    : "—";
const num = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : "—");

export function createPaperPanel(getContext) {
  const history = createExperimentHistory();
  let worker,
    receipt,
    epoch = 0;
  const message = (text) => {
    $("paper-status").textContent = text;
  };
  function clear() {
    epoch++;
    worker?.terminate();
    worker = null;
    receipt = null;
    $("paper-run").disabled = false;
    $("paper-export").disabled = true;
    $("paper-results").hidden = true;
    message(
      "Run a frozen comparison on a raw recording. Demo uses a separate synthetic execution fixture.",
    );
  }
  function row(values, head = false) {
    const tr = document.createElement("tr");
    for (const value of values) {
      const td = document.createElement(head ? "th" : "td");
      td.textContent = value;
      if (head) td.scope = "col";
      tr.append(td);
    }
    return tr;
  }
  function render(result) {
    $("paper-results").hidden = false;
    $("paper-export").disabled = false;
    const policies = result.policies;
    $("paper-summary").replaceChildren(
      row(
        [
          "POLICY",
          "NET P&L / USD",
          "FEES / USD",
          "FILLS",
          "QUOTED / DECISIONS",
          "INVENTORY / BTC",
          "DRAWDOWN / USD",
        ],
        true,
      ),
      ...policies.map((p) =>
        row([
          p.label || p.id,
          money(p.metrics.pnl),
          money(p.metrics.fees),
          p.metrics.fillCount,
          `${p.metrics.quotedDecisions} / ${p.metrics.decisionCount}`,
          num(p.metrics.finalInventory, 6),
          money(p.metrics.maxDrawdown),
        ]),
      ),
    );
    $("paper-marks").replaceChildren(
      row(
        [
          "POLICY",
          "1s MARKOUT / BPS",
          "10s / BPS",
          "60s / BPS",
          "EXCESS VS HOLD / USD",
        ],
        true,
      ),
      ...policies.map((p) =>
        row([
          p.label || p.id,
          ...["1s", "10s", "60s"].map((h) => {
            const m = p.metrics.markouts?.[h];
            return `${num(m?.meanBps)} · n=${m?.count ?? 0} / pending=${m?.unresolved ?? 0}`;
          }),
          money(p.metrics.excessOverHold),
        ]),
      ),
    );
    $("paper-fills").replaceChildren(
      row(
        [
          "POLICY / LAST 20 FILLS",
          "TIME UTC",
          "SIDE",
          "PRICE",
          "BTC",
          "FEE USD",
        ],
        true,
      ),
      ...policies.flatMap((p) =>
        p.fills
          .slice(-20)
          .map((f) =>
            row([
              p.id,
              new Date(f.timestamp).toISOString().slice(11, 23),
              f.side.toUpperCase(),
              money(f.price),
              num(f.qty, 6),
              money(f.fee),
            ]),
          ),
      ),
    );
    $("paper-assumptions").textContent = JSON.stringify(result.config, null, 2);
    $("paper-limitations").textContent = Array.isArray(result.limitations)
      ? result.limitations.join(" · ")
      : String(
          result.limitations ||
            "Queue position and market impact are not modeled.",
        );
    message(
      `${receipt.sourceLabel} · ${new Date(result.start).toISOString()} → ${new Date(result.end).toISOString()} · Valuation ${result.valuation?.fresh ? "fresh" : "STALE"} (${num((result.valuation?.ageMs ?? 0) / 1000, 1)}s packet age / ${num((result.valuation?.worstCaseAgeMs ?? 0) / 1000, 1)}s worst case). Fixed policies in this run / no parameter search. INSUFFICIENT EVIDENCE OF SKILL. Re-running consumes this history. ${result.timing?.missingReceiveTimes ?? 0} events use exchange-time fallback. Clock bound ±${result.config.maxClockSkewMs}ms / observed exchange lead ${result.timing?.observedMaxExchangeLeadMs ?? 0}ms.`,
    );
    draw(result);
  }
  function draw(result) {
    const canvas = $("paper-equity");
    const width = Math.max(280, canvas.clientWidth),
      height = 230;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const series = result.policies.map((p) =>
      p.equity.map((e) => ({
        timestamp: e.timestamp,
        value: e.pnl ?? e.equity - p.equity[0].equity,
      })),
    );
    const all = series.flat();
    let lo = 0,
      hi = 0;
    for (const point of all) {
      lo = Math.min(lo, point.value);
      hi = Math.max(hi, point.value);
    }
    const pad = Math.max(0.001, (hi - lo) * 0.15),
      low = lo - pad,
      high = hi + pad;
    const x = (t) =>
      68 +
      ((t - result.start) / Math.max(1, result.end - result.start)) *
        (width - 86);
    const y = (v) => 20 + ((high - v) / (high - low)) * 176;
    ctx.font = "10px monospace";
    for (const value of [lo, (lo + hi) / 2, hi]) {
      ctx.strokeStyle = "#29362b";
      ctx.beginPath();
      ctx.moveTo(68, y(value));
      ctx.lineTo(width - 18, y(value));
      ctx.stroke();
      ctx.fillStyle = "#9aac98";
      ctx.fillText(`$${value.toFixed(3)}`, 2, y(value) + 3);
    }
    const colors = ["#d9eda7", "#71b9da"];
    series.forEach((points, i) => {
      ctx.strokeStyle = colors[i];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      points.forEach((p, j) => {
        if (j) ctx.lineTo(x(p.timestamp), y(p.value));
        else ctx.moveTo(x(p.timestamp), y(p.value));
      });
      ctx.stroke();
    });
    ctx.fillStyle = "#9aac98";
    ctx.fillText("START", 68, 220);
    ctx.fillText("END", width - 40, 220);
  }
  $("paper-run").addEventListener("click", async () => {
    clear();
    const id = epoch;
    const context = getContext();
    try {
      if (context.source === "live")
        throw new Error(
          "Record a raw session, stop recording, then load it in Local / Replay. The live display is sampled and cannot establish fills.",
        );
      const recording =
        context.source === "demo" ? paperFixture() : context.recording;
      if (!recording) throw new Error("Load a raw NDJSON recording first.");
      if (recording.metadata?.replaySampling)
        throw new Error(
          "Compact replay drops trades. Load Full events / paper lab or import the raw download.",
        );
      const acquisitionEnd = recording.events.reduce(
        (last, event) =>
          Math.max(last, event.receiveTimestamp ?? event.timestamp),
        recording.metadata?.endedAt ?? 0,
      );
      const end =
        context.source === "demo"
          ? recording.end
          : Math.min(context.cursor, acquisitionEnd);
      const input = {
        ...recording,
        metadata: {
          ...recording.metadata,
          recordingEndedAt: recording.metadata?.endedAt ?? null,
          endedAt: end,
        },
        events: recording.events.filter(
          (e) => (e.receiveTimestamp ?? e.timestamp) <= end,
        ),
        end,
      };
      if (!input.events.some((e) => e.type === "book"))
        throw new Error("No book at this replay time.");
      // The normalized events and configuration are exported for exact reruns.
      for (const name of ["paper-fee", "paper-spread"]) {
        if (!$(name).value.trim() || !$(name).checkValidity())
          throw new Error(
            "Enter a valid fee and spread assumption; blank fields are not zero fees.",
          );
      }
      if (!crypto.subtle)
        throw new Error(
          "Open DESK on localhost or 127.0.0.1 to hash paper receipts.",
        );
      const config = {
        ...(recording.metadata?.experiment?.paperConfig ?? {}),
        makerFeeBps: Number($("paper-fee").value),
        halfSpreadBps: Number($("paper-spread").value),
      };
      const inputJson = JSON.stringify({
        metadata: input.metadata,
        events: input.events,
      });
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(inputJson),
          ),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      if (id !== epoch) return;
      receipt = {
        input: { metadata: input.metadata, events: input.events },
        inputSha256: hash,
        sourceLabel:
          context.source === "demo"
            ? "SYNTHETIC PAPER FIXTURE"
            : `IMPORTED / SELF-DECLARED: ${input.metadata?.source || "UNKNOWN SOURCE"}`,
        result: null,
      };
      $("paper-run").disabled = true;
      message("Replaying identical events through two frozen policies…");
      worker = new Worker(new URL("./paper-worker.js", import.meta.url), {
        type: "module",
      });
      worker.onmessage = ({ data }) => {
        if (id !== epoch) return;
        worker?.terminate();
        worker = null;
        $("paper-run").disabled = false;
        if (data.error) {
          message(data.error);
          receipt = null;
          return;
        }
        receipt.result = data.result;
        render(data.result);
        history.add(receipt);
      };
      worker.onerror = (event) => {
        if (id === epoch) {
          worker?.terminate();
          worker = null;
          receipt = null;
          $("paper-run").disabled = false;
          message(`Paper evaluator failed: ${event.message}`);
        }
      };
      worker.postMessage({ recording: input, config });
    } catch (error) {
      if (id === epoch) {
        receipt = null;
        $("paper-run").disabled = false;
        message(error.message);
      }
    }
  });
  $("paper-export").addEventListener("click", () => {
    if (!receipt?.result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(receipt)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `desk-paper-${receipt.inputSha256.slice(0, 12)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  for (const id of ["paper-fee", "paper-spread"])
    $(id).addEventListener("input", clear);
  window.addEventListener("resize", () => {
    if (receipt?.result) draw(receipt.result);
  });
  window.addEventListener("beforeunload", () => worker?.terminate());
  clear();
  function useCaptureConfig(recording) {
    const config = recording.metadata?.experiment?.paperConfig;
    if (config) {
      $("paper-fee").value = config.makerFeeBps;
      $("paper-spread").value = config.halfSpreadBps;
    }
  }
  return { clear, useCaptureConfig };
}
