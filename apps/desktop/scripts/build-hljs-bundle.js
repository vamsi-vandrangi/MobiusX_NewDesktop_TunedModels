// Regenerates src/renderer/vendor/highlight.min.js from scripts/hljs-entry.js.
//
// Unlike this app's other vendored files (xterm.js, marked.umd.js,
// mermaid.min.js -- see src/renderer/vendor/README.md), highlight.js no
// longer ships a pre-built browser bundle in its npm package: modern
// highlight.js only publishes CommonJS/ESM modules meant for a bundler, so
// there's no single file to just copy out of node_modules. This script is
// that bundler step, run once at vendoring time (and again whenever
// hljs-entry.js's language list changes or highlight.js is upgraded) --
// esbuild is a devDependency only, nothing about it ships in the app.
//
// Run from apps/desktop: node scripts/build-hljs-bundle.js
const esbuild = require("esbuild");
const path = require("node:path");

esbuild
  .build({
    entryPoints: [path.join(__dirname, "hljs-entry.js")],
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    outfile: path.join(__dirname, "..", "src", "renderer", "vendor", "highlight.min.js"),
  })
  .then(() => {
    console.log("[build-hljs-bundle] wrote src/renderer/vendor/highlight.min.js");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
