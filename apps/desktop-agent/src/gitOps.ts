import { spawn } from "node:child_process";
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

export async function gitDiff(cwd: string, path: string, staged = false): Promise<GitDiffResponse> {
  const args = ["diff", ...(staged ? ["--staged"] : []), "--", path];
  const { stdout } = await runGit(cwd, args);
  return { path, diff: stdout };
}
