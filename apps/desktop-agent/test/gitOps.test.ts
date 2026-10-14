import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitCommit, gitHasRemote, gitInit, gitPush } from "../src/gitOps.js";

const run = promisify(execFile);

/**
 * A real, local-only git repo (no network, no real remote) with a committer
 * identity set LOCALLY (--local, not --global) so these tests never depend
 * on -- or mutate -- the sandbox's global git config.
 */
async function makeRepoFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-gitops-test-"));
  await run("git", ["init"], { cwd: dir });
  await run("git", ["config", "--local", "user.name", "MobiusX Test"], { cwd: dir });
  await run("git", ["config", "--local", "user.email", "test@mobiusx.ai"], { cwd: dir });
  return dir;
}

test("gitCommit stages the given paths and creates a real commit", async () => {
  const dir = await makeRepoFixture();
  await writeFile(join(dir, "a.txt"), "hello\n");
  await writeFile(join(dir, "b.txt"), "world\n");

  const result = await gitCommit(dir, ["a.txt"], "Add a.txt");
  assert.equal(result.committed, true);
  assert.match(result.hash ?? "", /^[0-9a-f]{40}$/);

  // b.txt was never staged -- confirm only a.txt is actually tracked.
  const { stdout } = await run("git", ["ls-files"], { cwd: dir });
  assert.deepEqual(stdout.trim().split("\n"), ["a.txt"]);
});

test("gitCommit reports committed:false when nothing is staged", async () => {
  const dir = await makeRepoFixture();
  await writeFile(join(dir, "a.txt"), "hello\n");
  const first = await gitCommit(dir, ["a.txt"], "Add a.txt");
  assert.equal(first.committed, true);

  // Same content, same path -- nothing new to stage the second time.
  const second = await gitCommit(dir, ["a.txt"], "Add a.txt again");
  assert.equal(second.committed, false);
  assert.equal(second.hash, null);
});

test("gitCommit with no paths stages everything (git add -A)", async () => {
  const dir = await makeRepoFixture();
  await writeFile(join(dir, "a.txt"), "hello\n");
  await writeFile(join(dir, "b.txt"), "world\n");
  const result = await gitCommit(dir, [], "Add everything");
  assert.equal(result.committed, true);
  const { stdout } = await run("git", ["ls-files"], { cwd: dir });
  assert.deepEqual(stdout.trim().split("\n").sort(), ["a.txt", "b.txt"]);
});

test("gitHasRemote is false for a fresh repo and true once a remote is added", async () => {
  const dir = await makeRepoFixture();
  assert.equal(await gitHasRemote(dir), false);
  await run("git", ["remote", "add", "origin", "https://example.invalid/repo.git"], { cwd: dir });
  assert.equal(await gitHasRemote(dir), true);
});

test("gitPush reports pushed:false with a clear reason when there's no remote", async () => {
  const dir = await makeRepoFixture();
  await writeFile(join(dir, "a.txt"), "hello\n");
  await gitCommit(dir, ["a.txt"], "Add a.txt");
  const result = await gitPush(dir);
  assert.equal(result.pushed, false);
  assert.equal(result.reason, "no remote configured");
});

test("gitInit makes a plain folder a real git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-gitops-test-noinit-"));
  await gitInit(dir);
  const { stdout } = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  assert.equal(stdout.trim(), "true");
});
