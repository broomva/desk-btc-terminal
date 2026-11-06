import {
  experimentSummary,
  readExperiments,
  saveExperimentLocked,
} from "./experiment-results.js";
const $ = (id) => document.getElementById(id);
const value = (n, digits = 4) => (Number.isFinite(n) ? n.toFixed(digits) : "—");
export function createExperimentHistory() {
  let rows = [];
  function render() {
    $("history-count").textContent = `${rows.length} / 100 LOCAL RESULTS`;
    $("history-export").disabled = !rows.length;
    $("history-rows").replaceChildren();
    for (const item of rows) {
      const detail = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${new Date(item.start).toISOString()} · ${item.purpose.toUpperCase()} · ${item.mode} · ${item.inputSha256.slice(0, 10)}`;
      const quality = document.createElement("p");
      quality.className = "research-small";
      quality.textContent = `${item.sourceLabel} · ${((item.end - item.start) / 60000).toFixed(1)} min · ${item.eventCount} events · ${item.endReason} · ${item.issues.join(" · ")}`;
      const scroll = document.createElement("div");
      scroll.className = "paper-table-scroll";
      const table = document.createElement("table");
      const caption = document.createElement("caption");
      caption.className = "sr-only";
      caption.textContent = `Simulated policy outcomes for ${item.inputSha256.slice(0, 10)}`;
      table.append(caption);
      const header = document.createElement("tr");
      for (const label of [
        "POLICY",
        "NET P&L / USD",
        "EXCESS VS HOLD / USD",
        "FEES / USD",
        "FILLS",
        "INVENTORY / BTC",
        "MAX EXPOSURE / USD",
        "DRAWDOWN / USD",
        "60s MARKOUT / BPS",
      ]) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = label;
        header.append(th);
      }
      table.append(header);
      for (const policy of item.policies) {
        const m = policy.metrics;
        const tr = document.createElement("tr");
        for (const text of [
          policy.label,
          value(m.pnl),
          value(m.excessOverHold),
          value(m.fees),
          m.fillCount,
          value(m.finalInventory, 6),
          value(m.maxExposureUsd),
          value(m.maxDrawdown),
          `${value(m.markouts["60s"].meanBps, 3)} · n=${m.markouts["60s"].count} / pending=${m.markouts["60s"].unresolved}`,
        ]) {
          const td = document.createElement("td");
          td.textContent = text;
          tr.append(td);
        }
        table.append(tr);
      }
      scroll.append(table);
      const config = document.createElement("pre");
      config.textContent = JSON.stringify(
        {
          engineVersion: item.engineVersion,
          assumedConfig: item.config,
          timing: item.timing,
          valuation: item.valuation,
        },
        null,
        2,
      );
      const configDetails = document.createElement("details"),
        label = document.createElement("summary");
      label.textContent = "ASSUMPTIONS / DATA QUALITY";
      configDetails.append(label, config);
      detail.append(summary, quality, scroll, configDetails);
      $("history-rows").append(detail);
    }
    if (!rows.length)
      $("history-status").textContent =
        "Run a paper comparison to save its summary here. No real-market results yet.";
  }
  function load() {
    try {
      rows = readExperiments(localStorage);
      render();
    } catch (error) {
      $("history-status").textContent = `History unavailable: ${error.message}`;
    }
  }
  async function add(receipt) {
    try {
      rows = await saveExperimentLocked(
        experimentSummary(receipt),
        localStorage,
        navigator.locks,
      );
      render();
      $("history-status").textContent =
        "Summary retained in this browser. Download the full paper receipt separately for exact reproduction. Self-declared evaluation is descriptive, not proof of untouched data or skill.";
    } catch (error) {
      $("history-status").textContent =
        `Result computed, but summary was not saved: ${error.message}. Export the full paper receipt now.`;
    }
  }
  $("history-export").addEventListener("click", () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              version: 1,
              type: "DESK SUMMARY ARCHIVE / NOT FULL REPLAY RECEIPTS",
              results: rows,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "desk-experiment-summaries.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "desk-paper-history-v1") load();
  });
  load();
  return { add };
}
