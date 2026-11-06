export const WINDOW_SECONDS = 300;
export const STALE_MS = 10_000;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function random(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function normal(rng) {
  return (
    Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-10))) *
    Math.cos(2 * Math.PI * rng())
  );
}

export function model(price, reference, secondsLeft, volatility = 1) {
  const scale = 3.8 * volatility * Math.sqrt(Math.max(secondsLeft, 1));
  const up = clamp(
    1 / (1 + Math.exp((-(price - reference) / scale) * 1.7)),
    0.01,
    0.99,
  );
  return { up, down: 1 - up };
}

export function bestEdge(probability, upAsk, downAsk, threshold, secondsLeft) {
  const up = (probability.up - upAsk) * 100;
  const down = (probability.down - downAsk) * 100;
  const edge = Math.max(up, down);
  return {
    up,
    down,
    edge,
    side: up >= down ? "UP" : "DOWN",
    ready: secondsLeft < 180 && secondsLeft > 0 && edge >= threshold,
  };
}

export function createSession() {
  return { cash: 1000, pnl: 0, fills: [] };
}

export function paperBuy(session, side, ask, windowId, time, stake = 10) {
  if (
    !["UP", "DOWN"].includes(side) ||
    !Number.isFinite(ask) ||
    ask <= 0 ||
    ask >= 1 ||
    !Number.isFinite(stake) ||
    stake <= 0 ||
    session.cash < stake
  )
    return false;
  session.cash = Math.round((session.cash - stake) * 100) / 100;
  session.fills.unshift({
    side,
    ask,
    stake,
    shares: stake / ask,
    windowId,
    time,
    status: "OPEN",
    payout: 0,
    pnl: 0,
  });
  return true;
}

export function settle(session, windowId, finalPrice, reference) {
  if (!Number.isFinite(finalPrice) || !Number.isFinite(reference)) return;
  for (const fill of session.fills) {
    if (fill.windowId !== windowId || fill.status !== "OPEN") continue;
    const win =
      fill.side === "UP" ? finalPrice >= reference : finalPrice < reference;
    fill.payout = win ? fill.shares : 0;
    fill.pnl = fill.payout - fill.stake;
    fill.status = win ? "WIN" : "LOSS";
    session.cash += fill.payout;
    session.pnl += fill.pnl;
  }
}

export function freshness(lastTick, now) {
  return {
    age: lastTick === null ? null : Math.max(0, now - lastTick),
    stale: lastTick === null || now - lastTick > STALE_MS,
  };
}

export function parseTicker(message) {
  try {
    const tick = JSON.parse(message);
    const price = Number(tick.price);
    if (
      tick.type !== "ticker" ||
      tick.product_id !== "BTC-USD" ||
      !Number.isFinite(price) ||
      price <= 0
    )
      return null;
    return price;
  } catch {
    return null;
  }
}

export function fillsCSV(fills) {
  const header =
    "time_utc,window,side,ask,stake_usd,shares,status,payout_usd,pnl_usd";
  const rows = fills.map((f) =>
    [
      new Date(f.time).toISOString(),
      f.windowId,
      f.side,
      f.ask.toFixed(4),
      f.stake.toFixed(2),
      f.shares.toFixed(6),
      f.status,
      f.payout.toFixed(2),
      f.pnl.toFixed(2),
    ].join(","),
  );
  return [header, ...rows].join("\n");
}
