# Vendored renderer libraries

Static copies of a few runtime UI dependencies, checked in here instead of
being loaded from `node_modules` at runtime.

`index.html` used to reference these via `../../../../node_modules/...`,
which only resolved correctly when running unpacked from the monorepo
checkout (`electron .`). electron-builder packages `apps/desktop` itself
as the asar root, so that same relative path overshoots by two directory
levels in any packaged build and 404s -- which throws an uncaught
`ReferenceError` partway through `renderer.js` and silently stops every
script after it, including the sign-in code. That bug shipped in every
prior installer; see the commit that added this directory for the full
writeup.

Copied from (versions pinned in `package.json`'s `dependencies`):

- `xterm.js`, `xterm.css` <- `@xterm/xterm/lib/xterm.js`, `@xterm/xterm/css/xterm.css`
- `addon-fit.js` <- `@xterm/addon-fit/lib/addon-fit.js`
- `diff.min.js` <- `diff/dist/diff.min.js`
- `marked.umd.js` <- `marked/lib/marked.umd.js`
- `mermaid.min.js` <- `mermaid/dist/mermaid.min.js`

To refresh after bumping one of these packages, re-copy the matching file
from `node_modules` (two levels up from `apps/desktop`) over the one here.
