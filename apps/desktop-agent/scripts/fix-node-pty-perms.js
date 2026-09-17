#!/usr/bin/env node
/**
 * Ensures node-pty's prebuilt native binaries for THIS machine are actually
 * executable.
 *
 * What went wrong once (and why this exists): node-pty ships prebuilt
 * binaries per platform+arch under node_modules/node-pty/prebuilds/<platform>-
 * <arch>/ (see node_modules/node-pty/lib/utils.js#loadNativeModule) instead of
 * compiling from source when a matching prebuild is found — see
 * node_modules/node-pty/scripts/prebuild.js. That's normally fine, but on
 * this project those extracted files ended up mode 600 (rw-------) instead
 * of the executable 755 they need — pty.node is require()'d, which doesn't
 * strictly need +x, but spawn-helper is actually exec'd via posix_spawn(2)
 * to fork the shell, and a non-executable spawn-helper makes that syscall
 * fail immediately. That's the exact cause of the desktop terminal's
 * "Failed to start terminal: posix_spawn failed" error. It's unclear whether
 * this was specific to how node_modules got onto this machine or a genuine
 * npm/tar quirk, so rather than relying on it never happening again, this
 * runs after every `npm install` and simply re-asserts the right permissions
 * — a no-op if they were already fine.
 */
const fs = require("node:fs");
const path = require("node:path");

function main() {
  let nodePtyDir;
  try {
    nodePtyDir = path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    return; // node-pty isn't installed (e.g. a partial/failed install) — nothing to fix
  }

  const prebuildDir = path.join(nodePtyDir, "prebuilds", `${process.platform}-${process.arch}`);
  if (!fs.existsSync(prebuildDir)) return; // no prebuild for this platform — node-pty will build from source instead, which sets its own permissions

  let fixedAny = false;
  for (const entry of fs.readdirSync(prebuildDir)) {
    // Anything node-pty might exec directly: the native addon itself, plus
    // the Unix spawn-helper and (on Windows) the winpty/conpty helper binaries.
    if (!/\.node$|^spawn-helper$|-agent\.exe$|^conpty$/.test(entry)) continue;
    const filePath = path.join(prebuildDir, entry);
    const mode = fs.statSync(filePath).mode & 0o777;
    if ((mode & 0o111) !== 0o111) {
      fs.chmodSync(filePath, 0o755);
      fixedAny = true;
    }
  }

  if (fixedAny) {
    console.log(`[fix-node-pty-perms] Restored executable permissions on node-pty's ${process.platform}-${process.arch} prebuild.`);
  }
}

main();
