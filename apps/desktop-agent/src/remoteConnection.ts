import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { Client, type SFTPWrapper } from "ssh2";
import type { RemoteConnectRequest } from "@mobiusx/protocol";

/**
 * Phase D ("Connect via SSH") -- a real SSH connection + SFTP session,
 * manager-of-one, the same single-active-target model projectState.path
 * already uses for local projects (open a different remote and the
 * previous one is torn down, exactly like opening a different local
 * folder replaces the old project state). The live ssh2 Client and
 * SFTPWrapper live only here, in module state, never in projectState --
 * routes.ts and terminalWs.ts reach them through the functions below
 * rather than holding their own references, so there is exactly one place
 * a connection can go stale or get replaced.
 *
 * Honest scope note (same spirit as policy.ts's "advisory, not a sandbox"
 * doc comment): this does NOT verify the remote host's key against a
 * known_hosts store -- there is no TOFU/pinning UI yet, so a
 * man-in-the-middle on first connect to a given host would not be
 * detected. Comparable to every other real SSH-remote feature shipped
 * here in v1 scope (see the plan's Phase D boundary); only connect to
 * machines you trust the network path to.
 */
interface ActiveRemote {
  client: Client;
  sftp: SFTPWrapper;
  host: string;
  port: number;
  username: string;
  authMethod: RemoteConnectRequest["authMethod"];
  identityPath?: string;
}

let active: ActiveRemote | null = null;

/**
 * Real bug caught in Phase D live testing: a first Connect-via-SSH attempt
 * with an identity path typed as `~/.ssh/id_ed25519` failed with a raw
 * `ENOENT: no such file or directory, open '~/.ssh/...'` -- unlike a shell
 * or the real `ssh` CLI (which both expand a leading `~` themselves),
 * Node's readFileSync() takes the string completely literally, so `~`
 * becomes just another filename character. Expanding it ourselves here,
 * once, before it's used for anything, fixes every path it flows into:
 * the readFileSync() below, what gets stored for terminalWs.ts's `ssh -i`
 * argument, and a saved target's reconnect (which replays the same
 * identityPath string through this same function, including one saved
 * from a failed attempt before this fix existed -- it's expanded on use,
 * not just on first entry, so an already-saved `~`-path target is fixed
 * automatically too, no migration needed).
 */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return joinPath(homedir(), p.slice(2));
  return p;
}

export function getActiveSftp(): SFTPWrapper {
  if (!active) throw new Error("no remote connection open");
  return active.sftp;
}

/** Auth metadata for the active connection (used by terminalWs.ts to pick the
 * right `ssh` CLI flags) -- deliberately never includes password/passphrase,
 * which are used once at connect time and not retained after that. */
export function getActiveAuthMeta(): { authMethod: RemoteConnectRequest["authMethod"]; identityPath?: string } | null {
  if (!active) return null;
  return { authMethod: active.authMethod, identityPath: active.identityPath };
}

export function isRemoteConnected(): boolean {
  return active !== null;
}

export function disconnectRemote(): void {
  if (active) {
    try {
      active.client.end();
    } catch {
      // already closing / closed -- nothing left to clean up
    }
    active = null;
  }
}

/**
 * Runs a real command on the active remote over its own exec channel
 * (separate from the interactive terminal's PTY, and from the SFTP
 * subsystem) -- used for the one-shot `test -d .git` check in routes.ts's
 * POST /remote/connect. Not a general-purpose remote-exec API; this repo's
 * one real interactive shell is the PTY path in terminalWs.ts.
 */
export function execOnRemote(cmd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (!active) return Promise.reject(new Error("no remote connection open"));
  const client = active.client;
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      stream.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      stream.on("close", (code: number | null) => resolve({ stdout, stderr, code }));
      stream.on("error", reject);
    });
  });
}

/**
 * Opens a real SSH connection and SFTP session, verifies it actually works
 * (sftp.realpath), and replaces any previously-active remote connection.
 * Resolves `remotePath` (default "." -- the SFTP session's own home) to an
 * absolute path server-side, so the caller never has to guess the remote
 * home directory itself.
 */
export async function connectRemote(req: RemoteConnectRequest): Promise<{ resolvedPath: string }> {
  const port = req.port && Number.isInteger(req.port) && req.port > 0 ? req.port : 22;
  const client = new Client();

  const connectConfig: Record<string, unknown> = {
    host: req.host,
    port,
    username: req.username,
    readyTimeout: 15_000,
  };

  // Expanded once here (not just for the key-auth branch's own read below)
  // so terminalWs.ts's `ssh -i` argument and a saved target's identityPath
  // both get the same already-absolute path -- see expandHome()'s doc
  // comment for why this one call site is enough.
  let resolvedIdentityPath: string | undefined = req.identityPath ? expandHome(req.identityPath) : req.identityPath;

  if (req.authMethod === "key") {
    if (!resolvedIdentityPath) throw new Error("identityPath is required for key authentication");
    let keyBuf: Buffer;
    try {
      keyBuf = readFileSync(resolvedIdentityPath);
    } catch (err) {
      throw new Error(`couldn't read identity file at ${resolvedIdentityPath}: ${(err as Error).message}`);
    }
    connectConfig.privateKey = keyBuf;
    if (req.passphrase) connectConfig.passphrase = req.passphrase;
  } else if (req.authMethod === "password") {
    if (!req.password) throw new Error("password is required for password authentication");
    connectConfig.password = req.password;
  } else {
    // "agent" -- rely on a running ssh-agent (SSH_AUTH_SOCK), same as a
    // plain `ssh host` from a real terminal with no -i flag and no password.
    if (process.env.SSH_AUTH_SOCK) connectConfig.agent = process.env.SSH_AUTH_SOCK;
  }

  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    let settled = false;
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      reject(err);
    };
    client.once("error", onError);
    client.once("ready", () => {
      client.sftp((err, sftpSession) => {
        if (err) {
          onError(err);
          return;
        }
        settled = true;
        client.removeListener("error", onError);
        resolve(sftpSession);
      });
    });
    try {
      client.connect(connectConfig);
    } catch (err) {
      onError(err as Error);
    }
  });

  const resolvedPath = await new Promise<string>((resolve, reject) => {
    const startPath = req.remotePath && req.remotePath.trim() ? req.remotePath.trim() : ".";
    sftp.realpath(startPath, (err, abs) => {
      if (err) reject(new Error(`connected, but couldn't resolve remote path "${startPath}": ${err.message}`));
      else resolve(abs);
    });
  });

  disconnectRemote(); // replace any previous session, same as opening a new local project replaces the old one
  active = { client, sftp, host: req.host, port, username: req.username, authMethod: req.authMethod, identityPath: resolvedIdentityPath };
  client.on("close", () => {
    if (active && active.client === client) active = null;
  });

  return { resolvedPath };
}
