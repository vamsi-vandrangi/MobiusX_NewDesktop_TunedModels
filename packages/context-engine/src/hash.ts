// Content hashing. SHA-256 is used throughout (not SHA-1, unlike Git) since
// the index is a security-relevant artifact (§4.3 of the TDD — obfuscated
// paths sit next to these hashes) rather than a pure VCS convenience.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Hash arbitrary in-memory data (used for directory nodes: the hash of their children's names+hashes). */
export function hashBytes(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Stream-hash a file's contents so large files never have to fully load into memory. */
export function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
