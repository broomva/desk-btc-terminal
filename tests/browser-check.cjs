const { chromium } = require("playwright-core");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.DESK_CHROME,
    args: ["--no-sandbox"],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || "" },
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://desk.test/**", async (route) => {
    const name =
      new URL(route.request().url()).pathname.slice(1) || "index.html";
    const contentType = name.endsWith(".css")
      ? "text/css"
      : name.endsWith(".js")
        ? "text/javascript"
        : "text/html";
    await route.fulfill({
      body: await fs.readFile(`${root}/dist/${name}`),
      contentType,
    });
  });
  await page.clock.install();
  await page.goto("http://desk.test/");
  await page.locator("#workspace-legacy").click();
  await page.waitForFunction(
    () => document.querySelector("#price").textContent !== "$80,340.97",
  );
  await page.screenshot({ path: "/tmp/desk-desktop.png", fullPage: true });
  assert.equal(
    await page.locator("#market-chart").getAttribute("data-motion"),
    "reduced",
  );
  assert.equal(await page.locator("#sample-grid i").count(), 120);
  assert.equal(
    Number(await page.locator("#paths-up").textContent()) +
      Number(await page.locator("#paths-down").textContent()),
    120,
  );
  assert.equal(
    await page.locator("#market-tools").evaluate((d) => d.open),
    false,
  );
  const count = await page.locator(".window-cell").count();
  assert.equal(count, 288);
  await page.locator("#market-tools summary").click();
  await page.locator("#buy-up").click();
  assert.equal(await page.locator("#balance").textContent(), "$990.00");
  assert.equal(await page.locator(".fill-row").count(), 1);
  await page.selectOption("#source", "live");
  assert.equal(await page.locator("#source").inputValue(), "demo");
  await page.locator("#pause").click();
  const paused = await page.locator("#countdown").textContent();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator("#countdown").textContent(), paused);
  assert.equal(await page.locator("#buy-up").isDisabled(), true);
  await page.locator("#pause").click();
  await page.locator("#book-down").click();
  assert.equal(
    await page.locator("#book-down").getAttribute("aria-pressed"),
    "true",
  );
  await page.locator("#settings").click();
  assert.equal(
    await page.locator("#settings-dialog").evaluate((d) => d.open),
    true,
  );
  await page.locator("#paths").selectOption("240");
  assert.equal(await page.locator("#path-count").textContent(), "240");
  assert.equal(await page.locator("#sample-grid i").count(), 240);
  await page.locator("#reset-session").click();
  assert.equal(await page.locator("#balance").textContent(), "$1,000.00");
  await page.locator("#settings-form").evaluate((f) => f.requestSubmit());
  await page.locator("#buy-down").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /desk-paper-fills/);
  await page.clock.runFor(181_000);
  assert.equal(await page.locator("#positions").textContent(), "0");
  assert.equal((await page.locator("#pnl").textContent()) === "+$0.00", false);
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      dimensions.scroll <= dimensions.width,
      `overflow at ${width}: ${JSON.stringify(dimensions)}`,
    );
    if (width === 390)
      await page.screenshot({ path: "/tmp/desk-mobile.png", fullPage: true });
  }
  await page.clock.resume();
  await page.routeWebSocket("wss://ws-feed.exchange.coinbase.com", (ws) => {
    ws.onMessage((message) => {
      const data = JSON.parse(message);
      assert.equal(data.channels[0], "ticker");
      ws.send(
        JSON.stringify({
          type: "ticker",
          product_id: "BTC-USD",
          price: "101234.56",
        }),
      );
    });
  });
  await page.selectOption("#source", "live");
  await page.waitForFunction(
    () => document.querySelector("#price").textContent === "$101,234.56",
  );
  assert.equal(await page.locator("#buy-up").isDisabled(), true);
  await page.clock.runFor(11_000);
  assert.match(await page.locator("#tick-age").textContent(), /STALE/);
  assert.equal(await page.locator("#price").textContent(), "$101,234.56");
  await page.selectOption("#source", "demo");
  assert.match(await page.locator("#spot-source").textContent(), /DEMO/);
  await page.locator("#about").click();
  assert.equal(
    await page.locator("#about-dialog").evaluate((d) => d.open),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#about-dialog").evaluate((d) => d.open),
    false,
  );
  assert.deepEqual(errors, []);
  const livePage = await browser.newPage();
  await livePage.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window);
    window.__deskFrames = 0;
    window.requestAnimationFrame = (callback) => {
      window.__deskFrames++;
      return original(callback);
    };
  });
  await livePage.route("http://desk.test/**", async (route) => {
    const n = new URL(route.request().url()).pathname.slice(1) || "index.html";
    await route.fulfill({
      body: await fs.readFile(`${root}/dist/${n}`),
      contentType: n.endsWith(".js")
        ? "text/javascript"
        : n.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
  });
  await livePage.goto("http://desk.test/");
  await livePage.locator("#workspace-legacy").click();
  await livePage.bringToFront();
  await livePage.waitForFunction(
    () => document.querySelector("#market-chart").dataset.motion === "running",
  );
  const canvasBefore = await livePage
    .locator("#market-chart")
    .evaluate((c) => c.toDataURL());
  await livePage.waitForTimeout(150);
  const canvasAfter = await livePage
    .locator("#market-chart")
    .evaluate((c) => c.toDataURL());
  assert.notEqual(
    canvasBefore,
    canvasAfter,
    "ambient animation produces distinct frames",
  );
  await livePage.locator("#pause").click();
  await livePage.waitForTimeout(100);
  const pausedBefore = await livePage
    .locator("#market-chart")
    .evaluate((c) => c.toDataURL());
  await livePage.waitForTimeout(150);
  assert.equal(
    await livePage.locator("#market-chart").evaluate((c) => c.toDataURL()),
    pausedBefore,
    "pause freezes chart pixels",
  );
  await livePage.locator("#pause").click();
  await livePage.locator("#settings").click();
  await livePage.locator("#motion-toggle").uncheck();
  await livePage.waitForTimeout(100);
  const stoppedFrames = await livePage.evaluate(() => window.__deskFrames);
  await livePage.waitForTimeout(180);
  assert.equal(
    await livePage.evaluate(() => window.__deskFrames),
    stoppedFrames,
    "motion toggle stops frame scheduling",
  );
  await livePage.locator("#motion-toggle").check();
  await livePage.locator("#settings-dialog .close-dialog").click();
  await livePage.emulateMedia({ reducedMotion: "reduce" });
  await livePage.waitForTimeout(100);
  const reducedFrames = await livePage.evaluate(() => window.__deskFrames);
  await livePage.waitForTimeout(180);
  assert.equal(
    await livePage.evaluate(() => window.__deskFrames),
    reducedFrames,
    "reduced-motion stops frame scheduling",
  );
  assert.equal(
    await livePage.locator("#market-chart").getAttribute("data-motion"),
    "reduced",
  );
  await livePage.emulateMedia({ reducedMotion: "no-preference" });
  await livePage.screenshot({
    path: "/tmp/desk-cinematic-desktop.png",
    fullPage: true,
  });
  await livePage.setViewportSize({ width: 390, height: 950 });
  await livePage.screenshot({
    path: "/tmp/desk-cinematic-mobile.png",
    fullPage: true,
  });
  if (process.env.DESK_LIVE_SMOKE === "1") {
    await livePage.selectOption("#source", "live");
    await livePage.waitForFunction(
      () =>
        document.querySelector("#connection").textContent ===
        "COINBASE BTC-USD CONNECTED",
      {},
      { timeout: 18000 },
    );
    console.log(
      "REAL_BROWSER_LIVE_PRICE " +
        (await livePage.locator("#price").textContent()),
    );
  } else {
    console.log("SKIP real Coinbase smoke: set DESK_LIVE_SMOKE=1 to opt in");
  }
  await livePage.close();
  console.log(
    JSON.stringify({
      result: "PASS",
      consoleErrors: errors,
      checks: [
        "cinematic chart animation produces distinct frames",
        "pause freezes chart pixels",
        "motion toggle stops animation scheduling",
        "system reduced-motion stops animation scheduling",
        "sample distribution counts and settings",
        "288 windows",
        "paper fill cash",
        "source-switch guard",
        "pause/resume",
        "order-book side",
        "settings and path count",
        "session reset",
        "CSV download",
        "window settlement",
        "responsive 320/390/768/1024/1440",
        "mock live ticker",
        "stale live feed retains last price",
        "demo recovery",
        "dialog keyboard close",
      ],
      screenshots: ["/tmp/desk-desktop.png", "/tmp/desk-mobile.png"],
    }),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
