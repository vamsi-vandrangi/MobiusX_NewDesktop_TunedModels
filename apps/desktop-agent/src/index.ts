import { randomBytes } from "node:crypto";
import { createAgentServer } from "./server.js";

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

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
