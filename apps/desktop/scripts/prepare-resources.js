#!/usr/bin/env node
/**
 * Stages the two sibling Node services (desktop-agent, cloud-agent-gateway)
 * and the shared @mobiusx/* workspace packages they depend on into a
 * self-contained tree under apps/desktop/resources-staging/, which
 * electron-builder's `extraResources` config then copies verbatim into the
 * packaged app's resources/ folder.
 *
 * Why this exists at all: main.js spawns desktop-agent and cloud-agent-
 * gateway as separate `node` child processes (see startService() there).
 * In dev, that works because this is an npm-workspaces monorepo -- the two
 * services and their @mobiusx/* dependencies all live on disk right next to
 * each other, and hoisted third-party deps sit in the repo root's
 * node_modules, which Node's module resolution walks up to and finds
 * automatically. electron-builder has no idea any of that exists: its
 * default dependency walker only looks at apps/desktop/package.json's own
 * "dependencies" (which is how @xterm/*, diff, marked, mermaid -- the
 * renderer's own deps -- get bundled automatically, with zero config from
 * this script). The two spawned services are a different thing entirely --
 * separate processes, separate dependency trees -- so this script builds
 * them a standalone, minimal npm install of their own, shaped so Node's own
 * upward module-resolution walk finds everything without any extra path
 * configuration in main.js beyond pointing APPS_DIR at this tree.
 *
 * Output shape (mirrors what npm workspace hoisting already does in dev,
 * but as real copies instead of symlinks, since a symlink into a sibling
 * package.json/package that won't ship isn't something to rely on inside a
 * packaged artifact):
 *
 *   resources-staging/
 *     apps/
 *       desktop-agent/{dist/, package.json}        <- compiled JS + just
 *       cloud-agent-gateway/{dist/, package.json}     enough package.json
 *                                                      (name/type/main) for
 *                                                      Node's ESM detection
 *     node_modules/
 *       express/ ws/ node-pty/ playwright/ ...        <- real npm install,
 *       @modelcontextprotocol/sdk/ chokidar/ ...          production-only
 *       web-tree-sitter/ tree-sitter-wasms/
 *       @mobiusx/
 *         protocol/{dist/, package.json}             <- shared workspace
 *         agent-settings/{dist/, package.json}           packages, copied
 *         audit-log/{dist/, package.json}                (not npm-installed
 *         context-engine/{dist/, package.json}           -- they aren't on
 *         secret-scan/{dist/, package.json}              the npm registry)
 *         semantic-index/{dist/, package.json}
 *         mcp-client/{dist/, package.json}
 *
 * From resources-staging/apps/desktop-agent/dist/index.js, Node's upward
 * node_modules search (dist/ -> desktop-agent/ -> apps/ -> staging root)
 * lands on resources-staging/node_modules for BOTH the third-party deps and
 * the @mobiusx/* packages -- exactly mirroring how it resolves in dev.
 *
 * package.json for the fresh `npm install` this script runs is built from
 * the real dependency lists (apps/desktop-agent, apps/cloud-agent-gateway,
 * and the 7 shared packages they transitively need -- @mobiusx/ui-kit is
 * deliberately excluded, it's a renderer-only placeholder with no runtime
 * code either service imports), so nothing here is hand-guessed.
 *
 * Explicitly NOT solved here: Playwright's own Chromium binary (used by
 * browserOps.ts's Browser Validation). Bundling it would mean a
 * platform-specific ~150-300MB download baked into every installer, which
 * is a real, separate packaging decision. This script installs playwright's
 * JS API with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, so Browser Validation in
 * a packaged build fails with the same actionable error it already has in
 * dev ("npx playwright install chromium") rather than the install hanging
 * or silently downloading a binary for the wrong OS/arch. See this phase's
 * notes for the follow-up this implies.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DESKTOP_DIR = path.join(__dirname, "..");
const STAGING = path.join(DESKTOP_DIR, "resources-staging");

const SERVICES = ["desktop-agent", "cloud-agent-gateway"];
const SHARED_PACKAGES = [
  "protocol",
  "agent-settings",
  "audit-log",
  "context-engine",
  "secret-scan",
  "semantic-index",
  "mcp-client",
];

function rmrf(p) {
  // This mount can refuse unlink() on files left over from a previous run
  // (EPERM) even though the caller owns them and rename() works fine -- so
  // rather than deleting in place, move the old tree out of the way with a
  // uniquely-suffixed rename and let it become orphaned junk instead of
  // failing the whole staging run.
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return;
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
      const stale = `${p}.stale-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.renameSync(p, stale);
      return;
    }
    throw err;
  }
}

function cpr(from, to) {
  // fs.cpSync's recursive copy relies on internal syscalls (fchmod/mkdir
  // with specific mode flags, etc.) that this mount's filesystem sometimes
  // rejects with EACCES even for freshly-created, owner-writable
  // directories. Shelling out to the system `cp` is far more reliably
  // supported here, so use that instead -- same recursive, symlink-
  // dereferencing semantics as the fs.cpSync call this replaces.
  fs.mkdirSync(path.dirname(to), { recursive: true });
  execFileSync("cp", ["-RL", from, to]);
}

function requireDist(dir, label) {
  const distDir = path.join(dir, "dist");
  if (!fs.existsSync(distDir) || fs.readdirSync(distDir).length === 0) {
    console.error(
      `[prepare-resources] ${label}'s dist/ is missing or empty (${distDir}).\n` +
        `Run \`npm run build --workspaces\` at the repo root first, then retry.`,
    );
    process.exit(1);
  }
  return distDir;
}

function trimmedPackageJson(srcPkgJsonPath) {
  const full = JSON.parse(fs.readFileSync(srcPkgJsonPath, "utf8"));
  // Only what Node needs to resolve/load this package correctly at runtime
  // -- name for resolution, type for ESM detection, main as the entry
  // pointer. Deliberately drops devDependencies/scripts/etc, which have no
  // business shipping in a packaged app and would only bloat it.
  const trimmed = { name: full.name, version: full.version, private: true };
  if (full.type) trimmed.type = full.type;
  if (full.main) trimmed.main = full.main;
  return trimmed;
}

/**
 * Real bug caught in Phase D live testing: node-pty's terminal -- local
 * shell AND remote `ssh` alike, since both go through the same native
 * spawn-helper underneath -- failed every single time with the opaque
 * native error "posix_spawnp failed." The first diagnosis (a Finder-
 * launched app's impoverished PATH failing to resolve a bare "ssh") was
 * wrong -- SFTP (pure JS, no native exec) worked fine the whole time this
 * was broken, which in hindsight was the tell.
 *
 * The real cause, and the fix, are centralized in desktop-agent's own
 * apps/desktop-agent/scripts/fix-node-pty-perms.js (see its doc comment for
 * the full story) -- this script's own staging `npm install` above runs
 * with --ignore-scripts (see that comment for why that's still correct),
 * which means desktop-agent's normal "postinstall" hook never fires here,
 * so it's invoked directly, pointed at THIS staging tree's node-pty rather
 * than the one it would otherwise resolve relative to its own location.
 * This has to run after npm install and before electron-builder copies
 * resources-staging/ verbatim into the packaged app.
 */
function fixNativeHelperPermissions(stagingRoot) {
  const nodePtyDir = path.join(stagingRoot, "node_modules", "node-pty");
  if (!fs.existsSync(nodePtyDir)) return;
  const fixScript = path.join(DESKTOP_DIR, "..", "desktop-agent", "scripts", "fix-node-pty-perms.js");
  execFileSync("node", [fixScript, nodePtyDir], { stdio: "inherit" });
}

function main() {
  console.log("[prepare-resources] cleaning", STAGING);
  rmrf(STAGING);
  fs.mkdirSync(path.join(STAGING, "apps"), { recursive: true });
  fs.mkdirSync(path.join(STAGING, "node_modules", "@mobiusx"), { recursive: true });

  const aggregatedDeps = {};

  for (const service of SERVICES) {
    const serviceDir = path.join(REPO_ROOT, "apps", service);
    const distDir = requireDist(serviceDir, `apps/${service}`);
    const outDir = path.join(STAGING, "apps", service);
    fs.mkdirSync(outDir, { recursive: true });
    cpr(distDir, path.join(outDir, "dist"));
    const pkgJsonPath = path.join(serviceDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    fs.writeFileSync(
      path.join(outDir, "package.json"),
      JSON.stringify(trimmedPackageJson(pkgJsonPath), null, 2),
    );
    for (const [name, range] of Object.entries(pkg.dependencies || {})) {
      if (name.startsWith("@mobiusx/")) continue; // handled separately below
      aggregatedDeps[name] = range;
    }
    console.log(`[prepare-resources] staged apps/${service}`);
  }

  // Shared @mobiusx/* packages are NOT copied into node_modules yet --
  // only their dependency lists are read here. They aren't declared in
  // stagingPkgJson's "dependencies" below (they're not on the npm registry,
  // there's nothing to declare), which means `npm install` would treat a
  // node_modules/@mobiusx/<pkg> copied in beforehand as extraneous and
  // silently prune it as part of normal install reconciliation -- confirmed
  // the hard way: an earlier version of this script copied them in first
  // and `npm install` deleted every one of them. So the actual copy happens
  // in the second pass below, after npm install has already run.
  for (const pkgName of SHARED_PACKAGES) {
    const pkgDir = path.join(REPO_ROOT, "packages", pkgName);
    requireDist(pkgDir, `packages/${pkgName}`);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    for (const [name, range] of Object.entries(pkg.dependencies || {})) {
      if (name.startsWith("@mobiusx/")) continue; // another shared package -- staged below, not an npm dep
      aggregatedDeps[name] = range;
    }
  }

  const stagingPkgJson = {
    name: "mobiusx-desktop-resources",
    version: "0.0.1",
    private: true,
    dependencies: aggregatedDeps,
  };
  fs.writeFileSync(path.join(STAGING, "package.json"), JSON.stringify(stagingPkgJson, null, 2));

  console.log("[prepare-resources] third-party deps to install:", Object.keys(aggregatedDeps).join(", "));
  console.log("[prepare-resources] running npm install (production only, Playwright browser download skipped)...");
  // --ignore-scripts: this staging install runs on whatever host happens to
  // be doing the packaging (which may not match any of the shipped app's
  // target platforms), so install/postinstall hooks that try to compile or
  // fetch a native binary for THIS host (e.g. node-pty's node-gyp rebuild
  // fallback) are pointless work that can fail outright on a host with no
  // node-gyp toolchain / restricted network. It's safe to skip here because
  // native deps that matter (node-pty, and anything else with prebuilds)
  // ship their prebuilt binaries for every target platform directly inside
  // the npm package -- see the node-pty comment above -- so the right one
  // is simply already present as a file once the tarball is extracted, with
  // no build step required to select it at runtime.
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"],
    {
      cwd: STAGING,
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    },
  );

  fixNativeHelperPermissions(STAGING);

  // Now that npm install has finished reconciling node_modules against
  // stagingPkgJson's declared dependencies, it's safe to drop the
  // @mobiusx/* packages in -- nothing will prune them after this.
  fs.mkdirSync(path.join(STAGING, "node_modules", "@mobiusx"), { recursive: true });
  for (const pkgName of SHARED_PACKAGES) {
    const pkgDir = path.join(REPO_ROOT, "packages", pkgName);
    const distDir = requireDist(pkgDir, `packages/${pkgName}`);
    const outDir = path.join(STAGING, "node_modules", "@mobiusx", pkgName);
    fs.mkdirSync(outDir, { recursive: true });
    cpr(distDir, path.join(outDir, "dist"));
    const pkgJsonPath = path.join(pkgDir, "package.json");
    fs.writeFileSync(
      path.join(outDir, "package.json"),
      JSON.stringify(trimmedPackageJson(pkgJsonPath), null, 2),
    );
    console.log(`[prepare-resources] staged @mobiusx/${pkgName}`);
  }

  console.log("[prepare-resources] done ->", STAGING);
}

main();
