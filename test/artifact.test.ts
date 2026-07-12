import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { createRunnerArtifact } from "../src/artifact.js";
import type { RunnerResult } from "../src/contracts.js";
import { RunnerError } from "../src/errors.js";
import { inspectWorkspace, parseChangedFiles } from "../src/workspace.js";
import { runnerJob } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("creates a bounded binary patch that applies to a clean base checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "vyben-artifact-test-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const artifacts = join(root, "artifacts");
  try {
    await Promise.all([
      import("node:fs/promises").then(({ mkdir }) => mkdir(source)),
      import("node:fs/promises").then(({ mkdir }) => mkdir(artifacts)),
    ]);
    await git(source, "init");
    await git(source, "config", "user.name", "Test");
    await git(source, "config", "user.email", "test@example.com");
    await writeFile(join(source, "tracked.txt"), "before\n", "utf8");
    await git(source, "add", "tracked.txt");
    await git(source, "commit", "-m", "base");
    const baseSha = (await git(source, "rev-parse", "HEAD")).trim();
    await git(root, "clone", "--no-hardlinks", source, target);

    await writeFile(join(source, "tracked.txt"), "after\n", "utf8");
    await writeFile(join(source, "new file.txt"), "new\n", "utf8");
    const workspace = await inspectWorkspace(source, env());
    const result = successfulResult(baseSha, workspace.changedFiles);
    const artifact = await createRunnerArtifact(
      runnerJob({ baseSha }),
      result,
      workspace,
      artifacts,
      env(),
      "2026-07-11T00:00:00.000Z",
    );

    const patch = await readFile(join(artifact.path, "changes.patch"));
    assert.ok(patch.byteLength > 0);
    assert.equal(artifact.manifest.patchSha256.length, 64);
    await git(
      target,
      "apply",
      "--check",
      "--index",
      "--binary",
      join(artifact.path, "changes.patch"),
    );
    await git(
      target,
      "apply",
      "--index",
      "--binary",
      join(artifact.path, "changes.patch"),
    );
    assert.equal(
      await readFile(join(target, "tracked.txt"), "utf8"),
      "after\n",
    );
    assert.equal(await readFile(join(target, "new file.txt"), "utf8"), "new\n");
    assert.equal(
      JSON.parse(await readFile(join(artifact.path, "result.json"), "utf8"))
        .status,
      "succeeded",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to create a finalize artifact when the agent made no changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "vyben-no-change-test-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await git(root, "add", "base.txt");
    await git(root, "commit", "-m", "base");
    const baseSha = (await git(root, "rev-parse", "HEAD")).trim();
    const workspace = await inspectWorkspace(root, env());
    await assert.rejects(
      createRunnerArtifact(
        runnerJob({ baseSha }),
        successfulResult(baseSha, []),
        workspace,
        root,
        env(),
        "2026-07-11T00:00:00.000Z",
      ),
      (error: unknown) =>
        error instanceof RunnerError && error.code === "no_changes",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects submodules before any post-agent Git traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "vyben-submodule-test-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await git(root, "add", "base.txt");
    await git(root, "commit", "-m", "base");
    const head = (await git(root, "rev-parse", "HEAD")).trim();
    await git(
      root,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head},nested`,
    );
    await git(root, "commit", "-m", "add gitlink");
    await assert.rejects(
      inspectWorkspace(root, env()),
      (error: unknown) =>
        error instanceof RunnerError && error.code === "unsupported_submodule",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspects repositories whose index exceeds the default Git output cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "vyben-large-index-test-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.com");
    const files = Array.from(
      { length: 900 },
      (_, index) =>
        `file-${index.toString().padStart(4, "0")}-${"x".repeat(105)}.txt`,
    );
    for (let offset = 0; offset < files.length; offset += 50) {
      await Promise.all(
        files
          .slice(offset, offset + 50)
          .map((path) => writeFile(join(root, path), "x", "utf8")),
      );
    }
    await git(root, "add", ".");
    await git(root, "commit", "-m", "large index");
    assert.ok(
      Buffer.byteLength(await git(root, "ls-files", "--stage", "-z")) > 131_072,
    );

    const workspace = await inspectWorkspace(root, env());
    assert.deepEqual(workspace.changedFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe paths instead of omitting them from change accounting", () => {
  for (const porcelain of [
    "?? ../escape\0",
    "?? /absolute\0",
    `?? ${"x".repeat(1_025)}\0`,
    "??\0",
  ]) {
    assert.throws(
      () => parseChangedFiles(porcelain),
      (error: unknown) =>
        error instanceof RunnerError && error.code === "invalid_changed_path",
    );
  }
});

function successfulResult(
  baseSha: string,
  changedFiles: RunnerResult["changedFiles"],
): RunnerResult {
  return {
    status: "succeeded",
    summary: "Agent completed.",
    branch: runnerJob().branch,
    baseSha,
    headSha: baseSha,
    changedFiles,
    tests: [{ name: "codex_cli execution", status: "passed", durationMs: 1 }],
    errorCode: null,
    errorMessage: null,
  };
}

function env(): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}
