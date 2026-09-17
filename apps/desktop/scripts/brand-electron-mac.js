#!/usr/bin/env node
/**
 * Rebrands the locally-installed Electron.app bundle (macOS, dev-mode only)
 * so the OS itself shows "MobiusX.ai" — in the menu bar's bold app-name
 * text, the Force Quit / App Switcher list, Activity Monitor, and the Dock
 * icon — instead of Electron's own defaults.
 *
 * Why this is needed at all: app.setName() (see main.js) and
 * app.dock.setIcon() only cover part of this. Electron's auto-generated menu
 * items (About/Hide/Quit) do pick up app.setName()'s value, but the actual
 * bold text painted at the far left of the menu bar is sourced by macOS from
 * the running bundle's Info.plist (CFBundleName/CFBundleDisplayName), not
 * from anything the JS runtime sets — that's true for every unpackaged
 * `electron .` dev app, not a bug specific to this project. The real,
 * durable fix is to package this app properly (electron-builder/forge, with
 * its own signed .app and Info.plist) — a separate, bigger effort. Until
 * then, this edits the *shared* Electron.app that ships inside
 * node_modules/electron in place, which is the only thing that actually
 * moves that text in dev mode.
 *
 * Because `npm install` regenerates node_modules/electron from scratch every
 * time, this script is wired up as apps/desktop's "postinstall" so the
 * branding gets silently reapplied after every install rather than quietly
 * reverting the next time someone runs `npm install`.
 */
const fs = require("node:fs");
const path = require("node:path");

const APP_DISPLAY_NAME = "MobiusX.ai";

function main() {
  if (process.platform !== "darwin") return; // this trick is macOS-specific (Info.plist / .app bundles)

  let electronPkgDir;
  try {
    electronPkgDir = path.dirname(require.resolve("electron/package.json"));
  } catch {
    return; // electron isn't installed yet (e.g. a partial/failed install) — nothing to brand
  }

  const appPath = path.join(electronPkgDir, "dist", "Electron.app");
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  const iconDest = path.join(appPath, "Contents", "Resources", "electron.icns");
  const iconSrc = path.join(__dirname, "..", "assets", "electron.icns");

  if (!fs.existsSync(infoPlistPath)) {
    console.warn(`[brand-electron-mac] ${infoPlistPath} not found — skipping (unexpected electron package layout?)`);
    return;
  }

  let plist = fs.readFileSync(infoPlistPath, "utf8");
  const rename = (key) => {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    if (!re.test(plist)) {
      console.warn(`[brand-electron-mac] ${key} not found in Info.plist — leaving it as-is`);
      return;
    }
    plist = plist.replace(re, `$1${APP_DISPLAY_NAME}$2`);
  };
  rename("CFBundleName");
  rename("CFBundleDisplayName");
  fs.writeFileSync(infoPlistPath, plist);

  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, iconDest);
  } else {
    console.warn(`[brand-electron-mac] icon source ${iconSrc} not found — Info.plist renamed, icon left as Electron's default`);
  }

  console.log(`[brand-electron-mac] Rebranded local Electron.app as "${APP_DISPLAY_NAME}" (menu bar / Dock / Force Quit list).`);
}

main();
