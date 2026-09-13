/**
 * Thin re-export: the actual settings read/write logic moved to
 * @mobiusx/agent-settings so apps/cloud-agent-gateway can read the same
 * `~/.mobiusx/settings.json` file (for AgentSettings.defaultModel, part of
 * multi-model support) without duplicating this code or needing IPC
 * between the two processes. desktop-agent remains the only WRITER (see
 * routes.ts's PUT /settings) — this file exists so nothing importing
 * "./settings.js" elsewhere in this app (routes.ts, terminalWs.test.ts)
 * had to change.
 */
export * from "@mobiusx/agent-settings";
