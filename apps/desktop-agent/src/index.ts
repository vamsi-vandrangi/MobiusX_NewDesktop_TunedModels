import { randomBytes } from "node:crypto";
import { createAgentServer } from "./server.js";
import { stopPreview } from "./previewOps.js";

const PORT = Number(process.env.MOBIUSX_AGENT_PORT ?? 0); // 0 = OS picks a free port
const token = process.env.MOBIUSX_AGENT_TOKEN ?? randomBytes(24).toString("hex");

const { server } = createAgentServer(token);

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  // The Electron main process spawns this as a child process and reads this
  // exact line from stdout to learn where to connect and what token to send.
  // Keep this the *only* thing printed on this line.
  process.stdout.write(`MOBIUSX_AGENT_READY ${JSON.stringify({ port, token })}\n`);
});

// Kill any dev server(s) the Live Preview feature started (previewOps.ts) --
// otherwise quitting the desktop app would silently leave `npm run dev`/
// `uvicorn` processes (and the ports they hold) running in the background.
function shutdown() {
  stopPreview();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
