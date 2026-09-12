import { randomBytes } from "node:crypto";
import { createGatewayServer } from "./server.js";

const PORT = Number(process.env.MOBIUSX_CLOUD_PORT ?? 0);
const token = process.env.MOBIUSX_CLOUD_TOKEN ?? randomBytes(24).toString("hex");

const { server } = createGatewayServer(token);

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  // Distinct marker from desktop-agent's MOBIUSX_AGENT_READY so Electron's
  // main process can tell the two spawned processes apart on stdout.
  process.stdout.write(`MOBIUSX_CLOUD_READY ${JSON.stringify({ port, token })}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
