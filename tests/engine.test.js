import { test, expect } from "bun:test";
import {
  model,
  bestEdge,
  createSession,
  paperBuy,
  settle,
  freshness,
  parseTicker,
  fillsCSV,
} from "../dist/engine.js";

test("model probabilities are complementary and respond to price direction", () => {
  expect(model(100, 100, 180).up).toBe(0.5);
  expect(model(110, 100, 180).up).toBeGreaterThan(0.5);
  expect(model(90, 100, 180).up).toBeLessThan(0.5);
  const p = model(110, 100, 180);
  expect(p.up + p.down).toBe(1);
});
test("illustrative signal respects both minimum edge and entry zone", () => {
  const p = { up: 0.6, down: 0.4 };
  expect(bestEdge(p, 0.5, 0.52, 5, 120).ready).toBe(true);
  expect(bestEdge(p, 0.5, 0.52, 5, 200).ready).toBe(false);
  expect(bestEdge(p, 0.5, 0.52, 15, 120).ready).toBe(false);
  expect(bestEdge(p, 0.5, 0.52, 5, 0).ready).toBe(false);
});
test("paper cash and P&L reconcile after mixed outcomes, settlement is idempotent", () => {
  const session = createSession();
  expect(paperBuy(session, "UP", 0.5, 1, 0)).toBe(true);
  expect(paperBuy(session, "DOWN", 0.25, 1, 0)).toBe(true);
  expect(session.cash).toBe(980);
  settle(session, 1, 101, 100);
  expect(session.cash).toBe(1000);
  expect(session.pnl).toBe(0);
  expect(session.fills.map((f) => f.status)).toEqual(["LOSS", "WIN"]);
  settle(session, 1, 101, 100);
  expect(session.cash).toBe(1000);
});
test("ties settle UP, other windows are untouched, invalid orders rejected", () => {
  const session = createSession();
  expect(paperBuy(session, "UP", 0, 1, 0)).toBe(false);
  expect(paperBuy(session, "UP", 0.5, 1, 0, 1001)).toBe(false);
  expect(paperBuy(session, "UP", 0.5, 1, 0, NaN)).toBe(false);
  paperBuy(session, "UP", 0.5, 1, 0);
  paperBuy(session, "DOWN", 0.5, 2, 0);
  settle(session, 1, 100, 100);
  expect(session.fills[0].status).toBe("OPEN");
  expect(session.fills[1].status).toBe("WIN");
});
test("missing and aged feeds are stale", () => {
  expect(freshness(null, 100).stale).toBe(true);
  expect(freshness(100, 101).stale).toBe(false);
  expect(freshness(100, 10101).stale).toBe(true);
});
test("only valid BTC-USD ticker messages update spot prices", () => {
  expect(parseTicker("{")).toBeNull();
  expect(
    parseTicker('{"type":"ticker","product_id":"BTC-USD","price":"80340.97"}'),
  ).toBe(80340.97);
  expect(
    parseTicker('{"type":"ticker","product_id":"ETH-USD","price":"2000"}'),
  ).toBeNull();
  expect(
    parseTicker('{"type":"ticker","product_id":"BTC-USD","price":"NaN"}'),
  ).toBeNull();
  expect(parseTicker('{"type":"subscriptions"}')).toBeNull();
});
test("CSV records exact paper fill status and rounded monetary fields", () => {
  const session = createSession();
  paperBuy(session, "UP", 0.5, 1, 0);
  expect(fillsCSV(session.fills)).toContain(
    "1970-01-01T00:00:00.000Z,1,UP,0.5000,10.00,20.000000,OPEN,0.00,0.00",
  );
});
