const { chromium } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
(async () => {
  const { demoRecording } = await import("../dist/replay.js");
  const fixture = demoRecording();
  const events = [...fixture.books, ...fixture.trades].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const recordingText = events.map(JSON.stringify).join("\n");
  const browser = await chromium.launch({
    executablePath: process.env.DESK_CHROME,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let recording = false;
  let failing = false;
  const book = { ...fixture.books.at(-1), valid: true, timestamp: Date.now() };
  const market = () => ({
    book,
    history: [{ timestamp: book.timestamp - 20000, price: 100 }],
    trades: fixture.trades.slice(-9),
    status: {
      connected: true,
      bookValid: true,
      recording,
      sessionId: recording ? "sample-session" : null,
      bytes: 1024,
      gaps: 0,
    },
  });
  await page.route("http://desk.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      if (failing)
        return route.fulfill({
          status: 503,
          json: { error: "Local service unavailable" },
        });
      if (url.pathname === "/api/market")
        return route.fulfill({ json: market() });
      if (url.pathname.startsWith("/api/record/")) {
        recording = url.pathname.endsWith("start");
        return route.fulfill({ json: market().status });
      }
      if (url.pathname === "/api/recordings")
        return route.fulfill({
          json: {
            recordings: [{ id: "sample-session", bytes: recordingText.length }],
          },
        });
      if (url.pathname.endsWith(".ndjson"))
        return route.fulfill({
          body: recordingText,
          contentType: "application/x-ndjson",
        });
      return route.fulfill({ status: 404, json: { error: "missing" } });
    }
    const name = url.pathname.slice(1) || "index.html";
    return route.fulfill({
      body: await fs.readFile(path.join(root, "dist", name)),
      contentType: name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
  });
  await page.goto("http://desk.test/");
  await page.waitForFunction(() =>
    document.querySelector("#research-above").textContent.includes("%"),
  );
  assert.equal(await page.locator(".agent-row").count(), 8);
  assert.match(
    await page.locator("#experiment-summary").textContent(),
    /DEMO \/ 12 EDITS/,
  );
  assert.match(
    await page.locator("#depth-integrity").textContent(),
    /SYNTHETIC/,
  );
  await page.locator("#tab-depth").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-futures").getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#agents-panel").isVisible(), true);
  await page.locator("#tab-depth").click();
  const canvas = page.locator("#depth-canvas");
  const a = await canvas.evaluate((c) => c.toDataURL());
  await page.waitForTimeout(450);
  assert.notEqual(await canvas.evaluate((c) => c.toDataURL()), a);
  await page.locator("#research-pause").click();
  const paused = await canvas.evaluate((c) => c.toDataURL());
  await page.waitForTimeout(350);
  assert.equal(await canvas.evaluate((c) => c.toDataURL()), paused);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(
    () => document.querySelector("#depth-canvas").dataset.motion === "reduced",
  );
  assert.equal(await canvas.getAttribute("data-motion"), "reduced");
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `overflow at ${width}`,
    );
  }
  await page.selectOption("#research-source", "live");
  await page.waitForFunction(
    () =>
      document.querySelector("#depth-integrity").textContent === "CRC VERIFIED",
  );
  assert.equal(
    await page.locator("#depth-price").textContent(),
    ((book.bids[0][0] + book.asks[0][0]) / 2).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    }),
  );
  assert.equal(
    Number(await canvas.getAttribute("data-window-end")),
    book.timestamp,
  );
  assert.equal(
    await page
      .locator("#research-above")
      .textContent()
      .then((t) => t.includes("%")),
    false,
  );
  await page.locator("#run-tournament").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#experiment-summary").textContent ===
      "INSUFFICIENT HISTORY",
  );
  assert.match(
    await page.locator("#evaluation-state").textContent(),
    /minute|history/i,
  );
  await page.locator("#record-toggle").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#record-toggle").getAttribute("aria-pressed") ===
      "true",
  );
  await page.locator("#record-toggle").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#record-toggle").getAttribute("aria-pressed") ===
      "false",
  );
  await page.selectOption("#research-source", "replay");
  await page.waitForFunction(
    () => document.querySelector("#recording-select").options.length === 2,
  );
  await page.selectOption("#recording-select", "sample-session");
  await page.waitForFunction(() =>
    document.querySelector("#research-status").textContent.includes("LOADED"),
  );
  assert.match(
    await page.locator("#depth-integrity").textContent(),
    /RECORDED/,
  );
  await page.locator("#run-tournament").click();
  await page.waitForFunction(() =>
    document.querySelector("#research-above").textContent.includes("%"),
  );
  assert.equal(
    (await page.locator("#experiment-summary").textContent()).includes("DEMO"),
    false,
  );
  const atEnd = await page.locator("#depth-price").textContent();
  await page.locator("#replay-position").fill("300");
  assert.notEqual(await page.locator("#depth-price").textContent(), atEnd);
  assert.equal(
    (await page.locator("#research-above").textContent()).includes("%"),
    false,
  );
  await page.locator("#run-tournament").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#experiment-summary").textContent ===
      "INSUFFICIENT HISTORY",
  );
  await page.locator("#recording-file").setInputFiles({
    name: "broken.ndjson",
    mimeType: "text/plain",
    buffer: Buffer.from("not-json"),
  });
  await page.waitForFunction(() =>
    document
      .querySelector("#research-status")
      .textContent.includes("Invalid JSON"),
  );
  failing = true;
  await page.selectOption("#research-source", "live");
  await page.waitForFunction(() =>
    document
      .querySelector("#research-status")
      .textContent.includes("UNAVAILABLE"),
  );
  assert.equal(await page.locator("#depth-price").textContent(), "—");
  assert.equal(await page.locator("#record-toggle").isDisabled(), true);
  await page.selectOption("#research-source", "demo");
  await page.waitForFunction(() =>
    document.querySelector("#research-above").textContent.includes("%"),
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#research-export").click();
  assert.match(
    (await downloadPromise).suggestedFilename(),
    /desk-demo-research.json/,
  );
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    JSON.stringify({
      result: "PASS",
      errors,
      checks: [
        "8-agent demo",
        "keyboard tabs",
        "distinct animated frames",
        "pause freezes pixels",
        "reduced motion",
        "responsive 320–1440",
        "real/replay/sim source boundaries",
        "record start/stop",
        "short-data evaluator unavailable",
        "compact replay load",
        "past-only scrub",
        "forecast invalidation",
        "malformed import",
        "service failure without synthetic fallback",
        "export",
      ],
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
