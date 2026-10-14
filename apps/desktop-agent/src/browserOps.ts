import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Browser, ConsoleMessage, Page, Request as PWRequest, Response as PWResponse } from "playwright";
import type { BrowserValidationResponse, BrowserValidationStep } from "@mobiusx/protocol";
import { getPreviewStatus } from "./previewOps.js";

const NAV_TIMEOUT_MS = 20_000;
const MAX_CONSOLE_ERRORS = 20;
const MAX_NETWORK_ERRORS = 20;
const MAX_OUTPUT_CHARS = 4000; // same bounded-response discipline as verify.ts's MAX_OUTPUT_CHARS
const MAX_LINKS_TO_VISIT = 5; // bounded "click through flows" -- only real same-origin links actually found in the rendered DOM, never invented
const SCREENSHOT_JPEG_QUALITY = 50;
const require = createRequire(import.meta.url);

/**
 * Browser Validation is an explicit user action, so provision Playwright's
 * matching Chromium build on first use when npm installed the package but
 * its separate browser download is missing. Invoke the installed Playwright
 * CLI by absolute path (no shell or PATH guesswork), then verify the exact
 * executable Playwright will launch exists before retrying.
 */
async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (firstError) {
    const executable = chromium.executablePath();
    const message = (firstError as Error).message;
    const missingBrowser = /Executable doesn't exist|Executable not found|browserType\.launch.*executable/i.test(message);
    // In headless mode Chromium launches the separate headless-shell binary;
    // chromium.executablePath() can still exist while that shell is missing.
    const missingPath = message.match(/Executable doesn't exist at ([^\r\n]+)/i)?.[1]?.trim();
    if (!missingBrowser || (missingPath ? existsSync(missingPath) : existsSync(executable))) throw firstError;

    const playwrightPackage = require.resolve("playwright/package.json");
    const cliPath = join(dirname(playwrightPackage), "cli.js");
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [cliPath, "install", "chromium"], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const details = `${stdout}\n${stderr}`.trim().slice(-2400);
          reject(new Error(`Playwright Chromium is missing and automatic installation failed: ${error.message}${details ? `\n${details}` : ""}. You can retry with: npx playwright install chromium`));
          return;
        }
        resolve();
      });
    });
    if (!existsSync(executable)) {
      throw new Error(`Playwright install completed but its Chromium executable is still missing at ${executable}. Retry with: npx playwright install chromium`);
    }
    return chromium.launch({ headless: true });
  }
}

/**
 * Roadmap Phase 12 (Browser / Application Validation, source requirement
 * §18): drives the ALREADY-RUNNING preview (previewOps.ts) with a real
 * headless browser and reports genuine evidence -- console errors, failed
 * network requests, and a screenshot -- for the preview's landing page
 * plus a bounded set of real same-origin links actually found in its
 * rendered DOM ("click through flows" without inventing any flow: only
 * hrefs a real user would actually see get followed). Never fabricates a
 * result: if no preview is running yet, or it hasn't reported a URL, this
 * returns overall: "no-preview-running" with an honest reason instead of
 * pretending to validate anything.
 */
export async function runBrowserValidation(projectPath: string): Promise<BrowserValidationResponse> {
  const status = getPreviewStatus();
  const frontend = status.frontend;
  if (!frontend || frontend.status !== "running" || !frontend.url) {
    return {
      projectPath,
      previewUrl: null,
      previewUnavailableReason: !frontend
        ? "No preview has been started for this project — click Start Preview first."
        : frontend.status !== "running"
          ? `Preview frontend is not running yet (status: ${frontend.status}) — wait for it to finish starting.`
          : "Preview frontend is running but hasn't reported a URL yet.",
      overall: "no-preview-running",
      steps: [],
    };
  }

  const rootUrl = frontend.url;
  const steps: BrowserValidationStep[] = [];
  let browser: Browser | null = null;
  try {
    browser = await launchChromium();
    const page = await browser.newPage();
    steps.push(await visitOne(page, rootUrl, `Open ${rootUrl}`));

    const links = await discoverSameOriginLinks(page, rootUrl, MAX_LINKS_TO_VISIT);
    for (const link of links) {
      steps.push(await visitOne(page, link, `Open ${link}`));
    }
    await page.close();
  } catch (err) {
    steps.push({
      id: randomUUID(),
      label: "Launch browser",
      command: "playwright: chromium.launch",
      status: "failed",
      url: rootUrl,
      consoleErrors: [],
      networkErrors: [],
      output: `Failed to launch or drive the headless browser: ${(err as Error).message}`,
      durationMs: 0,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const overall: BrowserValidationResponse["overall"] = steps.length > 0 && steps.every((s) => s.status === "passed") ? "passed" : "failed";
  return { projectPath, previewUrl: rootUrl, overall, steps };
}

/**
 * Only real, same-origin `<a href>` targets actually present in the
 * landing page's rendered DOM after it loaded -- collected from the live
 * page (not guessed from route conventions), and bounded to `max` so a
 * project with hundreds of links doesn't turn one validation run into an
 * unbounded crawl.
 */
async function discoverSameOriginLinks(page: Page, rootUrl: string, max: number): Promise<string[]> {
  try {
    const root = new URL(rootUrl);
    const rootKey = root.origin + root.pathname + root.search;
    const hrefs: string[] = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const href of hrefs) {
      let u: URL;
      try {
        u = new URL(href);
      } catch {
        continue; // not a real absolute URL -- skip rather than guess one
      }
      if (u.origin !== root.origin) continue; // real evidence only -- never follow off-site links
      if (!/^https?:$/.test(u.protocol)) continue;
      const key = u.origin + u.pathname + u.search;
      if (key === rootKey || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function visitOne(page: Page, url: string, label: string): Promise<BrowserValidationStep> {
  const start = Date.now();
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  let pageError: string | null = null;

  const onConsole = (msg: ConsoleMessage) => {
    const t = msg.type();
    if ((t === "error" || t === "warning") && consoleErrors.length < MAX_CONSOLE_ERRORS) {
      consoleErrors.push(`[${t}] ${msg.text()}`);
    }
  };
  const onPageError = (err: Error) => {
    pageError = err.message;
  };
  const onResponse = (resp: PWResponse) => {
    if (resp.status() >= 400 && networkErrors.length < MAX_NETWORK_ERRORS) {
      networkErrors.push(`${resp.status()} ${resp.request().method()} ${resp.url()}`);
    }
  };
  const onRequestFailed = (req: PWRequest) => {
    if (networkErrors.length < MAX_NETWORK_ERRORS) {
      networkErrors.push(`FAILED ${req.method()} ${req.url()} (${req.failure()?.errorText ?? "unknown error"})`);
    }
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  let status: BrowserValidationStep["status"] = "passed";
  let navError: string | null = null;
  let screenshot: string | undefined;
  try {
    await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "load" });
    // A brief, real observed pause -- gives client-rendered errors (React/Vue
    // mount failures, etc.) a moment to actually surface as console/pageerror
    // events before we capture evidence, not a fabricated wait for content.
    await page.waitForTimeout(500);
    const buf = await page.screenshot({ type: "jpeg", quality: SCREENSHOT_JPEG_QUALITY, fullPage: false });
    screenshot = `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch (err) {
    const msg = (err as Error).message;
    const timedOut = /Timeout/i.test(msg);
    navError = timedOut ? `Navigation timed out after ${NAV_TIMEOUT_MS}ms: ${msg}` : msg;
    status = timedOut ? "timed_out" : "failed";
  }

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  page.off("response", onResponse);
  page.off("requestfailed", onRequestFailed);

  if (status === "passed" && (consoleErrors.length > 0 || networkErrors.length > 0 || pageError)) {
    status = "failed"; // real captured evidence, not a guess -- an error observed on the page IS a failure for this step
  }

  const parts: string[] = [];
  if (navError) parts.push(`Navigation error: ${navError}`);
  if (pageError) parts.push(`Uncaught page error: ${pageError}`);
  if (consoleErrors.length > 0) parts.push(`Console errors/warnings:\n${consoleErrors.join("\n")}`);
  if (networkErrors.length > 0) parts.push(`Failed network requests:\n${networkErrors.join("\n")}`);
  let output = parts.length > 0 ? parts.join("\n\n") : "No console errors, page errors, or failed network requests observed.";
  if (output.length > MAX_OUTPUT_CHARS) output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;

  return {
    id: randomUUID(),
    label,
    command: `Navigate to ${url}`,
    status,
    url,
    consoleErrors,
    networkErrors,
    output,
    screenshot,
    durationMs: Date.now() - start,
  };
}
