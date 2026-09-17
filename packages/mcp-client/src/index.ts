import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpConfigResponse, McpServerConfig, McpServerStatus, McpToolInfo } from "@mobiusx/protocol";

/**
 * Broader MCP tool support (source requirement §28 -- see McpServerConfig's
 * doc comment in @mobiusx/protocol for the overall shape). A project opts
 * in by hand-writing `.mobiusx/mcp.json` using the SAME `{"mcpServers": {
 * "<name>": {"command": ..., "args": [...], "env": {...}} }}` shape Claude
 * Desktop/Claude Code use, so an existing config is usually just
 * copy-pasteable rather than needing translation. Every server is real: a
 * genuine child process spawned over stdio via the official
 * @modelcontextprotocol/sdk, not a mocked or partial reimplementation of
 * the protocol.
 *
 * Connections are cached in-process, keyed by (projectRoot, serverName,
 * JSON of that server's own config) -- a config edit naturally invalidates
 * the old cache entry rather than needing an explicit "reconnect" call.
 * This module has no knowledge of HTTP/Express/the gateway's task loop; it
 * is imported directly by both apps/desktop-agent (Settings UI) and
 * apps/cloud-agent-gateway (tool-use loop), each running it as a plain
 * local child process on the same machine -- consistent with cloud.ts's
 * own framing of apps/cloud-agent-gateway as "a LOCAL REFERENCE
 * implementation," not a genuinely remote service.
 */

interface CacheEntry {
  client: Client;
  tools: McpToolInfo[];
  connected: boolean;
  error?: string;
}

const connectionCache = new Map<string, Promise<CacheEntry>>();

export async function loadMcpConfig(projectPath: string | null): Promise<McpConfigResponse> {
  if (!projectPath) return { servers: [], path: null, error: null };
  const configPath = join(projectPath, ".mobiusx", "mcp.json");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], path: null, error: null };
    return { servers: [], path: configPath, error: `Failed to read .mobiusx/mcp.json: ${(err as Error).message}` };
  }

  let parsed: { mcpServers?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { servers: [], path: configPath, error: `.mobiusx/mcp.json is not valid JSON: ${(err as Error).message}` };
  }

  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
    return { servers: [], path: configPath, error: "'mcpServers' must be an object mapping server name -> config -- ignoring the whole file" };
  }

  const servers: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(parsed.mcpServers as Record<string, unknown>)) {
    const e = raw as Partial<McpServerConfig>;
    if (!e || typeof e.command !== "string") {
      return { servers: [], path: configPath, error: `mcpServers["${name}"] is missing a string 'command' -- ignoring the whole file` };
    }
    if (e.args !== undefined && (!Array.isArray(e.args) || !e.args.every((a) => typeof a === "string"))) {
      return { servers: [], path: configPath, error: `mcpServers["${name}"].args must be an array of strings -- ignoring the whole file` };
    }
    servers.push({
      name,
      command: e.command,
      args: e.args as string[] | undefined,
      env: e.env as Record<string, string> | undefined,
      enabled: e.enabled !== false,
    });
  }
  return { servers, path: configPath, error: null };
}

function cacheKey(projectPath: string, config: McpServerConfig): string {
  return `${projectPath}::${config.name}::${JSON.stringify({ command: config.command, args: config.args, env: config.env })}`;
}

async function connect(config: McpServerConfig): Promise<CacheEntry> {
  const client = new Client({ name: "mobiusx-desktop", version: "0.0.1" }, { capabilities: {} });
  try {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env ? { ...process.env, ...config.env } as Record<string, string> : (process.env as Record<string, string>),
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const info: McpToolInfo[] = tools.map((t) => ({
      name: `${config.name}__${t.name}`,
      serverName: config.name,
      toolName: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
    return { client, tools: info, connected: true };
  } catch (err) {
    return { client, tools: [], connected: false, error: (err as Error).message };
  }
}

async function getOrConnect(projectPath: string, config: McpServerConfig): Promise<CacheEntry> {
  const key = cacheKey(projectPath, config);
  let pending = connectionCache.get(key);
  if (!pending) {
    pending = connect(config);
    connectionCache.set(key, pending);
  }
  const entry = await pending;
  if (!entry.connected) {
    // Don't cache a failed connection forever -- the server might come up
    // later (e.g. `npx` still fetching a package the first time), and the
    // next status/call request should retry rather than repeat a stale error.
    connectionCache.delete(key);
  }
  return entry;
}

/** Connects to every enabled server configured for `projectPath` and reports real per-server status -- GET /mcp/status. */
export async function getMcpStatus(projectPath: string | null): Promise<McpServerStatus[]> {
  const { servers } = await loadMcpConfig(projectPath);
  const enabled = servers.filter((s) => s.enabled !== false);
  const results: McpServerStatus[] = [];
  for (const config of enabled) {
    const entry = await getOrConnect(projectPath as string, config);
    results.push({ name: config.name, connected: entry.connected, error: entry.error, tools: entry.tools });
  }
  return results;
}

/** All tools across every enabled, successfully-connected server -- what the Anthropic runner's tool-use loop offers the model. Silently omits a server that failed to connect (its status is still visible via getMcpStatus for the Settings UI) rather than failing the whole task over one bad server. */
export async function listAllTools(projectPath: string | null): Promise<McpToolInfo[]> {
  if (!projectPath) return [];
  const statuses = await getMcpStatus(projectPath);
  return statuses.filter((s) => s.connected).flatMap((s) => s.tools);
}

/** Calls one namespaced tool ("<serverName>__<toolName>") against its real server. Flattens the MCP result's content blocks into plain text -- a non-text block (e.g. an image) is summarized by type rather than dropped silently. */
export async function callMcpTool(projectPath: string | null, namespacedTool: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: string }> {
  if (!projectPath) return { isError: true, content: "no project open" };
  const sepIdx = namespacedTool.indexOf("__");
  if (sepIdx === -1) return { isError: true, content: `"${namespacedTool}" is not a valid namespaced tool name (expected "<server>__<tool>")` };
  const serverName = namespacedTool.slice(0, sepIdx);
  const toolName = namespacedTool.slice(sepIdx + 2);

  const { servers } = await loadMcpConfig(projectPath);
  const config = servers.find((s) => s.name === serverName);
  if (!config) return { isError: true, content: `No MCP server named "${serverName}" is configured for this project` };

  const entry = await getOrConnect(projectPath, config);
  if (!entry.connected) return { isError: true, content: `MCP server "${serverName}" is not connected: ${entry.error ?? "unknown error"}` };

  try {
    const result = await entry.client.callTool({ name: toolName, arguments: args });
    const blocks = (result.content as { type?: string; text?: string }[] | undefined) ?? [];
    const text = blocks
      .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : `[${b.type ?? "unknown"} content omitted]`))
      .join("\n");
    return { isError: Boolean(result.isError), content: text || "(tool returned no content)" };
  } catch (err) {
    return { isError: true, content: `Tool call failed: ${(err as Error).message}` };
  }
}

/** Converts MCP tool info into Anthropic Messages API tool definitions -- shared by anthropicRunner.ts's tool-use loop. */
export function toAnthropicToolDefs(tools: McpToolInfo[]): { name: string; description?: string; input_schema: Record<string, unknown> }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}
