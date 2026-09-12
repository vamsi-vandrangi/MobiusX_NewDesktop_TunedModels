import { test } from "node:test";
import assert from "node:assert/strict";
import { HashingEmbeddingProvider } from "../src/embeddings/hashing.js";
import { OllamaEmbeddingProvider } from "../src/embeddings/ollama.js";
import { cosineSimilarity } from "../src/embeddings/provider.js";

test("hashing provider: identical text embeds identically", async () => {
  const provider = new HashingEmbeddingProvider();
  const [a] = await provider.embed(["function validateOrder(order) { return order.total > 0; }"]);
  const [b] = await provider.embed(["function validateOrder(order) { return order.total > 0; }"]);
  assert.ok(Math.abs(cosineSimilarity(a!, b!) - 1) < 1e-9);
});

test("hashing provider: lexically similar code scores higher than unrelated code", async () => {
  const provider = new HashingEmbeddingProvider();
  const query = "function validateOrderPayload(order) { return order.total > 0; }";
  const related = "function checkOrderPayload(order) { return order.total >= 0 && order.total < 1e6; }";
  const unrelated = "class DatabaseConnectionPool { acquire() { return this.pool.pop(); } }";

  const [qv, rv, uv] = await provider.embed([query, related, unrelated]);
  const simRelated = cosineSimilarity(qv!, rv!);
  const simUnrelated = cosineSimilarity(qv!, uv!);

  assert.ok(
    simRelated > simUnrelated,
    `expected related (${simRelated.toFixed(3)}) > unrelated (${simUnrelated.toFixed(3)})`,
  );
});

test("hashing provider: vectors are L2-normalized", async () => {
  const provider = new HashingEmbeddingProvider();
  const [v] = await provider.embed(["some reasonably long function body with several tokens in it"]);
  let norm = 0;
  for (const x of v!) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6);
});

test("ollama provider: sends the documented request shape and parses the response", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    } as Response;
  }) as typeof fetch;

  const provider = new OllamaEmbeddingProvider({ baseUrl: "http://localhost:11434", model: "nomic-embed-text", fetchImpl: fakeFetch });
  const [vec] = await provider.embed(["const x = 1;"]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://localhost:11434/api/embeddings");
  assert.deepEqual(calls[0]!.body, { model: "nomic-embed-text", prompt: "const x = 1;" });
  const got = Array.from(vec!);
  const expected = [0.1, 0.2, 0.3];
  got.forEach((v, i) => assert.ok(Math.abs(v - expected[i]!) < 1e-6, `index ${i}: ${v} vs ${expected[i]}`));
});

test("ollama provider: a non-OK response raises rather than returning a zero vector", async () => {
  const fakeFetch = (async () =>
    ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) }) as Response) as typeof fetch;
  const provider = new OllamaEmbeddingProvider({ fetchImpl: fakeFetch });
  await assert.rejects(() => provider.embed(["x"]));
});
