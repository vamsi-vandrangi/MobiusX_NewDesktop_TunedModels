import { randomBytes } from "node:crypto";
import { createGatewayServer } from "./server.js";
import { recoverInterruptedTasks } from "./store.js";

// Optional local `.env` file in this app's own directory (gitignored — see
// .env.example) as a convenience alternative to exporting ANTHROPIC_API_KEY /
// ANTHROPIC_MODEL in your shell. This matters because a GUI-launched Electron
// app (as opposed to running `npm run start` from a terminal) does not
// inherit your shell's exports, so a `.env` file is the only way to configure
// a real model when running via `apps/desktop`. Node's built-in loader:
// values already present in process.env (e.g. a real shell export) win over
// the file, and a missing file is silently a no-op — nothing to configure by
// default, matching the "no credentials, no assumed model" README promise.
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const PORT = Number(process.env.MOBIUSX_CLOUD_PORT ?? 0);
const token = process.env.MOBIUSX_CLOUD_TOKEN ?? randomBytes(24).toString("hex");

const { server } = createGatewayServer(token);

void recoverInterruptedTasks().then((recovered) => {
  server.listen(PORT, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    if (recovered) process.stdout.write(`Recovered ${recovered} interrupted task(s); validated Build checkpoints are available for resume.\n`);
    // Distinct marker from desktop-agent's MOBIUSX_AGENT_READY so Electron's
    // main process can tell the two spawned processes apart on stdout.
    process.stdout.write(`MOBIUSX_CLOUD_READY ${JSON.stringify({ port, token })}\n`);
  });
}).catch((error) => {
  process.stderr.write(`Cloud gateway recovery failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
