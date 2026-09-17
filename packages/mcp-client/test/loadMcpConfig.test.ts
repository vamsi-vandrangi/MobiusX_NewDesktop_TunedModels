import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, toAnthropicToolDefs } from "../src/index.js";

test("loadMcpConfig returns no servers and no error when there is no project open", async () => {
  assert.deepEqual(await loadMcpConfig(null), { servers: [], path: null, error: null });
});

test("loadMcpConfig returns no servers and no error when .mobiusx/mcp.json doesn't exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-mcp-test-"));
  assert.deepEqual(await loadMcpConfig(dir), { servers: [], path: null, error: null });
});

test("loadMcpConfig parses the Claude Desktop-shaped mcpServers object into an array, defaulting enabled to true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-mcp-test-"));
  await mkdir(join(dir, ".mobiusx"));
  await writeFile(
    join(dir, ".mobiusx", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
        disabled_one: { command: "echo", enabled: false },
      },
    }),
  );
  const result = await loadMcpConfig(dir);
  assert.equal(result.error, null);
  assert.equal(result.servers.length, 2);
  const fs = result.servers.find((s) => s.name === "filesystem")!;
  assert.equal(fs.command, "npx");
  assert.deepEqual(fs.args, ["-y", "@modelcontextprotocol/server-filesystem", "."]);
  assert.equal(fs.enabled, true);
  const disabled = result.servers.find((s) => s.name === "disabled_one")!;
  assert.equal(disabled.enabled, false);
});

test("loadMcpConfig ignores the WHOLE file when a server config is missing 'command'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-mcp-test-"));
  await mkdir(join(dir, ".mobiusx"));
  await writeFile(join(dir, ".mobiusx", "mcp.json"), JSON.stringify({ mcpServers: { broken: { args: ["x"] } } }));
  const result = await loadMcpConfig(dir);
  assert.equal(result.servers.length, 0);
  assert.match(result.error ?? "", /command/);
});

test("loadMcpConfig reports malformed JSON without throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-mcp-test-"));
  await mkdir(join(dir, ".mobiusx"));
  await writeFile(join(dir, ".mobiusx", "mcp.json"), "{not valid json");
  const result = await loadMcpConfig(dir);
  assert.equal(result.servers.length, 0);
  assert.match(result.error ?? "", /not valid JSON/);
});

test("toAnthropicToolDefs maps namespaced tool info into Anthropic's tool definition shape", () => {
  const defs = toAnthropicToolDefs([
    { name: "fs__read_file", serverName: "fs", toolName: "read_file", description: "Reads a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  ]);
  assert.deepEqual(defs, [{ name: "fs__read_file", description: "Reads a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }]);
});
