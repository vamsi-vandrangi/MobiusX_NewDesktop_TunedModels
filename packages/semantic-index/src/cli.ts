#!/usr/bin/env node
import { resolve } from "node:path";
import { buildIndex, queryIndex } from "./query.js";

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function cmdBuild(dir: string) {
  console.log(`Building semantic index for ${dir} ...\n`);
  const stats = await buildIndex(dir);
  console.log(`  provider              ${stats.provider}`);
  console.log(`  files considered      ${stats.filesConsidered} (all files under the Merkle snapshot)`);
  console.log(`  files (re)chunked     ${stats.filesChunked} (new/changed supported-language files)`);
  console.log(`  files removed         ${stats.filesRemoved}`);
  console.log(`  chunks (re)indexed    ${stats.chunksIndexed}`);
  console.log(`  total chunks in store ${stats.totalChunksInStore}`);
  console.log(`  duration              ${fmtMs(stats.durationMs)}`);
}

async function cmdQuery(dir: string, queryText: string, k: number) {
  const result = await queryIndex(dir, queryText, k);
  console.log(`Query: "${queryText}"  (provider: ${result.provider}, store size: ${result.storeSize} chunks)`);
  console.log(`Search took ${fmtMs(result.durationMs)}\n`);
  if (result.hits.length === 0) {
    console.log("  (no hits — is the index built? run: mobiusx-semantic build <dir>)");
    return;
  }
  for (const [i, hit] of result.hits.entries()) {
    console.log(
      `${i + 1}. ${hit.relPath}:${hit.startLine}-${hit.endLine}  [${hit.kind}]  score=${hit.score.toFixed(4)}`,
    );
    const preview = hit.snippet.split("\n").slice(0, 6).join("\n    ");
    console.log(`    ${preview}${hit.snippet.split("\n").length > 6 ? "\n    ..." : ""}\n`);
  }
}

async function main() {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "build": {
      const dir = resolve(rest[0] ?? ".");
      return cmdBuild(dir);
    }
    case "query": {
      // mobiusx-semantic query "<question>" [dir] [-k N]
      const args = rest.slice();
      let k = 5;
      const kFlagIndex = args.indexOf("-k");
      if (kFlagIndex !== -1) {
        k = Number(args[kFlagIndex + 1] ?? 5);
        args.splice(kFlagIndex, 2);
      }
      const queryText = args[0];
      const dir = resolve(args[1] ?? ".");
      if (!queryText) {
        console.log('Usage: mobiusx-semantic query "<question>" [directory] [-k N]');
        process.exit(1);
      }
      return cmdQuery(dir, queryText, k);
    }
    default:
      console.log("Usage: mobiusx-semantic <build|query> <directory>");
      console.log('  mobiusx-semantic build <dir>');
      console.log('  mobiusx-semantic query "<question>" <dir> [-k N]');
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
