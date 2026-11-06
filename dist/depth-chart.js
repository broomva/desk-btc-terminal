const font = '"IBM Plex Mono", ui-monospace, monospace';
const usd = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const MINUTE = 60000;
export const PAST_MINUTES = 15;

function percentile(sorted, p) {
  if (!sorted.length) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function niceStep(span, target) {
  const raw = span / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * power >= raw) return m * power;
  return 10 * power;
}

// Flat chart geometry: time runs left to right on one scale (past and future
// share minutes-per-pixel) and price runs bottom to top on one scale shared by
// depth, observed price and simulated paths. Neither axis depends on the other.
export function layout({
  width,
  height,
  timestamp,
  horizonMinutes = 15,
  prices = [],
  reference,
}) {
  const mobile = width < 650;
  const left = mobile ? 12 : 28;
  const xEnd = width - (mobile ? 76 : 124);
  const top = mobile ? 192 : 150;
  const bottom = height - (mobile ? 70 : 62);
  const span = (PAST_MINUTES + horizonMinutes) * MINUTE;
  const start = timestamp - PAST_MINUTES * MINUTE;
  const x = (at) => left + ((at - start) / span) * (xEnd - left);
  let lo = reference;
  let hi = reference;
  for (const price of prices)
    if (Number.isFinite(price)) {
      lo = Math.min(lo, price);
      hi = Math.max(hi, price);
    }
  const mid = (lo + hi) / 2;
  const half = Math.max(30, ((hi - lo) / 2) * 1.18);
  lo = mid - half;
  hi = mid + half;
  const y = (price) => bottom - ((price - lo) / (hi - lo)) * (bottom - top);
  return {
    mobile,
    left,
    xEnd,
    xNow: x(timestamp),
    top,
    bottom,
    start,
    lo,
    hi,
    x,
    y,
    pxPerDollar: (bottom - top) / (hi - lo),
  };
}

export function createDepthChart(canvas, getState) {
  const ctx = canvas.getContext("2d");
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0,
    height = 0,
    frame = 0,
    phase = 0,
    last = 0;
  let visible = true,
    motion = true;
  const heat = document.createElement("canvas");
  const heatCtx = heat.getContext("2d");
  let heatKey = "";

  function drawHeat(frames, g, quiet, dpr) {
    const key = [
      frames.length,
      frames[0]?.timestamp,
      frames.at(-1)?.timestamp,
      g.lo.toFixed(2),
      g.hi.toFixed(2),
      g.start,
      width,
      height,
      quiet,
    ].join("|");
    if (key !== heatKey) {
      heatKey = key;
      heat.width = canvas.width;
      heat.height = canvas.height;
      heatCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      heatCtx.clearRect(0, 0, width, height);
      const rowPx = 3;
      const rows = Math.ceil((g.bottom - g.top) / rowPx);
      const bin = (price) =>
        Math.min(rows - 1, Math.floor((g.bottom - g.y(price)) / rowPx));
      const grids = frames.map((book) => {
        const ask = new Float32Array(rows);
        const bid = new Float32Array(rows);
        for (const [price, qty] of book.asks)
          if (price >= g.lo && price <= g.hi) ask[bin(price)] += qty;
        for (const [price, qty] of book.bids)
          if (price >= g.lo && price <= g.hi) bid[bin(price)] += qty;
        return { ask, bid };
      });
      const cells = [];
      for (const { ask, bid } of grids)
        for (const values of [ask, bid])
          for (const v of values) if (v > 0) cells.push(v);
      cells.sort((a, b) => a - b);
      const cap = percentile(cells, 0.97) || 1;
      for (let fi = 0; fi < frames.length; fi++) {
        const xNext =
          fi + 1 < frames.length ? g.x(frames[fi + 1].timestamp) : g.xNow;
        const x0 = Math.max(
          g.left,
          Math.min(g.x(frames[fi].timestamp), xNext - 3),
        );
        const w = Math.max(3, xNext - x0) + 0.5;
        const recency = 0.45 + 0.55 * ((fi + 1) / frames.length);
        const alpha = (quiet ? 0.28 : 0.9) * recency;
        for (const [side, hue] of [
          ["ask", 358],
          ["bid", 207],
        ]) {
          const values = grids[fi][side];
          for (let r = 0; r < rows; r++) {
            if (!values[r]) continue;
            const level = Math.sqrt(Math.min(1, values[r] / cap));
            heatCtx.fillStyle = `hsla(${hue},80%,${34 + 26 * level}%,${(0.15 + 0.85 * level) * alpha})`;
            heatCtx.fillRect(x0, g.bottom - (r + 1) * rowPx, w, rowPx - 0.5);
          }
        }
      }
    }
    ctx.drawImage(heat, 0, 0, width, height);
  }

  function draw(now = performance.now()) {
    const state = getState();
    if (!visible || !width || !height) return;
    const animate =
      motion && !media.matches && !state.paused && !document.hidden;
    canvas.dataset.motion = animate
      ? "running"
      : media.matches
        ? "reduced"
        : "paused";
    if (animate) phase += Math.min(0.08, Math.max(0, (now - last) / 1000));
    last = now;
    ctx.clearRect(0, 0, width, height);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const forecast = state.forecast?.paths?.length ? state.forecast : null;
    const horizonMinutes = forecast?.horizonMinutes ?? 15;
    const timestamp =
      forecast?.timestamp ??
      state.history.at(-1)?.timestamp ??
      state.book?.timestamp ??
      Date.now();
    const ref = state.price || state.history.at(-1)?.price || 77800;
    const windowStart = timestamp - PAST_MINUTES * MINUTE;
    const history = (state.history ?? []).filter(
      (row) => row.timestamp >= windowStart && row.timestamp <= timestamp,
    );
    const book = state.book?.valid ? state.book : null;
    // Paths start at their origin; shift them so they leave the NOW dot.
    const shift = forecast ? ref - forecast.reference : 0;
    const stride = forecast
      ? Math.max(1, Math.ceil(forecast.paths.length / 180))
      : 1;
    const pathValues = [];
    if (forecast)
      for (let i = 0; i < forecast.paths.length; i += stride)
        for (const v of forecast.paths[i]) pathValues.push(v + shift);
    pathValues.sort((a, b) => a - b);
    const g = layout({
      width,
      height,
      timestamp,
      horizonMinutes,
      reference: ref,
      prices: [
        ...history.map((row) => row.price),
        percentile(pathValues, 0.01),
        percentile(pathValues, 0.99),
        book?.bids?.[0]?.[0],
        book?.asks?.[0]?.[0],
      ],
    });
    canvas.dataset.windowStart = String(windowStart);
    canvas.dataset.windowEnd = String(timestamp);
    canvas.dataset.priceScale = String(g.pxPerDollar);
    const quiet = state.view === "futures";
    const labelSize = g.mobile ? 10 : 11;
    ctx.save();
    ctx.font = `${labelSize}px ${font}`;

    // Future region tint and grid.
    ctx.fillStyle = "#fff4d606";
    ctx.fillRect(g.xNow, g.top, g.xEnd - g.xNow, g.bottom - g.top);
    const step = niceStep(g.hi - g.lo, g.mobile ? 4 : 6);
    ctx.textAlign = "right";
    for (let p = Math.ceil(g.lo / step) * step; p <= g.hi; p += step) {
      const py = g.y(p);
      ctx.strokeStyle = "#20312f80";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(g.left, py);
      ctx.lineTo(g.xEnd, py);
      ctx.stroke();
      ctx.fillStyle = "#8a9d89";
      ctx.fillText(usd(p), width - 8, py + 4);
    }
    ctx.textAlign = "center";
    for (let m = -PAST_MINUTES; m <= horizonMinutes; m += g.mobile ? 10 : 5) {
      const px = g.x(timestamp + m * MINUTE);
      ctx.strokeStyle = m === 0 ? "#a1c8b660" : "#20312f70";
      ctx.lineWidth = m === 0 ? 1 : 0.6;
      ctx.setLineDash(m === 0 ? [3, 4] : []);
      ctx.beginPath();
      ctx.moveTo(px, g.top);
      ctx.lineTo(px, g.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m === 0 ? "#e6efda" : "#8a9d89";
      ctx.fillText(
        m === 0 ? "NOW" : `${m > 0 ? "+" : "−"}${Math.abs(m)}m`,
        px,
        g.bottom + 20,
      );
    }
    ctx.textAlign = "left";
    ctx.fillStyle = "#8a9d89";
    ctx.fillText(
      g.mobile ? "OBSERVED" : "OBSERVED · ORDER BOOK + PRICE",
      g.left + 6,
      g.top + 16,
    );
    ctx.fillText(
      forecast
        ? g.mobile
          ? "SIMULATED"
          : `SIMULATED · ${horizonMinutes} MIN`
        : g.mobile
          ? "NO FORECAST"
          : "NO FORECAST AT THIS VIEW TIME",
      g.xNow + 10,
      g.top + 16,
    );

    // Depth heat: one column per recorded book, rows by price.
    const frames = (state.depthFrames ?? []).filter(
      (b) => b.timestamp >= windowStart && b.timestamp <= timestamp,
    );
    if (book && frames.length) drawHeat(frames, g, quiet, dpr);
    const seen = history.length ? timestamp - history[0].timestamp : 0;
    if (seen < 2 * MINUTE) {
      const mm = Math.floor(seen / MINUTE);
      const ss = String(Math.floor((seen % MINUTE) / 1000)).padStart(2, "0");
      ctx.textAlign = "center";
      ctx.fillStyle = "#8a9d89";
      ctx.fillText(
        `History fills while the feed runs · ${mm}:${ss} of 15:00`,
        (g.left + g.xNow) / 2,
        (g.top + g.bottom) / 2,
      );
      ctx.textAlign = "left";
    }

    // Observed price on the same axes.
    if (history.length) {
      ctx.strokeStyle = "#f3f7ee";
      ctx.lineWidth = 2;
      ctx.shadowColor = "#c8e7d9";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      history.forEach((row, i) => {
        const px = g.x(row.timestamp);
        const py = g.y(row.price);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.lineTo(g.xNow, g.y(ref));
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Reference line from NOW, so "above / below origin" is readable.
    ctx.strokeStyle = "#e6efda40";
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(g.xNow, g.y(ref));
    ctx.lineTo(g.xEnd, g.y(ref));
    ctx.stroke();
    ctx.setLineDash([]);

    if (forecast) {
      // Paths outside the visible price band are clipped, never rescaled.
      ctx.save();
      ctx.beginPath();
      ctx.rect(g.xNow, g.top, g.xEnd - g.xNow, g.bottom - g.top);
      ctx.clip();
      const fanAlpha = quiet ? 1 : 0.55;
      const xAt = (j, n) => g.xNow + (j / (n - 1)) * (g.xEnd - g.xNow);
      for (let i = 0; i < forecast.paths.length; i += stride) {
        const path = forecast.paths[i];
        ctx.strokeStyle =
          i % 4 === 0
            ? `rgba(246,226,190,${0.33 * fanAlpha})`
            : `rgba(220,245,236,${0.15 * fanAlpha})`;
        ctx.lineWidth = 0.65;
        ctx.beginPath();
        path.forEach((price, j) => {
          const px = xAt(j, path.length);
          const py = g.y(price + shift);
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      if (forecast.quantiles?.median) {
        ctx.strokeStyle = "#ffe4a4";
        ctx.lineWidth = 1.7;
        ctx.beginPath();
        forecast.quantiles.median.forEach((p, j, a) => {
          const px = xAt(j, a.length);
          const py = g.y(p + shift);
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      ctx.restore();
      // Where the paths end, as a sideways histogram at the horizon.
      const ends = forecast.paths.map((p) => p.at(-1) + shift);
      const bins = 40;
      const counts = Array(bins).fill(0);
      for (const v of ends) {
        if (v < g.lo || v > g.hi) continue;
        counts[
          Math.min(bins - 1, Math.floor(((v - g.lo) / (g.hi - g.lo)) * bins))
        ]++;
      }
      const max = Math.max(...counts, 1);
      const ridge = g.mobile ? 26 : 46;
      const rowH = (g.bottom - g.top) / bins;
      for (let i = 0; i < bins; i++) {
        if (!counts[i]) continue;
        const gradient = ctx.createLinearGradient(g.xEnd, 0, g.xEnd + ridge, 0);
        gradient.addColorStop(0, "#fff1becc");
        gradient.addColorStop(1, "#fd684a22");
        ctx.fillStyle = gradient;
        ctx.fillRect(
          g.xEnd + 2,
          g.bottom - (i + 1) * rowH + 0.5,
          (counts[i] / max) * ridge,
          Math.max(1, rowH - 1),
        );
      }
    }

    // NOW marker.
    const nowY = g.y(ref);
    ctx.fillStyle = "#edf6df";
    ctx.beginPath();
    ctx.arc(g.xNow, nowY, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(220,245,222,${0.5 + Math.sin(phase * 1.5) * 0.15})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(
      g.xNow,
      nowY,
      7 + (animate ? Math.sin(phase * 1.5) : 0),
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.restore();
    if (animate && !frame) frame = requestAnimationFrame(tick);
  }
  function tick(now) {
    frame = 0;
    if (now - last < 48) {
      frame = requestAnimationFrame(tick);
      return;
    }
    draw(now);
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  const observer = new ResizeObserver(([entry]) => {
    width = entry.contentRect.width;
    height = entry.contentRect.height;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    heatKey = "";
    draw();
  });
  observer.observe(canvas);
  const refresh = () => {
    stop();
    draw();
  };
  media.addEventListener("change", refresh);
  document.addEventListener("visibilitychange", refresh);
  return {
    draw: refresh,
    setVisible(value) {
      visible = value;
      refresh();
    },
    setMotion(value) {
      motion = value;
      refresh();
    },
  };
}
