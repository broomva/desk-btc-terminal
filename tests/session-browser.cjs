// Browser/API integration with real server and a local generated wire fixture.
// This test makes no claim of real market performance. test:live uses Kraken.
const { chromium } = require("playwright-core");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-session-browser-"));
  const child = spawn(
    "bun",
    [
      "--eval",
      `import {createDeskServer} from './server/index.js'; import {checksum} from './server/market.js'; const app=createDeskServer({port:0,dataDir:${JSON.stringify(dir)},connect:false}); console.log(app.server.url.href); const timer=setInterval(()=>{const bids=[{price:'100.0',qty:'2.00000000'}],asks=[{price:'100.1',qty:'1.00000000'}]; app.ingest(JSON.stringify({channel:'book',type:'snapshot',data:[{symbol:'BTC/USD',bids,asks,checksum:checksum(asks,bids),timestamp:new Date().toISOString()}]}));},250); process.on('SIGTERM',()=>{clearInterval(timer);app.stop();process.exit(0)});`,
    ],
    { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "inherit"] },
  );
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      child.stdout.once("data", (d) => resolve(String(d).trim()));
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Server exited ${code}`)));
    });
    browser = await chromium.launch({
      executablePath: process.env.DESK_CHROME,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.locator("#research-source").selectOption("live");
    await page.waitForFunction(
      () => !document.querySelector("#record-toggle").disabled,
    );
    await page.locator("#capture-minutes").selectOption("0.25");
    await page.locator("#capture-purpose").selectOption("evaluation");
    await page.locator("#paper-fee").fill("12");
    await page.locator("#record-toggle").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#capture-health")
        .textContent.includes("RECORDING"),
    );
    assert.equal(await page.locator("#capture-purpose").isDisabled(), true);
    await page
      .locator("#capture-plan")
      .screenshot({ path: "/tmp/desk-bounded-capture.png" });
    await page.waitForFunction(
      () =>
        document
          .querySelector("#capture-health")
          .textContent.includes("duration limit"),
      {},
      { timeout: 25000 },
    );
    assert.equal(await page.locator("#capture-purpose").isDisabled(), false);
    const listings = await (
      await fetch(new URL("/api/recordings", base))
    ).json();
    const session = listings.recordings[0];
    assert.equal(session.active, false);
    assert.ok(session.bytes <= 48 * 1024 ** 2);
    await page.locator("#research-source").selectOption("replay");
    await page.waitForFunction(
      () => document.querySelector("#recording-select").options.length > 1,
    );
    await page.locator("#recording-select").selectOption(session.id);
    await page.waitForFunction(() =>
      document.querySelector("#replay-name").textContent.includes("events"),
    );
    assert.equal(await page.locator("#paper-fee").inputValue(), "12");
    await page.locator("#paper-run").click();
    await page.waitForFunction(
      () => !document.querySelector("#paper-results").hidden,
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#history-rows > details").length === 1,
    );
    assert.match(
      await page.locator("#history-rows").textContent(),
      /DECLARED EVALUATION/,
    );
    assert.match(await page.locator("#history-rows").textContent(), /NO FILLS/);
    const exportWait = page.waitForEvent("download");
    await page.locator("#paper-export").click();
    const exported = await exportWait;
    const receipt = JSON.parse(
      await fs.readFile(await exported.path(), "utf8"),
    );
    assert.equal(receipt.input.metadata.experiment.paperConfig.makerFeeBps, 12);
    assert.equal(
      receipt.input.metadata.endReason,
      "Recording duration limit reached",
    );
    await fs.writeFile(
      path.join(dir, "paper-receipt.json"),
      JSON.stringify(receipt),
    );
    await page.reload();
    assert.equal(await page.locator("#history-rows > details").count(), 1);
    await page.locator("#history-rows > details > summary").first().click();
    await page
      .locator("#history-rows")
      .screenshot({ path: "/tmp/desk-session-results.png" });
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `overflow ${width}`,
      );
    }
    // Concurrent same-origin tabs must never overwrite a successful save.
    const second = await page.context().newPage();
    await second.goto(base);
    const saves = await Promise.all(
      [page, second].map((tab, i) =>
        tab.evaluate(async (i) => {
          const { saveExperimentLocked, readExperiments } = await import(
            "/experiment-results.js"
          );
          const original = readExperiments(localStorage)[0];
          const storage = {
            getItem(key) {
              const prior = localStorage.getItem(key);
              localStorage.setItem(`race-ready-${i}`, "yes");
              const until = Date.now() + 500;
              while (
                !localStorage.getItem(`race-ready-${1 - i}`) &&
                Date.now() < until
              ) {
                /* force overlapping readers if the lock is removed */
              }
              return prior;
            },
            setItem(key, text) {
              localStorage.setItem(key, text);
            },
          };
          return saveExperimentLocked(
            { ...original, key: `concurrent-${i}` },
            storage,
            navigator.locks,
          );
        }, i),
      ),
    );
    assert.equal(Math.max(...saves.map((rows) => rows.length)), 3);
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("desk-paper-history-v1")).length,
      ),
      3,
    );
    await second.close();
    const raw = await (
      await fetch(new URL(`/api/recordings/${session.id}`, base))
    ).text();
    const lines = raw.trim().split("\n");
    const header = JSON.parse(lines[0]);
    header.experiment.purpose = { unexpected: true };
    lines[0] = JSON.stringify(header);
    await page.locator("#research-source").selectOption("replay");
    await page.locator("#recording-file").setInputFiles({
      name: "invalid-purpose.ndjson",
      mimeType: "application/x-ndjson",
      buffer: Buffer.from(lines.join("\n")),
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#replay-name")
        .textContent.includes("invalid-purpose"),
    );
    await page.locator("#paper-run").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#history-rows > details").length === 4,
    );
    assert.match(
      await page.locator("#history-rows > details").first().textContent(),
      /UNASSIGNED.*EXPLORATORY/,
    );
    assert.match(
      await page.locator("#history-rows > details").first().textContent(),
      /INVALID CAPTURE PURPOSE/,
    );
    await page.reload();
    assert.equal(await page.locator("#history-rows > details").count(), 4);

    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(dir, "browser-receipt.json"),
      JSON.stringify(
        {
          passed: true,
          sessionId: session.id,
          bytes: session.bytes,
          purpose: "evaluation",
          errors,
          screenshots: [
            "/tmp/desk-bounded-capture.png",
            "/tmp/desk-session-results.png",
          ],
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, dir, sessionId: session.id }));
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
