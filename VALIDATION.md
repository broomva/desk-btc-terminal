# Validation

Install dependencies with `bun install --frozen-lockfile`, then run:

```sh
bun test
bun run check
bun node_modules/playwright-core/cli.js install --with-deps chromium
bun run test:browser
bun run test:research
bun run test:paper
bun run test:sessions
```

The current suite has 90 unit tests / 634 assertions. Browser checks use
synthetic fixtures and actual local-server interactions: animation and pause,
source boundaries, replay, raw/compact refusal, fee sensitivity, exact receipt
reproduction, capture deadline stopping, history reload, concurrent tabs and
malformed optional metadata. Layout checks cover 320–1440 CSS pixels.

GitHub Actions runs these checks on pull requests. No deployment or recording is
triggered by CI. A green fixture suite is not a market-performance result.

## Explicit real-feed checks

`DESK_LIVE_SMOKE=1 bun run test:browser` includes a real Coinbase subscription.
`bun run test:live` acquires Kraken depth/trades, records a finite session, checks
CRC-valid depth, auto-stop, raw paper evaluation and compact refusal. Use
`DESK_CAPTURE_MS=90000 bun run test:live` for a 90-second acquisition. These checks
need external feed access and are deliberately outside the deterministic PR gate.

Before publication, the local runtime was exercised on Linux and macOS. A real
90-second Kraken recording produced 555 normalized events; its exported paper
receipt reproduced exactly. That is acquisition/accounting evidence, not proof
of actual exchange fills, calibrated probabilities or profitable strategy skill.
Private machine-specific delivery receipts and raw recordings are not published.
