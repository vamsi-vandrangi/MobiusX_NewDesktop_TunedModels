import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  GitDiffResponse,
  GitLogEntry,
  GitLogResponse,
  GitStatusEntry,
  GitStatusResponse,
} from "@mobiusx/protocol";

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(stderr.trim() || `git ${args.join(" ")} exited with ${code}`));
        return;
      }
      resolve({ stdout, code });
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function gitStatus(cwd: string): Promise<GitStatusResponse> {
  const { stdout } = await runGit(cwd, ["status", "--porcelain=v1", "--branch"]);
  const lines = stdout.split("\n").filter((l) => l.length > 0);

  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];

  for (const line of lines) {
    if (line.startsWith("##")) {
      const header = line.slice(2).trim();
      const branchMatch = header.match(/^([^ .]+)/);
      branch = branchMatch ? branchMatch[1] : null;
      const aheadMatch = header.match(/ahead (\d+)/);
      const behindMatch = header.match(/behind (\d+)/);
      if (aheadMatch) ahead = Number(aheadMatch[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
      continue;
    }
    const index = line[0];
    const worktree = line[1];
    const path = line.slice(3);
    entries.push({ path, index, worktree });
  }

  return { branch, ahead, behind, entries };
}

export async function gitLog(cwd: string, limit = 50): Promise<GitLogResponse> {
  const format = "%H%x1f%an%x1f%aI%x1f%s%x1e";
  const { stdout } = await runGit(cwd, ["log", `-n`, String(limit), `--pretty=format:${format}`]);
  const entries: GitLogEntry[] = stdout
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter((rec) => rec.length > 0)
    .map((rec) => {
      const [hash, author, date, subject] = rec.split("\x1f");
      return { hash, author, date, subject };
    });
  return { entries };
}

export async function gitDiff(cwd: string, filePath: string, staged = false): Promise<GitDiffResponse> {
  const args = ["diff", ...(staged ? ["--staged"] : []), "--", filePath];
  const { stdout } = await runGit(cwd, args);
  return { path: filePath, diff: stdout };
}

export async function gitLogForPath(cwd: string, filePath: string, limit = 20): Promise<GitLogResponse> {
  const format = "%H%x1f%an%x1f%aI%x1f%s%x1e";
  const { stdout } = await runGit(cwd, ["log", "-n", String(limit), `--pretty=format:${format}`, "--", filePath]);
  const entries: GitLogEntry[] = stdout
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter((rec) => rec.length > 0)
    .map((rec) => {
      const [hash, author, date, subject] = rec.split("\x1f");
      return { hash, author, date, subject };
    });
  return { entries };
}

export async function gitInit(cwd: string): Promise<void> {
  await runGit(cwd, ["init"]);
}

export async function gitHasRemote(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(cwd, ["remote"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * "Commit & Push to Git" (observation: the app had ZERO commit/push
 * capability anywhere before this -- gitStatus/gitLog/gitDiff are all
 * read-only). Stages exactly `paths` (the files a build task actually
 * touched) rather than `git add -A`, so a dirty file the user hasn't
 * reviewed never rides along in the same commit; an empty/omitted `paths`
 * stages everything, for a manual "commit all" use from a future UI. Reports
 * `committed: false` (not an error) when nothing ended up staged -- e.g. the
 * applied content was byte-identical to what's already committed -- rather
 * than letting a bare `git commit` fail with a cryptic "nothing to commit"
 * the caller has to pattern-match on.
 */
export async function gitCommit(cwd: string, paths: string[], message: string): Promise<{ committed: boolean; hash: string | null }> {
  if (paths.length > 0) {
    await runGit(cwd, ["add", "--", ...paths]);
  } else {
    await runGit(cwd, ["add", "-A"]);
  }
  const { stdout: staged } = await runGit(cwd, ["diff", "--cached", "--name-only"]);
  if (staged.trim().length === 0) {
    return { committed: false, hash: null };
  }
  await runGit(cwd, ["commit", "-m", message]);
  const { stdout: hash } = await runGit(cwd, ["rev-parse", "HEAD"]);
  return { committed: true, hash: hash.trim() };
}

/**
 * Pushes the current branch to `origin`, setting upstream on first push
 * (`-u`) so every push after this one is a plain `git push` from the user's
 * own terminal too. Reports `pushed: false` with a real reason (no remote
 * configured; detached HEAD; the actual error git gave, e.g. an auth
 * failure) rather than throwing -- a project with no remote yet is the
 * expected common case right after New Project/Build, not a failure this
 * caller needs a try/catch for.
 */
export async function gitPush(cwd: string): Promise<{ pushed: boolean; reason?: string }> {
  const hasRemote = await gitHasRemote(cwd);
  if (!hasRemote) {
    return { pushed: false, reason: "no remote configured" };
  }
  const { stdout: branchOut } = await runGit(cwd, ["branch", "--show-current"]);
  const branch = branchOut.trim();
  if (!branch) {
    return { pushed: false, reason: "not on a branch (detached HEAD)" };
  }
  try {
    await runGit(cwd, ["push", "-u", "origin", branch]);
    return { pushed: true };
  } catch (err) {
    return { pushed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Builds an authenticated clone URL for a GitHub/GitLab personal access
 * token. GitHub accepts the token as the URL username with no password;
 * GitLab's convention is username "oauth2" with the token as the password.
 * Any other https(s) host falls back to the GitHub-style form, which is
 * also what most self-hosted Git servers (Gitea, Bitbucket Server, etc.)
 * accept.
 */
function injectPatIntoUrl(rawUrl: string, pat: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("That doesn't look like a valid repository URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("A personal access token can only be used with an http(s) clone URL.");
  }
  const isGitLab = /(^|\.)gitlab\.com$/i.test(parsed.hostname) || /gitlab/i.test(parsed.hostname);
  if (isGitLab) {
    parsed.username = "oauth2";
    parsed.password = pat;
  } else {
    parsed.username = pat;
    parsed.password = "";
  }
  return parsed.toString();
}

/** Strips a secret out of an error message before it's ever logged or returned to the renderer. */
function redact(message: string, secret?: string): string {
  if (!secret) return message;
  return message.split(secret).join("***");
}

/**
 * Clones `url` into `<parentDir>/<name>` (which must not already exist) and
 * returns the absolute path of the new checkout. `pat`, if given, is used
 * only to build the in-memory authenticated URL passed to `git clone` --
 * it is never written to disk here and is scrubbed from any error thrown.
 */
export async function gitClone(
  parentDir: string,
  name: string,
  url: string,
  pat?: string,
): Promise<{ path: string }> {
  const trimmedName = name.trim();
  if (!trimmedName || path.basename(trimmedName) !== trimmedName) {
    throw new Error("Folder name must not contain path separators.");
  }
  const dest = path.join(parentDir, trimmedName);
  if (fs.existsSync(dest)) {
    throw new Error(`"${trimmedName}" already exists in this folder.`);
  }
  const cloneUrl = pat ? injectPatIntoUrl(url, pat) : url;
  try {
    await runGit(parentDir, ["clone", "--", cloneUrl, dest]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort cleanup of a partial checkout so a retry doesn't hit the
    // "already exists" guard above for a clone that never actually succeeded.
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(redact(redact(message, pat), cloneUrl));
  }
  return { path: dest };
}
