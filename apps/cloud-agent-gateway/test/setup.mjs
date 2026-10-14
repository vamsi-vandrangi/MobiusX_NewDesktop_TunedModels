import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The gateway's integration suite must never read or mutate a developer's
// real ~/.mobiusx audit log. Set this before test modules import audit-log.
const isolatedStateDir = join(tmpdir(), `mobiusx-gateway-test-${process.pid}`);
process.env.MOBIUSX_AUDIT_LOG_DIR = join(isolatedStateDir, "audit");
mkdirSync(process.env.MOBIUSX_AUDIT_LOG_DIR, { recursive: true });
