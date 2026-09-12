// Live path of the pipeline in TDD Fig. 2: OS file-system events feed
// applyChange() directly, so each edit costs O(depth) rather than a fresh
// full walk. This is the piece a periodic reconcile() (every ~10 min, per
// the TDD) exists to backstop — for events missed while the watcher wasn't
// running, or changes (renames, brand-new directories) applyChange()
// deliberately declines to guess at.
import chokidar, { type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import { applyChange } from "./tree.js";
import { saveSnapshot } from "./snapshot-store.js";
import type { ApplyChangeResult, Snapshot } from "./types.js";
import { DEFAULT_IGNORE } from "./types.js";

export interface WatchHandle {
  close(): Promise<void>;
}

export function watch(
  rootDir: string,
  snapshot: Snapshot,
  onChange: (result: ApplyChangeResult) => void,
  ignore: Set<string> = DEFAULT_IGNORE,
): WatchHandle {
  const watcher: FSWatcher = chokidar.watch(rootDir, {
    ignored: (path) => {
      const rel = relative(rootDir, path);
      return rel.split(/[\\/]/).some((seg) => ignore.has(seg));
    },
    ignoreInitial: true,
    persistent: true,
  });

  let saveQueue: Promise<void> = Promise.resolve();
  const queueSave = () => {
    saveQueue = saveQueue.then(() => saveSnapshot(rootDir, snapshot));
  };

  const handleEvent = (kind: "add" | "change" | "unlink") => (absPath: string) => {
    const relPath = relative(rootDir, absPath).split(sep).join("/");
    applyChange(snapshot, rootDir, relPath, kind)
      .then((result) => {
        queueSave();
        onChange(result);
      })
      .catch((err) => {
        // A path applyChange() can't resolve incrementally (new nested dir,
        // race with a fast rename) is not fatal — the next reconcile() pass
        // will pick it up. Surface it as a change event with no ancestors
        // touched so the caller can decide whether to trigger an early
        // reconcile rather than waiting for the timer.
        onChange({
          path: relPath,
          kind,
          ancestorsTouched: [],
          rootHashBefore: snapshot.rootHash,
          rootHashAfter: snapshot.rootHash,
        });
      });
  };

  watcher.on("add", handleEvent("add"));
  watcher.on("change", handleEvent("change"));
  watcher.on("unlink", handleEvent("unlink"));

  return {
    async close() {
      await saveQueue;
      await watcher.close();
    },
  };
}
