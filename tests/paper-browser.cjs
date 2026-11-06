const { chromium } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const { paperFixture } = await import("../dist/paper-fixture.js");
  const { runPaperExperiment } = await import("../dist/paper-engine.js");
  const fixture = paperFixture();
  const raw = [{ type: "session", ...fixture.metadata }, ...fixture.events]
    .map(JSON.stringify)
    .join("\n");
  const compact = [
    { type: "session", replaySampling: { tradeSampleMs: 10000 } },
    fixture.books[0],
  ]
    .map(JSON.stringify)
    .join("\n");
  const browser = await chromium.launch({
    executablePath: process.env.DESK_CHROME,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("http://localhost:5187/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/recordings")
          return route.fulfill({ json: { recordings: [] } });
        return route.fulfill({
          json: {
            book: { valid: false, bids: [], asks: [] },
            history: [],
            trades: [],
            status: { connected: false, recording: false },
          },
        });
      }
      const name = url.pathname.slice(1) || "index.html";
      return route.fulfill({
        body: await fs.readFile(path.join(__dirname, "../dist", name)),
        contentType: name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : "text/html",
      });
    });
    await page.goto("http://localhost:5187/");
    await page.locator("#paper-run").click();
    await page.waitForFunction(
      () => !document.querySelector("#paper-results").hidden,
    );
    assert.match(
      await page.locator("#paper-status").textContent(),
      /SYNTHETIC PAPER FIXTURE/,
    );
    assert.equal(await page.locator("#paper-summary tr").count(), 3);
    const download = page.waitForEvent("download");
    await page.locator("#paper-export").click();
    const result = await download;
    const data = JSON.parse(await fs.readFile(await result.path(), "utf8"));
    assert.equal(data.inputSha256.length, 64);
    const reproduced = runPaperExperiment(data.input, data.result.config);
    assert.deepEqual(reproduced, data.result);
    assert.ok(data.result.policies[0].fills.length > 0);
    await page
      .getByRole("region", { name: "PAPER EXECUTION LAB" })
      .screenshot({ path: "/tmp/desk-paper-desktop.png" });
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `overflow ${width}`,
      );
      if (width === 390)
        await page
          .getByRole("region", { name: "PAPER EXECUTION LAB" })
          .screenshot({ path: "/tmp/desk-paper-mobile.png" });
    }
    await page.locator("#paper-fee").fill("");
    await page.locator("#paper-run").click();
    assert.match(
      await page.locator("#paper-status").textContent(),
      /blank fields are not zero/,
    );
    assert.equal(await page.locator("#paper-run").isDisabled(), false);
    await page.locator("#paper-fee").fill("100");
    assert.equal(await page.locator("#paper-results").isVisible(), false);
    assert.equal(await page.locator("#paper-export").isDisabled(), true);
    await page.locator("#paper-run").click();
    await page.waitForFunction(
      () => !document.querySelector("#paper-results").hidden,
    );
    const download2 = page.waitForEvent("download");
    await page.locator("#paper-export").click();
    const higherFee = JSON.parse(
      await fs.readFile(await (await download2).path(), "utf8"),
    );
    assert.ok(
      higherFee.result.policies[0].metrics.pnl <
        data.result.policies[0].metrics.pnl,
    );
    await page.selectOption("#research-source", "live");
    await page.locator("#paper-run").click();
    assert.match(
      await page.locator("#paper-status").textContent(),
      /live display is sampled/,
    );
    await page.selectOption("#research-source", "replay");
    await page.locator("#recording-file").setInputFiles({
      name: "compact.ndjson",
      mimeType: "application/x-ndjson",
      buffer: Buffer.from(compact),
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#replay-name")
        .textContent.includes("compact.ndjson"),
    );
    await page.locator("#paper-run").click();
    assert.match(
      await page.locator("#paper-status").textContent(),
      /Compact replay drops trades/,
    );
    await page.locator("#recording-file").setInputFiles({
      name: "raw.ndjson",
      mimeType: "application/x-ndjson",
      buffer: Buffer.from(raw),
    });
    await page.waitForFunction(() =>
      document.querySelector("#replay-name").textContent.includes("raw.ndjson"),
    );
    await page.locator("#paper-run").click();
    await page.waitForFunction(
      () => !document.querySelector("#paper-results").hidden,
    );
    await page.locator("#replay-position").fill("100");
    assert.equal(await page.locator("#paper-results").isVisible(), false);
    assert.deepEqual(errors, []);
    await fs.writeFile(
      "/tmp/desk-paper-browser-receipt.json",
      JSON.stringify({
        result: "PASS",
        exportedReproduction: true,
        partialFills: data.result.policies.map((p) => p.fills.length),
        widths: [320, 390, 768, 1024, 1440],
        errors,
      }),
    );
    console.log(
      "PASS paper browser: click, deterministic export/rerun, fee sensitivity, invalidation, compact refusal, raw import, mobile",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
