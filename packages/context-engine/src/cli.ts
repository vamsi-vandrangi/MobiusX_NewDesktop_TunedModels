#!/usr/bin/env node
import { resolve } from "node:path";
import { reconcile } from "./tree.js";
import { watch } from "./watcher.js";
import { loadSnapshot, saveSnapshot } from "./snapshot-store.js";

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function cmdScan(dir: string) {
  const previous = await loadSnapshot(dir);
  const { snapshot, stats } = await reconcile(dir, previous);
  await saveSnapshot(dir, snapshot);

  console.log(previous ? "Incremental reconcile" : "Cold scan (no previous snapshot)");
  console.log(`  root         ${dir}`);
  console.log(`  rootHash     ${snapshot.rootHash.slice(0, 16)}…`);
  console.log(`  dirs walked  ${stats.dirsWalked} (of ${stats.totalDirs} total)`);
  console.log(`  files total  ${stats.totalFiles}`);
  console.log(`  hashed       ${stats.filesHashed}  (content actually read)`);
  console.log(`  cache hits   ${stats.filesSkippedCached}  (size+mtime matched, content skipped)`);
  console.log(`  removed      ${stats.removedPaths.length}`);
  console.log(`  unchanged?   ${stats.unchanged}`);
  console.log(`  duration     ${fmtMs(stats.durationMs)}`);
  if (stats.changedPaths.length) {
    console.log(`  changed (first 10 of ${stats.changedPaths.length}):`);
    for (const p of stats.changedPaths.slice(0, 10)) console.log(`    ${p}`);
  }
}

async function cmdBench(dir: string) {
  console.log(`Benchmarking ${dir}\n`);

  const cold = await reconcile(dir, null);
  console.log("Pass 1 — cold (no cache, every file hashed):");
  console.log(
    `  ${cold.stats.totalFiles} files / ${cold.stats.totalDirs} dirs, ` +
      `hashed ${cold.stats.filesHashed}, ${fmtMs(cold.stats.durationMs)}\n`,
  );

  const warm = await reconcile(dir, cold.snapshot);
  console.log("Pass 2 — warm (nothing changed on disk between passes):");
  console.log(
    `  ${warm.stats.totalFiles} files / ${warm.stats.totalDirs} dirs, ` +
      `hashed ${warm.stats.filesHashed}, cache hits ${warm.stats.filesSkippedCached}, ` +
      `${fmtMs(warm.stats.durationMs)}`,
  );
  console.log(`  rootHash unchanged: ${warm.stats.unchanged}\n`);

  console.log(
    `Speedup from content-hash caching: ${(cold.stats.durationMs / Math.max(warm.stats.durationMs, 1)).toFixed(1)}x`,
  );
  console.log(
    "Note: both passes still walk every directory (dirsWalked == totalDirs) — that cost only",
  );
  console.log(
    "disappears on the live watch path below, which updates just the changed leaf + its ancestors.",
  );
}

async function cmdWatch(dir: string) {
  let snapshot = await loadSnapshot(dir);
  if (!snapshot) {
    console.log("No snapshot yet — running an initial scan first...");
    const built = await reconcile(dir, null);
    snapshot = built.snapshot;
    await saveSnapshot(dir, snapshot);
  }
  console.log(`Watching ${dir} (rootHash ${snapshot.rootHash.slice(0, 16)}…). Ctrl+C to stop.\n`);

  const handle = watch(dir, snapshot, (result) => {
    console.log(
      `[${result.kind}] ${result.path} — touched ${result.ancestorsTouched.length} ancestor dir(s), ` +
        `rootHash ${result.rootHashBefore.slice(0, 8)}… -> ${result.rootHashAfter.slice(0, 8)}…`,
    );
  });

  process.on("SIGINT", async () => {
    await handle.close();
    process.exit(0);
  });
}

async function main() {
  const [, , command, rawDir] = process.argv;
  const dir = resolve(rawDir ?? ".");

  switch (command) {
    case "scan":
      return cmdScan(dir);
    case "bench":
      return cmdBench(dir);
    case "watch":
      return cmdWatch(dir);
    default:
      console.log("Usage: mobiusx-index <scan|bench|watch> <directory>");
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
