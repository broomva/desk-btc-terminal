# DESK · BTC Research

A local BTC market research terminal, inspired by the supplied depth/futures video. Buildless HTML, CSS and canvas ES modules; a Bun server connects to public Kraken market data and records it locally. No wallet, order execution, model keys or ChatGPT Sites hosting is required.

## Run locally

```sh
bun install --frozen-lockfile
bun start
```

Open http://127.0.0.1:5173/. `PORT` changes the port; `DESK_DATA_DIR` changes the recording directory (default `data/`, ignored by Git). Bind is restricted to loopback. Static hosting still runs the synthetic demo and file imports; live depth and server recordings require the Bun service.

The default **Research Desk** shows explicitly synthetic demo depth, a white observed-price trail, a NOW boundary, and a simulated future fan/ridge. **Futures** emphasizes the fan; **Agents** shows eight configuration variants and weights. The experiment journal retains accepted and rejected edits. **5M Terminal** retains the original demo, optional Coinbase spot feed, settings, sampled paths and paper-session controls.

### Real data and recording

Choose **Kraken / Live** for public BTC/USD depth and trades. The server maintains Kraken's 500-level book, verifies top-ten CRC32 checksums before exposing 300 levels per side, and marks gaps/disconnections without substituting demo data. Reconnects require a new snapshot. Book ages and source labels remain visible. Empty or stale data does not become a trading signal.

**Record** starts append-only NDJSON containing a current valid book, exact MID/top25 research observations at ten-second cadence, full-book samples once per second, all received deduplicated trades, gaps and start/end metadata. The local API defaults to 30 minutes / 48 MiB / 200,000 total lines, stopping at the first limit, including a reserved end marker. The UI offers 15-second checks and 5-minute to 3-hour captures; API ceilings are 12 hours / 60 MiB / 249,000 lines. Defaults keep raw files within paper import limits. Directory quota is 2 GiB, checked before start by reserving the full selected file cap; 64 MiB disk headroom is also required. Capacity errors preserve every existing file. This reservation assumes one recorder process owns the directory; external writers are not accounted continuously. Stop before replaying. Recording downloads the raw capture; Results exports evaluation settings, exact input observations and results as JSON. Recording runs independently of the paused browser view and survives closing the tab while the server remains running; it stops on server shutdown or a limit. There is no automatic recording on app startup.

Choose **Local / Replay**, refresh sessions, and select a completed recording. Full events is the default for paper execution. Optionally, the server streams a compact view with an actual book at most once per 30 seconds and an actual trade at most once per 10 seconds, retaining gaps, final events and every original research observation. It is sampled, not a complete trade tape. Raw exports are unchanged. Compact output is capped at 48MiB; direct NDJSON imports are limited to 64MB and 250,000 lines. A replay sorts these events and reveals only data at or before the scrubber. Invalid imports report an error and preserve the prior valid view. Replay snapshots are recorded data, not newly CRC-verified exchange messages.

The view can pause while live recording continues. Running a live/replay evaluation freezes the viewed origin; resuming live or moving the replay scrubber clears that forecast. Replay speed changes presentation time, not timestamps or research scores. Motion honors reduced-motion preferences, pause, hidden tabs, and the legacy settings motion switch.

### Forecast research

Eight configurations vary lookback, block length, drift, volatility scale and book imbalance. The engine bootstraps observed historical minute returns, makes one bounded parameter mutation per round, and evaluates quantile forecasts with pinball loss. Default research uses 12 rounds, 120 paths per trial and 1,000 retained display trajectories. No LLM prompt/code rewriting or upstream ATLAS installation is involved. Lifecycle replacement occurs only if the configured floor/extinction conditions are actually reached; no invented spawn events are displayed.

The 15-minute evaluator needs at least **272 consecutive completed minutes**. It uses chronological warm-up/calibration/test windows and nonoverlapping forecast origins with mature labels. Weights and edits are chosen before the final test is scored. A fixed bootstrap baseline is reported alongside the ensemble's test loss. Inputs stop at the current replay/view time; incomplete minutes do not enter scoring. Missing minutes reset the eligible history segment. The live buffer retains roughly 24 hours of 10-second observations.

The demo evaluates a deterministic 10-hour synthetic fixture. Its scores and accepted edits are labeled DEMO. Real data that is too short returns an explicit insufficient-history state. Re-running on the same history reuses its holdout; independent later recordings are still needed. Path shares are uncalibrated model outputs, pinball loss is in dollars, and no fills, fees, slippage or profitability are modeled. No Kronos model is connected.

## Source and local API

`dist/index.html` → `research.js` → `depth-chart.js` / `replay.js` / `tournament-worker.js` → `tournament.js`. The original `app.js` → `chart.js` / `engine.js` / `projections.js` remains the 5M workspace. `server/index.js` → `market.js` / `recorder.js` / `compact.js` serves static files and local APIs:

- `GET /api/status`, `/api/market`, `/api/recordings`
- `POST /api/record/start`, `/api/record/stop`
- `GET /api/recordings/:id.ndjson` (raw) or `/:id/replay.ndjson` (compact)

Mutation requests validate Host/Origin. Filesystem paths and recording IDs are validated; data is not exposed by the static route. No runtime packages beyond Bun/browser APIs. Source repository: [broomva/desk-btc-terminal](https://github.com/broomva/desk-btc-terminal). GitHub Actions runs unit, static and deterministic browser checks on pull requests. The server and recordings run locally; publishing this repository does not host a dashboard or start a recorder.

## Checks

```sh
bun test
bun run check
DESK_CHROME=/absolute/path/to/chrome bun run test:browser
DESK_CHROME=/absolute/path/to/chrome bun run test:research
```

See [VALIDATION.md](VALIDATION.md) for reproducible checks and their limits. Browser tests need a compatible Chrome; use `LD_LIBRARY_PATH` if local libraries are needed. Source references: [Kraken book contract](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/book), [visual reference](https://x.com/carm1nee/status/2117800036645900652), [ATLAS architecture](https://github.com/chrisworsey55/atlas-gic/blob/main/architecture/autoresearch.md).

## Paper execution lab

The **Paper Execution Lab** compares always-quote against a fixed, past-only
volatility/trend filter. Choose **Demo** to exercise a clearly synthetic 15-minute
execution fixture; this is separate from the forecasting fixture. For real data,
record Kraken, stop, choose **Local / Replay**, select **Full events / paper lab**,
and load the session. Imports accept raw NDJSON. Compact replay is visual only:
it discards trade volume and the simulator refuses it. Download/import limits are
64MB / 250,000 lines; record shorter captures for this experiment.

Click **Run paper comparison**. Fee and half-spread assumptions are editable and
invalidate results when changed. Both fixed policies use the same events up to
the replay cursor. There is no optimization or selection of a winning pair.
The panel shows net marked equity, fees, inventory, drawdown, signed post-fill
1s/10s/60s markouts, and excess return over holding the starting inventory.
Missing horizons remain unresolved. The journal shows the last 20 fills per
policy; the exported JSON retains all quotes, fills, decisions and equity points.

**Paper receipt** includes the exact normalized input, SHA256, frozen config and
result. Reproduce in Bun with `runPaperExperiment(receipt.input,
receipt.result.config)` from `dist/paper-engine.js`. Receive times order decisions;
trade exchange timestamps prevent delayed old prints filling a newer quote.
Replay END includes acquisition timestamps and the validated recording-end
marker, so delayed final events and silent tails remain in the experiment.
Arrival checks use the last known book before the arriving event, rather than
retrospectively rejecting an adverse fill using a later trade-time book.
Source labels come from recording metadata and are not authenticated provenance.

Assumptions: maker fee 10bps (not an account-specific Kraken rate), half-spread
15bps, 0.001 BTC orders, 60s refresh, 250ms latency, maximum book age 5s,
$10,000 cash plus 0.01 BTC starting inventory, long-only bounds 0–0.02 BTC.
The filter pauses above 30bps trailing 60s range or 15bps absolute drift and needs
30s history. Strict trade-through fills are capped by aggressive trade volume;
queue ahead is assumed zero. Sampled books cannot establish queue priority or
market impact. Cancel latency is assumed zero. Remaining inventory is marked at
the last valid mid, without forced liquidation; the receipt discloses valuation
age/freshness. These are descriptive simulations, not validated profitability.
Drex and HOLA are deferred until independent outcomes justify testing them.

`bun run test:paper` exercises actual browser clicks, export/rerun, fee sensitivity,
raw/compact handling, invalidation and responsive layouts (requires DESK_CHROME).
`bun run test:live` additionally records real Kraken data and runs both paper
policies on raw data; short captures do not establish forecast or strategy skill.

### Clock uncertainty (paper engine v2)

Real Mac capture showed valid Kraken timestamps slightly ahead of local receipt.
Exchange timestamps and receipt timestamps are different clocks; their offset
cannot be established from these captures alone. Engine v2 assumes an explicit
±1,000ms bound (`maxClockSkewMs`), disclosed with the observed exchange lead.
It accepts packets within that bound, but a fill requires the trade to be after
quote arrival even at the earliest possible exchange event time. Ambiguous
near-arrival trades are excluded. Freshness uses the worse of receive age and
exchange age plus uncertainty. Larger future offsets still fail explicitly;
this is an assumption, not a synchronization certificate. Keep the bound smaller
than `maxBookAgeMs`. No operating-system clock settings are changed.

The paper slice ends in acquisition time, even if an exchange timestamp leads
the visual cursor. Receipts retain local end markers, packet age and worst-case
age. Use the matching release/engine version when reproducing an old receipt.
Official event contract: https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade .

Markouts are **as-observed on the receive clock**: the first accepted book
received at/after a horizon, within freshness tolerance. They are not guaranteed
exchange-time forward returns: a delayed book's exchange timestamp can predate
the fill. The clock bound also excludes roughly the first second after arrival
at the default setting. Both are simulator limitations, not estimated alpha.


### Bounded sessions and paper results

Choose Kraken / Live, set duration, file limit and development/evaluation
purpose, then set assumed paper fee/spread and press Record. The session header
freezes a fully resolved engine-v2 policy config and self-declared purpose
before acquisition. Controls lock during capture; view pause/tab closure do not
stop server recording. A dedicated timer stops silent sessions; a process crash
can still leave an incomplete file. The recording selector shows ended versus
incomplete sessions; replay preserves the stop reason. Active raw and compact
reads return HTTP409. There is no startup recording, recurring job, file
deletion or automatic restart.

`POST /api/record/start` accepts optional JSON `maxDurationMs`, `maxBytes`,
`maxEvents`, `purpose` (`development` or `evaluation`), and `paperConfig` overrides.
Empty requests use the bounded defaults. Invalid settings return400; an active
plan change returns409; capacity rejection returns507. The body is capped at8KiB.
The recorder class retains legacy constructor defaults for direct callers; the
server always resolves the bounded API preset. No order/exchange API is added.

Load a raw session to restore its captured fee/spread and other frozen policy
values. Changing fee/spread makes the result exploratory. Paper Session Results
saves up to100 distinct input-hash/config summaries in this browser's
localStorage, without evicting old results; [Web
Locks](https://www.w3.org/TR/web-locks/) serialize same-origin tab writers.
Missing locking support, a 5-second lock timeout or blocked/full storage reports
an error while retaining the current full paper receipt export. Same-
input/config/engine-version reruns are deduplicated. The history is origin-
specific (localhost and127.0.0.1 differ), not a server database, and browser
data clearing removes it. Summary Archive exports metrics and configs, not raw
events; use Paper Receipt and retain original NDJSON for exact reruns.

Each expandable session reports policy P&L, excess vs passive holding, assumed
fees, fills, final inventory, maximum marked exposure, drawdown and60s observed
markout coverage. The current-run table also shows1s/10s marks and the shared-
scale equity chart. Missing end markers, partial replay, gaps, missing receive
clocks, stale valuation, no fills and overrides remain explicit. Malformed
optional purpose labels become unassigned; render-required summary fields are
checked before storage and on reload. A declared evaluation requires the full
session ended at a planned duration/byte/event limit, captured config and
matching engine version; manual stops, server shutdown and acquisition errors
stay exploratory. This is only self-declared provenance, never proof of
untouched data or statistical skill. No results are pooled into a success rate.
No sensitivity search or optimizer added.

Validation: `bun run test:sessions` uses a generated wire fixture and actual local
server/browser clicks through deadline stop, reload and export; it is not real
market data. `DESK_CAPTURE_MS=90000 bun run test:live` separately checks real Kraken
acquisition and deadline stopping. `DESK_CHROME` selects a dedicated test browser.


## Browser checks and live smokes

```sh
bun node_modules/playwright-core/cli.js install --with-deps chromium
bun run test:browser
bun run test:research
bun run test:paper
bun run test:sessions
```

A compatible installed browser can be selected with `DESK_CHROME`. The default
browser suites use fixtures and local servers. To opt into the external Coinbase
subscription smoke, run `DESK_LIVE_SMOKE=1 bun run test:browser`. To explicitly
record real Kraken data, run `bun run test:live`, or set `DESK_CAPTURE_MS=90000`
for a longer finite check. External feed availability is not a PR gate.

## Local data

Keep `data/`, NDJSON recordings, paper receipts, logs and browser profiles local.
These are ignored by Git. `DESK_DATA_DIR` can point outside the checkout; changing
or updating the source does not move or delete that directory. Do not commit
exchange credentials. DESK uses public data endpoints and has no order router.

[Experiment contract](docs/EXPERIMENTS.md) describes frozen policies, timing,
accounting and why descriptive paper outcomes do not establish an edge.
