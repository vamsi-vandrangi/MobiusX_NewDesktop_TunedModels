import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { runBrowserValidation } from "../src/browserOps.js";
import { getPreviewStatus, startPreview, stopPreview } from "../src/previewOps.js";

// runBrowserValidation() reads previewOps.ts's own module-level state --
// there's no way to inject a fake "running" preview from the outside, by
// design (previewOps.ts only ever reflects a REAL spawned dev server, see
// its own doc comments). This file runs in its own Node test-runner
// process, so it starts with nothing running.

test("runBrowserValidation reports no-preview-running honestly when nothing has been started", async () => {
  assert.equal(getPreviewStatus().frontend, null); // sanity: fresh process, nothing started
  const result = await runBrowserValidation("/tmp/does-not-matter");
  assert.equal(result.overall, "no-preview-running");
  assert.equal(result.previewUrl, null);
  assert.equal(result.steps.length, 0);
  assert.match(result.previewUnavailableReason ?? "", /Start Preview/);
});

// Real, end-to-end confirmation that runBrowserValidation actually drives a
// headless browser against a REAL running preview (started the same way
// the /preview/start route would) and captures genuine evidence -- skipped
// (not failed) when this environment has no Playwright Chromium binary
// installed, the same discipline verify.test.ts already follows for a
// local pytest install: this codebase never assumes a tool is present just
// to test against it.
//
// The fixture "frontend" is a tiny real Node http server (no external
// dependencies, so previewOps's auto-install step is a no-op once
// node_modules/ exists) that prints its own URL the same way a real dev
// server would, and serves one page with a genuine console.error and a
// genuine same-origin broken link -- so this test is asserting against
// real captured evidence, not a mocked one.
let chromiumAvailable = false;
try {
  const probe = await chromium.launch({ headless: true });
  await probe.close();
  chromiumAvailable = true;
} catch {
  chromiumAvailable = false;
}

test(
  "runBrowserValidation drives a real running preview and captures real console/network evidence (requires Playwright's Chromium binary)",
  { skip: !chromiumAvailable ? "Playwright's Chromium binary is not installed in this environment (npx playwright install chromium)" : false },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mobiusx-browserops-test-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { dev: "node server.js" } }, null, 2));
    await mkdir(join(dir, "node_modules")); // present so previewOps's auto-install step is a no-op -- this fixture has no real deps
    await writeFile(
      join(dir, "server.js"),
      `
      const http = require("node:http");
      const server = http.createServer((req, res) => {
        if (req.url === "/broken-link") {
          res.writeHead(500, { "content-type": "text/html" });
          res.end("<!doctype html><html><body><h1>Broken page</h1></body></html>");
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(\`<!doctype html><html><body>
          <h1>Fixture</h1>
          <a href="/broken-link">Broken link</a>
          <script>console.error("fixture console error");</script>
        </body></html>\`);
      });
      server.listen(0, "127.0.0.1", () => {
        console.log("Local: http://127.0.0.1:" + server.address().port + "/");
      });
      `,
    );

    try {
      startPreview(dir);
      // startPreview() kicks off real async work (spawn + stdout watching
      // for previewOps's URL_RE) -- poll its own honestly-reported status
      // rather than assuming readiness after a fixed delay.
      const deadline = Date.now() + 15_000;
      let frontend = getPreviewStatus().frontend;
      while (frontend?.status !== "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        frontend = getPreviewStatus().frontend;
      }
      assert.equal(frontend?.status, "running", `fixture dev server never reported running (log: ${frontend?.log?.join(" | ")})`);
      assert.ok(frontend?.url);

      const result = await runBrowserValidation(dir);
      assert.equal(result.overall, "failed"); // real console error + real broken link -- genuinely should fail
      assert.equal(result.previewUrl, frontend!.url);
      assert.ok(result.steps.length >= 2); // landing page + the discovered same-origin broken link

      const landing = result.steps[0];
      assert.equal(landing.status, "failed");
      assert.deepEqual(landing.consoleErrors, ["[error] fixture console error"]);
      assert.ok(landing.screenshot?.startsWith("data:image/jpeg;base64,"));

      const brokenLinkStep = result.steps.find((s) => s.url.includes("/broken-link"));
      assert.ok(brokenLinkStep, "the real same-origin broken link found in the landing page's DOM should have been visited");
      assert.equal(brokenLinkStep!.status, "failed");
      assert.ok(brokenLinkStep!.networkErrors.some((e) => e.startsWith("500 ")));
    } finally {
      stopPreview();
    }
  },
);
