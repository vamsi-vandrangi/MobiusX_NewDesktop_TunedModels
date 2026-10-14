"use strict";

// Node's own built-in "net" module -- deliberately a separate require in
// this separate file, not reused from main.js (which already has a module-
// scoped `net` of its own, destructured from "electron" at the top of that
// file -- Electron's net is a Chromium-backed HTTP client, a completely
// different API from Node's socket-level net.connect() this module needs).
// Keeping the port scanner in its own file avoids that name clash entirely
// rather than aliasing around it inside main.js.
const net = require("net");

/**
 * Oct 2026 addition: a lightweight, Main-process, Node `net`-module port
 * scanner across the standard dev-server ranges requested -- 3000-3005 for
 * Next.js, 8000-8005 for FastAPI/uvicorn.
 *
 * This is DELIBERATELY wired as an ADDITIVE diagnostic signal only -- it
 * never sets a service's status to "running" and never drives
 * previewOps.ts's own state machine (see that file's startService). That
 * file's spawnRunPhase() already discovers the real port a dev server
 * bound -- which can genuinely be 3001, 3002, etc. (Next.js falls back
 * when 3000 is already taken, see previewWatcher.js's own comment on
 * this) -- straight from the spawned process's own stdout, and
 * deliberately does NOT treat "a port exists" as a readiness signal on
 * its own: previewOps.ts documents a confirmed live bug where a crashed
 * backend's ImportError traceback got reported as "running" purely
 * because state.port had already been pre-seeded before status was
 * decoupled from port presence. A fixed-range scanner that was allowed to
 * set run status itself would reintroduce exactly that shape of risk --
 * any unrelated process already bound to, say, 8000 (this app's own
 * previous run that didn't exit cleanly, or something else on the
 * machine entirely) would read as "your backend is running" with zero
 * connection to the actual process this app spawned.
 *
 * So this module answers a narrower, genuinely useful question instead:
 * "which of the ports in the ranges you'd expect a dev server on are
 * actually accepting TCP connections right now" -- surfaced to the
 * renderer as an honest, clearly-labeled diagnostic line, never as the
 * authoritative run status. That stays previewOps.ts's text-based
 * detection, polled by previewWatcher.js, completely unchanged by this
 * file.
 */
const DEFAULT_PORTS = [3000, 3001, 3002, 3003, 3004, 3005, 8000, 8001, 8002, 8003, 8004, 8005];
const SCAN_INTERVAL_MS = 4000;
const CONNECT_TIMEOUT_MS = 300;

function probePort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ port, host });
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false)); // most common case: ECONNREFUSED, nothing listening
  });
}

function startPortScanWatcher(mainWindow, ports = DEFAULT_PORTS) {
  let lastOpenSerialized = "";
  let stopped = false;

  async function scan() {
    if (stopped || mainWindow.isDestroyed()) return;
    const results = await Promise.all(ports.map((p) => probePort(p)));
    if (stopped || mainWindow.isDestroyed()) return; // window may have closed mid-scan
    const openPorts = ports.filter((_, i) => results[i]);
    const serialized = JSON.stringify(openPorts);
    if (serialized === lastOpenSerialized) return; // no change -- don't spam IPC
    lastOpenSerialized = serialized;
    mainWindow.webContents.send("port-scan:update", {
      openPorts,
      scannedRanges: { frontend: [3000, 3005], backend: [8000, 8005] },
    });
  }

  scan(); // don't make the first result wait a full interval
  const timer = setInterval(scan, SCAN_INTERVAL_MS);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  mainWindow.on("closed", stop);
  return stop;
}

module.exports = { startPortScanWatcher, probePort, DEFAULT_PORTS };
