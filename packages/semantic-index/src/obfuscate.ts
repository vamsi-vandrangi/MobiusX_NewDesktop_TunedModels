// Path obfuscation (TDD §4.3): "each path segment (split on / and .) is
// encrypted with a per-workspace secret key" — so a leaked index entry
// reveals neither directory structure nor file names, in local-only mode
// as much as in Cursor's cloud-index mode, since the local vector store is
// itself an asset a compromised machine could exfiltrate (see the TDD's
// closing argument in §4.3).
//
// Determinism is deliberate: the same segment always obfuscates to the same
// ciphertext (an HMAC of the plaintext under the workspace key derives the
// AES-GCM nonce, rather than a random one), so the same file's obfuscated
// path is stable across snapshots — needed for diffing and for a shared
// team index to dedupe. The nonce is still stored per-segment (it has to be
// — GCM decryption needs it), it's just not *random*.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type WorkspaceKey = Buffer;

export function generateWorkspaceKey(): WorkspaceKey {
  return randomBytes(KEY_BYTES);
}

function deriveNonce(key: WorkspaceKey, plaintext: string): Buffer {
  return createHmac("sha256", key).update(plaintext).digest().subarray(0, NONCE_BYTES);
}

function encryptSegment(key: WorkspaceKey, plaintext: string): string {
  const nonce = deriveNonce(key, plaintext);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, authTag, ciphertext]).toString("base64url");
}

function decryptSegment(key: WorkspaceKey, encoded: string): string {
  const packed = Buffer.from(encoded, "base64url");
  const nonce = packed.subarray(0, NONCE_BYTES);
  const authTag = packed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = packed.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

type Token = { kind: "sep"; value: "/" | "." } | { kind: "seg"; value: string };

// base64url's alphabet (A-Za-z0-9-_) never contains "/" or ".", so an
// obfuscated path can be re-tokenized with the exact same splitter used on
// the plaintext path — the delimiter positions round-trip for free.
function tokenize(path: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  for (const ch of path) {
    if (ch === "/" || ch === ".") {
      if (current.length > 0) {
        tokens.push({ kind: "seg", value: current });
        current = "";
      }
      tokens.push({ kind: "sep", value: ch });
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push({ kind: "seg", value: current });
  return tokens;
}

export function obfuscatePath(key: WorkspaceKey, relPath: string): string {
  return tokenize(relPath)
    .map((t) => (t.kind === "sep" ? t.value : encryptSegment(key, t.value)))
    .join("");
}

export function deobfuscatePath(key: WorkspaceKey, obfuscated: string): string {
  return tokenize(obfuscated)
    .map((t) => (t.kind === "sep" ? t.value : decryptSegment(key, t.value)))
    .join("");
}
