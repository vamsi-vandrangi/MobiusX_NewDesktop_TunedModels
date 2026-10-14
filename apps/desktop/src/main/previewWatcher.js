"use strict";

const POLL_INTERVAL_MS = 1000;

/**
 * Security-hardening pass, item 2 ("sandbox-compliant IPC bridge"): the
 * sandboxed renderer must not be the thing doing "is the dev server up yet"
 * network checks. This module polls desktop-agent's own GET /preview/status
 * from here -- real, privileged Node running in Electron's main process,
 * never inside the sandboxed BrowserWindow -- and pushes IPC events to the
 * renderer only when something actually changed.
 *
 * This does NOT spawn, own, or duplicate any dev server. previewOps.ts
 * (desktop-agent, started by startAgent() in main.js) remains the ONLY
 * place that calls child_process.spawn for `npm run dev` / `uvicorn ...`;
 * running a second spawner here, driven straight off child_process in the
 * main process as a literal copy of that logic, would fight the existing
 * one for the same ports, duplicate the auto-install/log-capture work
 * previewOps.ts already does correctly, and orphan the Start/Stop/log
 * plumbing already built around it. This module only *observes* that
 * already-correct process manager's reported state and relays it over IPC.
 *
 * agentBaseUrl/agentToken are exactly what main.js already computed for
 * createWindow()'s own --mobiusx-agent flag (see startAgent()'s resolved
 * {port, token}) -- this watcher calls the same desktop-agent, with the
 * same bearer token, as the renderer's own api() helper does for every
 * other endpoint; it just removes the "poll on a timer" responsibility
 * from the sandboxed window for this one feature.
 */
/**
 * Oct 2026 addition: live dev-server console streaming. previewOps.ts's
 * appendLog() already captures every stdout/stderr chunk from the spawned
 * `npm run dev` / `uvicorn` processes into RunningService.log (capped at
 * MAX_LOG_LINES=300) -- it just wasn't being pushed to the renderer except
 * as part of the full statusChange payload. This diffs each poll's
 * {frontend,backend}.log array against what was last sent, per kind, and
 * pushes only the NEW lines over a dedicated "terminal:log-stream" channel,
 * so the UI can append to a live console instead of re-rendering a growing
 * <pre> from the full array on every single poll tick.
 *
 * The diff is a simple prefix check, not an index counter, because
 * RunningService.log is itself a capped, mutating array on the desktop-agent
 * side: once a service has logged past MAX_LOG_LINES, old lines silently
 * fall off the FRONT while new ones are appended at the back, so "did the
 * length grow" alone is not a safe signal. If the previous array we sent is
 * no longer an exact prefix of the new one -- because of that cap, or
 * because the service was stopped/restarted and previewOps.ts handed back a
 * fresh RunningService with an empty log -- the whole current array is
 * resent rather than guessed at. That's the correct behavior on a restart
 * anyway (the renderer clears its console drawer when the user clicks Start
 * Preview, so a full resend lands as the complete, correct transcript for
 * the new run, not a partial one) and merely a rare, harmless duplicate
 * flush in the overflow case -- never a dropped line.
 */
function diffNewLogLines(prevLines, nextLines) {
  if (!nextLines || nextLines.length === 0) return [];
  const isPrefix = prevLines.length <= nextLines.length && prevLines.every((line, i) => line === nextLines[i]);
  return isPrefix ? nextLines.slice(prevLines.length) : nextLines;
}

function startPreviewWatcher(mainWindow, agentBaseUrl, agentToken) {
  let lastSerialized = null;
  let lastFrontendUrl = null;
  let lastLog = { frontend: [], backend: [] };

  async function poll() {
    if (mainWindow.isDestroyed()) return;
    let status;
    try {
      const res = await fetch(`${agentBaseUrl}/preview/status`, {
        headers: agentToken ? { Authorization: `Bearer ${agentToken}` } : {},
      });
      if (!res.ok) return;
      status = await res.json();
    } catch {
      // desktop-agent not reachable this tick (e.g. it's still starting up,
      // or briefly restarting) -- retried on the next tick. Same
      // silent-retry behavior the renderer's old 2s poll loop had.
      return;
    }

    if (mainWindow.isDestroyed()) return;

    // Log streaming is computed and sent on every tick regardless of
    // whether the rest of the status object changed (see the
    // lastSerialized short-circuit below) -- a dev server can log new
    // output while its own {status, url, command} fields stay identical,
    // and that's exactly the case this feature exists to surface live.
    for (const kind of ["frontend", "backend"]) {
      const nextLines = status[kind]?.log ?? [];
      const newLines = diffNewLogLines(lastLog[kind], nextLines);
      lastLog[kind] = nextLines;
      if (newLines.length > 0) {
        // Debug trace (Oct 2026): visible in this app's Main-process stdout
        // (the terminal `npm start`/`electron .` was launched from, or
        // Console.app on a packaged mac build) -- the single cheapest way to
        // confirm this half of the pipe is actually firing without needing
        // the renderer's own DevTools open. Not spam: only logs on an
        // actual send, same gate as the IPC call itself.
        console.log(`[previewWatcher] terminal:log-stream -> ${kind}: ${newLines.length} new line(s)`);
        mainWindow.webContents.send("terminal:log-stream", {
          kind,
          lines: newLines,
          projectPath: status[kind]?.cwd ?? null,
        });
      }
    }
    if (!status.frontend && !status.backend) lastLog = { frontend: [], backend: [] };

    const serialized = JSON.stringify(status);
    if (serialized === lastSerialized) return; // no other change -- don't spam IPC
    lastSerialized = serialized;

    mainWindow.webContents.send("preview:statusChange", status);

    const frontendUrl = status.frontend?.url ?? null;
    if (status.frontend?.status === "running" && frontendUrl && frontendUrl !== lastFrontendUrl) {
      lastFrontendUrl = frontendUrl;
      // Channel name "project-server:ready" per spec. Payload carries the
      // REAL discovered URL/port (e.g. http://127.0.0.1:3000) rather than a
      // hardcoded 3000 -- Next.js itself falls back to 3001/3002/... when
      // 3000 is already taken (confirmed in next's own CLI source), so
      // hardcoding the port here would make the preview silently point at
      // the wrong server on exactly the machines where this matters most
      // (anyone with something else already bound to 3000).
      mainWindow.webContents.send("project-server:ready", { url: frontendUrl });
    }
    if (!frontendUrl) lastFrontendUrl = null; // preview was stopped/reset -- re-arm for the next run
  }

  const timer = setInterval(poll, POLL_INTERVAL_MS);
  mainWindow.on("closed", () => clearInterval(timer));
  return () => clearInterval(timer);
}

module.exports = { startPreviewWatcher };
