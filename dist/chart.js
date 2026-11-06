import { clamp } from "./engine.js";
import { sampleProjection } from "./projections.js";

const C = {
  teal: "#4ce6d0",
  pink: "#f0749b",
  gold: "#f5d991",
  grid: "#173a3d",
  text: "#a0b6bd",
  white: "#def8f4",
};
const number = (value) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function createChart(canvas, getState, onSnapshot) {
  const ctx = canvas.getContext("2d");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0,
    height = 0,
    frame = 0,
    enabled = true;
  let snapshot = null,
    previous = null,
    snapshotKey = "",
    snapshotAt = 0;
  let phase = 0,
    lastFrame = 0,
    pointer = null;
  let smoothPrice = null;
  let introAt = null;

  function isAnimated() {
    const s = getState();
    return (
      enabled &&
      !reducedMotion.matches &&
      !s.paused &&
      !s.visualStale &&
      !document.hidden
    );
  }

  function refresh(now) {
    const s = getState();
    const key = `${s.mode}:${s.windowId}:${s.liveWindow}:${Math.floor(s.elapsed / 5)}:${s.paths}:${s.volatility}`;
    if (key === snapshotKey || s.lastTick === null) return;
    if (!snapshot) introAt = now;
    previous = snapshot;
    snapshotKey = key;
    snapshotAt = now;
    snapshot = sampleProjection(
      s.paths,
      Math.max(1, 300 - s.elapsed),
      s.volatility,
      712 + Math.floor(s.elapsed / 5),
    );
    onSnapshot(snapshot);
  }

  function draw(now = performance.now()) {
    if (!width || !height) return;
    const s = getState();
    const animated = isAnimated();
    canvas.dataset.motion = animated
      ? "running"
      : reducedMotion.matches
        ? "reduced"
        : "paused";
    const delta = Math.min((now - lastFrame) / 1000, 0.06);
    lastFrame = now;
    if (animated) phase += Math.max(0, delta);
    refresh(now);
    const mobile = width < 900;
    const x0 = mobile ? 18 : 32;
    const xNow = width * (mobile ? 0.45 : 0.51);
    const xEnd = width - (mobile ? 76 : 138);
    const top = mobile ? 270 : 140;
    const bottom = height - 62;
    const mid = top + (bottom - top) * 0.54;
    const span = Math.max(
      75,
      3.8 * s.volatility * Math.sqrt(Math.max(1, 300 - s.elapsed)) * 2.3,
    );
    const scale = (bottom - top) / (span * 2);
    const y = (price) => mid - (price - s.reference) * scale;
    smoothPrice =
      smoothPrice === null || !animated || Math.abs(smoothPrice - s.price) > 500
        ? s.price
        : smoothPrice + (s.price - smoothPrice) * 0.18;
    const anchorY = y(smoothPrice);
    const blend = animated ? clamp((now - snapshotAt) / 650, 0, 1) : 1;
    const mix = (value, oldValue) =>
      oldValue === undefined ? value : oldValue + (value - oldValue) * blend;
    ctx.clearRect(0, 0, width, height);

    // The floor recedes to the current tick, like the reference's chart stage.
    const floorTop = height * 0.36;
    ctx.lineWidth = 0.65;
    for (let i = 0; i < 12; i++) {
      const gridY = floorTop + (bottom - floorTop) * (i / 11) ** 1.8;
      ctx.strokeStyle = i % 3 === 0 ? "#19454965" : "#173a3d40";
      ctx.beginPath();
      ctx.moveTo(x0, gridY);
      ctx.lineTo(width - 20, gridY);
      ctx.stroke();
    }
    for (let i = -5; i <= 13; i++) {
      ctx.strokeStyle = "#173a3d50";
      ctx.beginPath();
      ctx.moveTo(width * 0.55 + i * 12, floorTop);
      ctx.lineTo((i * width) / 9, bottom);
      ctx.stroke();
    }
    for (let i = 0; i <= 4; i++) {
      const py = top + ((bottom - top) * i) / 4;
      ctx.strokeStyle = "#173a3d70";
      ctx.beginPath();
      ctx.moveTo(x0, py);
      ctx.lineTo(width - 20, py);
      ctx.stroke();
      if (!mobile) {
        ctx.font = '9px "IBM Plex Mono", monospace';
        ctx.fillStyle = "#77989e";
        ctx.textAlign = "right";
        ctx.fillText(
          number(s.reference + (mid - py) / scale),
          width - 14,
          py - 7,
        );
      }
    }
    if (s.lastTick === null || !snapshot) {
      ctx.font = '11px "IBM Plex Mono", monospace';
      ctx.fillStyle = C.text;
      ctx.textAlign = "center";
      ctx.fillText("WAITING FOR FIRST SPOT TICK", width / 2, mid);
      schedule();
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, top - 26, width - x0 - 10, bottom - top + 30);
    ctx.clip();
    // A translucent plane marks the boundary between observed and simulated.
    const plane = ctx.createLinearGradient(xNow - 24, 0, xNow + 24, 0);
    plane.addColorStop(0, "#4ce6d000");
    plane.addColorStop(0.5, "#4ce6d022");
    plane.addColorStop(1, "#4ce6d000");
    ctx.fillStyle = plane;
    ctx.fillRect(xNow - 24, top - 10, 48, bottom - top + 10);
    ctx.strokeStyle = "#4ce6d059";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xNow + 10, top - 14);
    ctx.lineTo(xNow - 12, top + 7);
    ctx.lineTo(xNow - 12, bottom - 16);
    ctx.lineTo(xNow + 10, bottom + 5);
    ctx.lineTo(xNow + 10, top - 14);
    ctx.stroke();
    for (let line = 0; line < 24; line++) {
      const py = top + (bottom - top) * ((line / 24 + phase * 0.018) % 1);
      ctx.strokeStyle = "#4ce6d019";
      ctx.beginPath();
      ctx.moveTo(xNow - 11, py);
      ctx.lineTo(xNow + 9, py - 7);
      ctx.stroke();
    }

    // Tick-derived candles: the chart does not invent exchange OHLC history.
    const history = s.history;
    const groupSize = Math.max(
      1,
      Math.ceil(history.length / (mobile ? 20 : 30)),
    );
    for (let i = 0; i < history.length; i += groupSize) {
      const group = history.slice(i, i + groupSize);
      const open = group[0].price;
      const close =
        i + groupSize >= history.length ? smoothPrice : group.at(-1).price;
      const high = Math.max(open, close, ...group.map((p) => p.price));
      const low = Math.min(open, close, ...group.map((p) => p.price));
      const x =
        x0 + ((xNow - x0 - 12) * group.at(-1).t) / Math.max(1, s.elapsed);
      const candleWidth = clamp(
        ((xNow - x0) / Math.max(1, history.length / groupSize)) * 0.58,
        2,
        10,
      );
      ctx.strokeStyle = ctx.fillStyle = close >= open ? C.teal : C.pink;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y(high));
      ctx.lineTo(x, y(low));
      ctx.stroke();
      ctx.fillRect(
        x - candleWidth / 2,
        Math.min(y(open), y(close)),
        candleWidth,
        Math.max(2, Math.abs(y(open) - y(close))),
      );
    }
    ctx.globalAlpha = 1;

    const projectedY = (offset) => y(smoothPrice + offset);
    const trace = (values, oldValues, stroke, lineWidth, glow = 0) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.shadowColor = stroke;
      ctx.shadowBlur = glow;
      ctx.beginPath();
      values.forEach((value, i) => {
        const x = xNow + ((xEnd - xNow) * i) / (values.length - 1);
        const py = projectedY(mix(value, oldValues?.[i]));
        if (i === 0) ctx.moveTo(x, py);
        else ctx.lineTo(x, py);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    const introProgress = animated ? clamp((now - introAt) / 1600, 0, 1) : 1;
    const reveal = 1 - (1 - introProgress) ** 4;
    ctx.save();
    ctx.beginPath();
    ctx.rect(xNow - 1, top - 26, (xEnd - xNow) * reveal + 2, bottom - top + 30);
    ctx.clip();
    // Quantile-shaped fan, explicitly labeled as simulated in the interface.
    ctx.beginPath();
    snapshot.p90.forEach((value, i) => {
      const x = xNow + ((xEnd - xNow) * i) / 32;
      if (i === 0) ctx.moveTo(x, projectedY(value));
      else ctx.lineTo(x, projectedY(value));
    });
    for (let i = 32; i >= 0; i--)
      ctx.lineTo(xNow + ((xEnd - xNow) * i) / 32, projectedY(snapshot.p10[i]));
    ctx.closePath();
    const fill = ctx.createLinearGradient(xNow, 0, xEnd, 0);
    fill.addColorStop(0, "#4ce6d003");
    fill.addColorStop(1, "#4ce6d00e");
    ctx.fillStyle = fill;
    ctx.fill();
    for (let i = 0; i < snapshot.paths.length; i++) {
      const path = snapshot.paths[i];
      trace(
        path,
        previous?.paths[i],
        path.at(-1) >= 0 ? "#4ce6d037" : "#f0749b2a",
        0.65,
      );
    }
    trace(snapshot.p90, previous?.p90, "#4ce6d0a0", 1);
    trace(snapshot.p10, previous?.p10, "#f0749b99", 1);
    trace(snapshot.median, previous?.median, C.gold, mobile ? 1.6 : 2, 10);

    // A small moving tracer makes sampling motion legible without moving labels.
    if (animated) {
      const position = (phase * 0.2) % 1;
      const step = Math.floor(position * 32);
      const fraction = position * 32 - step;
      const offset =
        snapshot.median[step] +
        (snapshot.median[Math.min(32, step + 1)] - snapshot.median[step]) *
          fraction;
      ctx.fillStyle = "#fff1c6";
      ctx.shadowColor = C.gold;
      ctx.shadowBlur = 9;
      ctx.beginPath();
      ctx.arc(
        xNow + (xEnd - xNow) * position,
        projectedY(offset),
        2,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = "#4ce6d052";
    ctx.beginPath();
    ctx.moveTo(x0, anchorY);
    ctx.lineTo(xEnd, anchorY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Orbiting inference node. Frozen for pause, reduced motion, and stale feeds.
    const halo = ctx.createRadialGradient(
      xNow,
      anchorY,
      0,
      xNow,
      anchorY,
      mobile ? 43 : 70,
    );
    halo.addColorStop(0, "#4ce6d052");
    halo.addColorStop(0.35, "#4ce6d019");
    halo.addColorStop(1, "#4ce6d000");
    ctx.fillStyle = halo;
    ctx.fillRect(xNow - 70, anchorY - 70, 140, 140);
    ctx.strokeStyle = "#4ce6d08a";
    ctx.lineWidth = 0.8;
    for (let orbit = 0; orbit < 3; orbit++) {
      ctx.save();
      ctx.translate(xNow, anchorY);
      ctx.rotate((orbit * Math.PI) / 3 + phase * 0.22);
      ctx.beginPath();
      ctx.ellipse(0, 0, mobile ? 19 : 31, mobile ? 7 : 11, 0, 0, Math.PI * 2);
      ctx.stroke();
      const a = phase * 0.8 + orbit * 2;
      ctx.fillStyle = C.gold;
      ctx.beginPath();
      ctx.arc(
        Math.cos(a) * (mobile ? 19 : 31),
        Math.sin(a) * (mobile ? 7 : 11),
        1.7,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = C.white;
    ctx.shadowColor = C.teal;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(xNow, anchorY, 3.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // End-of-window quantiles are text, and stay still while the ambient layer moves.
    function tag(label, value, color, offset) {
      const py = clamp(projectedY(offset), top + 8, bottom - 8);
      const text = `${label} ${number(value)}`;
      ctx.font = `${mobile ? 8 : 10}px "IBM Plex Mono", monospace`;
      const boxWidth = ctx.measureText(text).width + 12;
      ctx.fillStyle = "#071519ed";
      ctx.fillRect(xEnd + 7, py - 10, boxWidth, 19);
      ctx.strokeStyle = `${color}70`;
      ctx.lineWidth = 0.7;
      ctx.strokeRect(xEnd + 7, py - 10, boxWidth, 19);
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.fillText(text, xEnd + 13, py + 3);
    }
    tag(
      "MED",
      smoothPrice + snapshot.median.at(-1),
      C.gold,
      snapshot.median.at(-1),
    );
    if (
      Math.abs(
        projectedY(snapshot.p90.at(-1)) - projectedY(snapshot.median.at(-1)),
      ) > 23
    )
      tag(
        "P90",
        smoothPrice + snapshot.p90.at(-1),
        C.teal,
        snapshot.p90.at(-1),
      );
    if (
      Math.abs(
        projectedY(snapshot.p10.at(-1)) - projectedY(snapshot.median.at(-1)),
      ) > 23
    )
      tag(
        "P10",
        smoothPrice + snapshot.p10.at(-1),
        C.pink,
        snapshot.p10.at(-1),
      );
    ctx.font = '9px "IBM Plex Mono", monospace';
    ctx.fillStyle = C.teal;
    ctx.textAlign = "center";
    ctx.fillText("NOW", xNow, top - 26);
    ctx.strokeStyle = "#4ce6d066";
    ctx.strokeRect(xNow - 20, top - 39, 40, 19);
    ctx.fillStyle = C.text;
    ctx.textAlign = "left";
    ctx.fillText("OBSERVED", x0, bottom + 20);
    ctx.textAlign = "center";
    ctx.fillText("SIMULATED FUTURES", (xNow + xEnd) / 2, bottom + 20);
    if (pointer) {
      const px = clamp(pointer.x, x0, xEnd);
      const py = clamp(pointer.y, top, bottom);
      ctx.strokeStyle = "#a0b6bd50";
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
      ctx.moveTo(x0, py);
      ctx.lineTo(xEnd, py);
      ctx.stroke();
      ctx.setLineDash([]);
      const price = s.reference + (mid - py) / scale;
      ctx.fillStyle = "#0b2429";
      ctx.fillRect(px + 8, py - 26, 80, 20);
      ctx.fillStyle = C.white;
      ctx.textAlign = "left";
      ctx.fillText(`$${number(price)}`, px + 14, py - 12);
    }
    schedule();
  }

  function schedule() {
    if (frame || !isAnimated()) return;
    frame = requestAnimationFrame((now) => {
      frame = 0;
      if (now - lastFrame >= 1000 / 30) draw(now);
      else schedule();
    });
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  reducedMotion.addEventListener("change", () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    draw();
  });
  document.addEventListener("visibilitychange", () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastFrame = performance.now();
    draw();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const rect = canvas.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    draw();
  });
  canvas.addEventListener("pointerleave", () => {
    pointer = null;
    draw();
  });
  return {
    draw,
    setMotion(value) {
      enabled = value;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      draw();
    },
  };
}
