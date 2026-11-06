import { expect, test } from "bun:test";
import { Book, checksum, parseWire } from "../server/market.js";

const bids = [
  ["45283.5", "0.10000000"],
  ["45283.4", "1.54582015"],
  ["45282.1", "0.10000000"],
  ["45281.0", "0.10000000"],
  ["45280.3", "1.54592586"],
  ["45279.0", "0.07990000"],
  ["45277.6", "0.03310103"],
  ["45277.5", "0.30000000"],
  ["45277.3", "1.54602737"],
  ["45276.6", "0.15445238"],
];
const asks = [
  ["45285.2", "0.00100000"],
  ["45286.4", "1.54571953"],
  ["45286.6", "1.54571109"],
  ["45289.6", "1.54560911"],
  ["45290.2", "0.15890660"],
  ["45291.8", "1.54553491"],
  ["45294.7", "0.04454749"],
  ["45296.1", "0.35380000"],
  ["45297.5", "0.09945542"],
  ["45299.5", "0.18772827"],
];
const levels = (rows) => rows.map(([price, qty]) => ({ price, qty }));
const fixture = () => ({
  symbol: "BTC/USD",
  bids: levels(bids),
  asks: levels(asks),
  checksum: 3310070434,
});

test("Kraken published CRC32 vector and decimal-preserving wire decoder", () => {
  expect(checksum(levels(asks), levels(bids))).toBe(3310070434);
  const msg = parseWire(
    '{"price":45281.0,"qty":0.10000000,"label":"price: 12","checksum":3310070434}',
  );
  expect(msg.price).toBe("45281.0");
  expect(msg.qty).toBe("0.10000000");
  expect(msg.label).toBe("price: 12");
});

test("book applies deletes and duplicate updates sequentially then checks CRC", () => {
  const book = new Book(10);
  book.apply("snapshot", fixture(), 1000);
  expect(book.valid).toBe(true);
  const nextBids = [...bids.slice(1), ["45275.0", "0.2"]];
  book.apply(
    "update",
    {
      symbol: "BTC/USD",
      bids: [
        { price: "45283.5", qty: "0" },
        { price: "45275.0", qty: "0.1" },
        { price: "45275.0", qty: "0.2" },
      ],
      asks: [],
      checksum: checksum(levels(asks), levels(nextBids)),
    },
    2000,
  );
  expect(book.snapshot().bids[0][0]).toBe(45283.4);
  expect(book.snapshot().bids.at(-1)).toEqual([45275, 0.2]);
});

test("checksum failure and malformed books invalidate data; update cannot repair without snapshot", () => {
  const book = new Book(10);
  book.apply("snapshot", fixture(), 1000);
  expect(() =>
    book.apply(
      "update",
      { symbol: "BTC/USD", bids: [], asks: [], checksum: 0 },
      2000,
    ),
  ).toThrow("checksum");
  expect(book.valid).toBe(false);
  expect(() => book.apply("update", fixture(), 3000)).toThrow("snapshot");
  expect(() =>
    book.apply(
      "snapshot",
      { ...fixture(), asks: [{ price: "NaN", qty: "1" }] },
      3000,
    ),
  ).toThrow();
  expect(book.valid).toBe(false);
  book.apply("snapshot", fixture(), 4000);
  expect(book.valid).toBe(true);
});

test("book truncates subscribed depth before checksum and permits exponent precision", () => {
  const book = new Book(10);
  book.apply(
    "snapshot",
    { ...fixture(), bids: [...levels(bids), { price: "1", qty: "1" }] },
    1000,
  );
  expect(book.snapshot().bids).toHaveLength(10);
  expect(
    checksum([{ price: "1e2", qty: "1e-8" }], [{ price: "9e1", qty: "2e-8" }]),
  ).toBe(
    checksum(
      [{ price: "100", qty: "0.00000001" }],
      [{ price: "90", qty: "0.00000002" }],
    ),
  );
});
