import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkSource } from "../src/chunker.js";

const SAMPLE = `import { readFile } from "node:fs";

const CONFIG_PATH = "./config.json";

export function order() {
  return 1;
}

export const add = (a: number, b: number) => a + b;

class OrderService {
  private total = 0;
  constructor(private tax: number) {}
  validate(order: unknown): boolean {
    return true;
  }
  compute(): number {
    return this.total * (1 + this.tax);
  }
}

interface Foo {
  x: number;
}

type Bar = string | number;
`;

test("chunks functions, methods, interfaces and types as separate boundaries", async () => {
  const chunks = await chunkSource("src/services/order.ts", SAMPLE);
  const kinds = chunks.map((c) => `${c.kind}:${c.symbolPath}`);

  assert.ok(kinds.includes("function:src/services/order.ts#order"));
  assert.ok(kinds.includes("function:src/services/order.ts#add"), "arrow-function const should be treated as function-like");
  assert.ok(kinds.includes("method:OrderService.validate"));
  assert.ok(kinds.includes("method:OrderService.compute"));
  assert.ok(kinds.includes("interface:src/services/order.ts#Foo"));
  assert.ok(kinds.includes("type:src/services/order.ts#Bar"));

  // the leading import + const are neither functions nor classes — they should
  // land in one merged "block" chunk, not be dropped and not get one chunk each.
  const blocks = chunks.filter((c) => c.kind === "block" && c.symbolPath === "src/services/order.ts");
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0]!.text.includes("CONFIG_PATH"));
  assert.ok(blocks[0]!.text.includes("readFile"));
});

test("a chunk's text is never a fragment — every emitted chunk is syntactically self-contained", async () => {
  const chunks = await chunkSource("src/services/order.ts", SAMPLE);
  for (const chunk of chunks) {
    const opens = (chunk.text.match(/{/g) ?? []).length;
    const closes = (chunk.text.match(/}/g) ?? []).length;
    assert.equal(opens, closes, `unbalanced braces in chunk ${chunk.symbolPath}:\n${chunk.text}`);
  }
});

test("method chunks carry accurate line ranges back into the source", async () => {
  const chunks = await chunkSource("src/services/order.ts", SAMPLE);
  const validate = chunks.find((c) => c.symbolPath === "OrderService.validate")!;
  const lines = SAMPLE.split("\n");
  const extractedLines = lines.slice(validate.startLine - 1, validate.endLine);
  // node.text starts at the node's own column, not column 0 — compare against
  // the line range with each line's leading/trailing whitespace trimmed away,
  // since that's the only thing column-vs-line-slice extraction disagrees on.
  const normalize = (s: string) => s.split("\n").map((l) => l.trim()).join("\n");
  assert.equal(normalize(extractedLines.join("\n")), normalize(validate.text));
});
