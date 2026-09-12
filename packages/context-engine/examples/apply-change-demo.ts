// Minimal, runnable proof of the claim in tree.ts's header comment: editing
// one deeply-nested file touches only that file's ancestor chain, not the
// whole tree. Run with: npx tsx examples/apply-change-demo.ts
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile, applyChange } from "../src/tree.js";

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-demo-"));
  await mkdir(join(dir, "src", "services"), { recursive: true });
  await mkdir(join(dir, "src", "utils"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# demo\n");
  await writeFile(join(dir, "src", "index.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "src", "services", "order.ts"), "export function order() {}\n");
  await writeFile(join(dir, "src", "utils", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");

  const { snapshot } = await reconcile(dir, null);
  console.log("Initial rootHash:", snapshot.rootHash.slice(0, 16));

  await writeFile(join(dir, "src", "services", "order.ts"), "export function order() { return 42; }\n");
  const result = await applyChange(snapshot, dir, "src/services/order.ts", "change");

  console.log("\nEdited src/services/order.ts. Ancestor chain updated:");
  console.log(" ", result.ancestorsTouched.join("  ->  ") || "(root)");
  console.log(`\nrootHash: ${result.rootHashBefore.slice(0, 16)} -> ${result.rootHashAfter.slice(0, 16)}`);
  console.log(`Touched ${result.ancestorsTouched.length} node(s) total, out of ${Object.keys(snapshot.nodes).length} in the whole tree.`);

  await rm(dir, { recursive: true, force: true });
}

main();
