// Kraken requires decimal tokens, including trailing zeros, for CRC32.
// Scan numbers only outside JSON strings; JSON.parse still validates structure.
export function parseWire(text) {
  let output = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === "\\") i += 2;
        else if (text[i++] === '"') break;
      }
      output += text.slice(start, i);
    } else if (/[\d-]/.test(text[i])) {
      const token = text
        .slice(i)
        .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!token) throw new Error("Invalid numeric token");
      output += JSON.stringify(token[0]);
      i += token[0].length;
    } else output += text[i++];
  }
  return JSON.parse(output);
}

function decimal(value) {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [mantissa, exponent] = text.toLowerCase().split("e");
  const [integer, fraction = ""] = mantissa.split(".");
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

const table = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let j = 0; j < 8; j++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function checksum(asks, bids) {
  const digits = (value) => decimal(value).replace(".", "").replace(/^0+/, "");
  const input = [...asks.slice(0, 10), ...bids.slice(0, 10)]
    .map((level) => digits(level.price) + digits(level.qty))
    .join("");
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++)
    crc = table[(crc ^ input.charCodeAt(i)) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export class Book {
  constructor(depth = 500) {
    this.depth = depth;
    this.bids = new Map();
    this.asks = new Map();
    this.valid = false;
    this.timestamp = null;
  }

  invalidate() {
    this.valid = false;
  }

  apply(type, data, receivedAt = Date.now()) {
    try {
      if (data.symbol !== "BTC/USD") throw new Error("Unexpected book symbol");
      if (type !== "snapshot" && type !== "update")
        throw new Error("Invalid book type");
      if (type === "update" && !this.valid)
        throw new Error("Waiting for a fresh snapshot");
      const next = {};
      for (const side of ["asks", "bids"]) {
        const entries = data[side] ?? [];
        if (!Array.isArray(entries)) throw new Error("Malformed book levels");
        const map = type === "snapshot" ? new Map() : new Map(this[side]);
        for (const level of entries) {
          const price = Number(level.price);
          const qty = Number(level.qty);
          if (
            !(price > 0) ||
            !Number.isFinite(price) ||
            !(qty >= 0) ||
            !Number.isFinite(qty)
          )
            throw new Error("Malformed book level");
          if (qty === 0) map.delete(price);
          else
            map.set(price, {
              price: String(level.price),
              qty: String(level.qty),
            });
        }
        next[side] = new Map(
          [...map]
            .sort(([a], [b]) => (side === "asks" ? a - b : b - a))
            .slice(0, this.depth),
        );
      }
      if (
        !next.asks.size ||
        !next.bids.size ||
        next.asks.keys().next().value <= next.bids.keys().next().value
      )
        throw new Error("Empty or crossed book");
      const expected = Number(data.checksum);
      if (
        !Number.isInteger(expected) ||
        checksum([...next.asks.values()], [...next.bids.values()]) !== expected
      )
        throw new Error("Kraken book checksum mismatch");
      this.bids = next.bids;
      this.asks = next.asks;
      this.timestamp = Number.isFinite(Date.parse(data.timestamp))
        ? Date.parse(data.timestamp)
        : receivedAt;
      this.valid = true;
      return this.snapshot();
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  snapshot() {
    const rows = (side) =>
      [...this[side].values()]
        .slice(0, 300)
        .map(({ price, qty }) => [Number(price), Number(qty)]);
    return {
      bids: rows("bids"),
      asks: rows("asks"),
      timestamp: this.timestamp,
      valid: this.valid,
    };
  }
}
