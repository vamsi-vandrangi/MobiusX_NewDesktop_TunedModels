// Contrasts the two cost profiles from tree.ts's header comment on the real
// 15k-file node_modules tree benchmarked in docs/phase-0-foundations.md:
// a full reconcile() walk vs. one applyChange() driven by a single watcher
// event. Run with: npx tsx examples/large-tree-incremental-demo.ts <path>
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reconcile, applyChange } from "../src/tree.js";

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: tsx large-tree-incremental-demo.ts <directory>");
    process.exit(1);
  }

  console.log(`Reconciling ${dir} once to get a baseline snapshot...`);
  const { snapshot, stats } = await reconcile(dir, null);
  const totalNodes = Object.keys(snapshot.nodes).length;
  console.log(`Done: ${stats.totalFiles} files, ${stats.totalDirs} dirs, ${totalNodes} total nodes.\n`);

  // Pick the most deeply-nested file we indexed — the case that best shows
  // off applyChange()'s ancestor-chain-only cost, rather than a shallow one.
  const fileEntries = Object.entries(snapshot.nodes).filter(([, n]) => n.type === "file");
  const [targetRel] = fileEntries.sort((a, b) => b[0].split("/").length - a[0].split("/").length)[0];
  const depth = targetRel.split("/").length;
  const absPath = join(dir, targetRel);

  const original = await readFile(absPath, "utf8").catch(() => null);
  await writeFile(absPath, (original ?? "") + "\n// mobiusx incremental-index demo touch\n");

  const result = await applyChange(snapshot, dir, targetRel, "change");

  console.log(`Edited: ${targetRel}  (path depth ${depth})`);
  console.log(`Nodes touched by applyChange: ${result.ancestorsTouched.length + 1} (the file + ${result.ancestorsTouched.length} ancestor dirs)`);
  console.log(`Nodes in the full tree: ${totalNodes}`);
  console.log(`That's ${(((result.ancestorsTouched.length + 1) / totalNodes) * 100).toFixed(3)}% of the tree touched for one edit.`);

  // restore the file so this demo is non-destructive to a real checkout
  if (original !== null) await writeFile(absPath, original);
}

main();
