# Paper experiment contract

Two frozen policies see the same raw acquisition-time events: always quote and
a fixed trailing volatility/trend filter. The filter uses only past observations.
No optimizer, pair search, LLM strategy rewrite or live order execution is present.

Capture settings and self-declared development/evaluation purpose are written at
START. Default capture limits are 30 minutes, 48 MiB and 200,000 total lines;
the first limit stops acquisition with an end record. A 2 GiB directory quota
reserves the selected cap, plus 64 MiB free-disk headroom, assuming one recorder
process owns that directory. Existing files are never deleted or rotated.

## Execution assumptions

Engine v2 uses an assumed 250 ms quote latency, 10 bps maker fee and 15 bps half
spread by default. The account fee tier, queue position and market impact are
not measured. Fills require strict trade-through with the corresponding taker
side and are capped by observed trade volume. Inventory is long only and bounded.

Exchange and recorder timestamps are different clocks. The assumed ±1,000 ms
bound excludes ambiguous near-arrival fills and tightens freshness. An observed
lead inside that bound does not certify clock synchronization. Gaps/staleness
cancel quotes and reset filter history; missing markout horizons stay unresolved.

Inventory is marked at the last accepted mid; no forced final liquidation is
simulated. Fees, inventory repricing, drawdown, observed markouts and excess over
passively holding the starting inventory are shown separately. Receive-clock
markouts are observations, not guaranteed exchange-time future returns.

## Evidence and reproduction

The full paper receipt exports normalized input, input SHA256, resolved config,
engine version and result. Reproduce with `runPaperExperiment(receipt.input,
receipt.result.config)` from `dist/paper-engine.js` using the matching release.
Compact replay discards trades and is refused for execution.

An evaluation label requires the full session ended at a planned duration/byte/
event limit, the captured config and matching engine version. Manual, server,
error, partial or overridden runs remain exploratory. Source/purpose labels are
self-declared and do not prove an untouched holdout or authenticated provenance.

Summaries persist per browser origin, at most 100 results / 2 MiB of serialized UTF-8 without eviction.
Exclusive Web Locks serialize writers; missing locks, timeout, invalid data or
full storage refuses saving while the current full receipt remains exportable.
Browser data clearing loses history. Summary archives omit raw events and cannot
substitute for full replay receipts. Do not pool these sessions into a win rate
or claim a trading edge without independent future evaluation.


## Feed and display clocks

Gap markers are projected onto the exchange-time display axis from the last
accepted book plus elapsed recorder time. The exact observed failure time stays
in `receiveTimestamp`, which governs paper execution. Projection does not claim
measured clock synchronization. The first recovered book bypasses the ordinary
one-second recording throttle, so short recoveries remain replayable.

`bookValid` means the retained book passed CRC validation; it is not a freshness
certificate. `lastBookMessageAt` and `lastMessageAt` expose separate recorder
clocks. Heartbeats/trades never advance the book clock. Kraken book updates are
change-driven, so book silence alone does not prove a transport failure and does
not trigger an artificial disconnect. The UI shows book age/staleness, while the
paper engine cancels stale quotes and resets filter history at its stricter
configured age bound. A missing-heartbeat timeout still invalidates and reconnects.
See [Kraken's feed description](https://support.kraken.com/articles/360022326871-kraken-websocket-api-frequently-asked-questions).

Trade deduplication uses the most recent 250,000 distinct IDs, including unseen
out-of-order IDs. This cache exceeds the maximum line count of one raw session;
duplicates older than that rolling window are not guaranteed to be recognized.
