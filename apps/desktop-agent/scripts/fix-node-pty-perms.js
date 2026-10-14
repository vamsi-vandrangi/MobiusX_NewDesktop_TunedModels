#!/usr/bin/env node
/**
 * Ensures node-pty's prebuilt native binaries are actually executable.
 *
 * What went wrong (and why this exists): node-pty ships prebuilt binaries
 * per platform+arch under node_modules/node-pty/prebuilds/<platform>-<arch>/
 * (see node_modules/node-pty/lib/utils.js#loadNativeModule) instead of
 * compiling from source when a matching prebuild is found — see
 * node_modules/node-pty/scripts/prebuild.js. That's normally fine, but a
 * plain `npm install` of node-pty can leave those extracted files at mode
 * 644/600 instead of the executable 755 they need: pty.node is require()'d,
 * which doesn't strictly need +x, but spawn-helper is actually exec'd via
 * posix_spawn(2) to fork the shell, and a non-executable spawn-helper makes
 * that syscall fail immediately. That's the exact cause of the desktop
 * terminal's "Failed to start terminal: posix_spawnp failed." error — for
 * BOTH the local shell and a remote `ssh` session, since both go through
 * this same native spawn-helper underneath; it is not PATH- or ssh-specific
 * (an earlier diagnosis in this project briefly assumed it was, blamed a
 * Finder-launched app's impoverished PATH, and shipped a fix that -- while
 * harmless -- didn't address the real failure, confirmed by SFTP's pure-JS
 * file operations working fine the whole time this was broken). It's
 * unclear whether the missing +x is specific to how node_modules got onto
 * any given machine or a genuine npm/tar quirk, so rather than relying on
 * it never happening again, this re-asserts the right permissions — a
 * no-op if they were already fine.
 *
 * Fixes EVERY platform-arch prebuild it finds, not just the one matching
 * the machine this script runs on: a normal `npm install` on a dev machine
 * only needs its own platform fixed, but apps/desktop/scripts/prepare-
 * resources.js's packaging install runs on whatever host is doing the
 * packaging (which may not match any shipped target platform) and stages
 * prebuilds for every platform the app ships for — all of them need fixing
 * there, which is also why that script invokes this one directly rather
 * than relying on desktop-agent's own "postinstall" hook (which doesn't run
 * at all during that staging install -- see prepare-resources.js's own
 * comment on why it passes --ignore-scripts).
 *
 * Usage: `node fix-node-pty-perms.js [path/to/node-pty/package/dir]`.
 * With no argument, resolves node-pty via normal Node module resolution
 * from this script's own location (the desktop-agent postinstall case).
 * With an argument, fixes that exact node-pty install instead (the
 * packaging-staging case, where the target node_modules isn't anywhere
 * this script's own module resolution would find it).
 *
 * ESM, not CommonJS: apps/desktop-agent/package.json has "type": "module",
 * and Node picks module format by the nearest package.json to a file's own
 * path, not by how it's invoked -- a plain `require()` here throws
 * "require is not defined in ES module scope" regardless of whether this
 * runs standalone or as npm's postinstall. (That was a real, separate bug
 * in an earlier version of this exact file: the postinstall wiring was
 * correct, but the script itself could never actually run, which means it
 * was never fixing anything on anyone's machine either -- caught here by
 * actually executing it instead of only reading it.)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

function main() {
  let nodePtyDir = process.argv[2];
  if (nodePtyDir) {
    nodePtyDir = path.resolve(nodePtyDir);
    if (!fs.existsSync(path.join(nodePtyDir, "package.json"))) {
      console.error(`[fix-node-pty-perms] no node-pty found at ${nodePtyDir}`);
      process.exit(1);
    }
  } else {
    try {
      const require = createRequire(import.meta.url);
      nodePtyDir = path.dirname(require.resolve("node-pty/package.json"));
    } catch {
      return; // node-pty isn't installed (e.g. a partial/failed install) — nothing to fix
    }
  }

  const prebuildsRoot = path.join(nodePtyDir, "prebuilds");
  if (!fs.existsSync(prebuildsRoot)) return; // no prebuilds at all — node-pty was built from source, which sets its own permissions

  let fixedCount = 0;
  let checkedDirs = 0;
  for (const platformArch of fs.readdirSync(prebuildsRoot)) {
    const prebuildDir = path.join(prebuildsRoot, platformArch);
    if (!fs.statSync(prebuildDir).isDirectory()) continue;
    checkedDirs++;
    for (const entry of fs.readdirSync(prebuildDir)) {
      // Anything node-pty might exec directly: the native addon itself, plus
      // the Unix spawn-helper and (on Windows) the winpty/conpty helper binaries.
      if (!/\.node$|^spawn-helper$|-agent\.exe$|^conpty$/.test(entry)) continue;
      const filePath = path.join(prebuildDir, entry);
      const mode = fs.statSync(filePath).mode & 0o777;
      if ((mode & 0o111) !== 0o111) {
        fs.chmodSync(filePath, 0o755);
        fixedCount++;
      }
    }
  }

  if (fixedCount > 0) {
    console.log(`[fix-node-pty-perms] restored executable permissions on ${fixedCount} native binary(ies) across ${checkedDirs} prebuild dir(s) under ${prebuildsRoot}`);
  }
}

main();
