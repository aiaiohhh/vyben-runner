import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import type { RunnerEvent, RunnerResult } from "../src/contracts.js";
import { executeRunner } from "../src/runner.js";
import { runnerConfig, runnerJob } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("executes the fixed Codex adapter and produces a redacted finalize artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "vyben-runner-integration-"));
  const workspace = join(root, "workspace");
  const runnerTemp = join(root, "runner-temp");
  const bin = join(root, "bin");
  try {
    const { mkdir } = await import("node:fs/promises");
    await Promise.all([mkdir(workspace), mkdir(runnerTemp), mkdir(bin)]);
    await git(workspace, "init");
    await git(workspace, "config", "user.name", "Test");
    await git(workspace, "config", "user.email", "test@example.com");
    await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
    await git(workspace, "add", "base.txt");
    await git(workspace, "commit", "-m", "base");
    const baseSha = (await git(workspace, "rev-parse", "HEAD")).trim();
    const codex = join(bin, "codex");
    await writeFile(
      codex,
      `#!/usr/bin/env node
const fs = require("node:fs");
let task = "";
process.stdin.on("data", (chunk) => task += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync("generated.txt", task + "\\n");
  console.error(process.env.VYBEN_AGENT_TOKEN);
  console.error("CODEX_HOME=" + process.env.CODEX_HOME);
  console.error("TMPDIR=" + process.env.TMPDIR);
});
`,
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(codex, 0o700);

    const now = Date.parse("2026-07-11T00:00:00.000Z");
    const events: RunnerEvent[] = [];
    let postedResult: RunnerResult | undefined;
    let exchanges = 0;
    const config = runnerConfig({
      workspace,
      runnerTemp,
      github: { ...runnerConfig().github, sha: baseSha },
    });
    const job = runnerJob({ baseSha, task: "Create the generated file" });
    const execution = await executeRunner(config, {
      now: () => now,
      env: {
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        OPENAI_API_KEY: "must-not-reach-codex",
      },
      fetchImpl: async (input, init) => {
        const url = new URL(input.toString());
        if (url.hostname.endsWith("actions.githubusercontent.com")) {
          return Response.json({ value: "header.payload.signature" });
        }
        if (url.pathname === "/api/runner/exchange") {
          exchanges += 1;
          return Response.json({
            accessToken: `job-scoped-access-token-${exchanges}`,
            expiresAt: new Date(now + 900_000).toISOString(),
          });
        }
        if (
          url.pathname.endsWith(`/runner/jobs/${job.id}`) &&
          init?.method === "GET"
        ) {
          return Response.json(job);
        }
        if (url.pathname.endsWith("/events")) {
          events.push(JSON.parse(String(init?.body)) as RunnerEvent);
          return new Response(null, { status: 204 });
        }
        if (url.pathname.endsWith("/result")) {
          postedResult = JSON.parse(String(init?.body)) as RunnerResult;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    assert.equal(execution.result.status, "succeeded");
    assert.ok(execution.artifactPath);
    assert.deepEqual(execution.result.changedFiles, [
      { path: "generated.txt", additions: 0, deletions: 0 },
    ]);
    assert.equal(postedResult?.status, "succeeded");
    assert.equal(
      await readFile(join(workspace, "generated.txt"), "utf8"),
      "Create the generated file\n",
    );
    const serializedEvents = JSON.stringify(events);
    assert.doesNotMatch(serializedEvents, /job-scoped-access-token/);
    assert.match(serializedEvents, /\[REDACTED\]/);
    const codexHome = events
      .map((event) => event.message.match(/CODEX_HOME=([^\s]+)/)?.[1])
      .find(Boolean);
    const agentTemp = events
      .map((event) => event.message.match(/TMPDIR=([^\s]+)/)?.[1])
      .find(Boolean);
    assert.ok(codexHome);
    assert.ok(agentTemp);
    await assert.rejects(access(codexHome));
    await assert.rejects(access(agentTemp));
    assert.equal(
      JSON.parse(
        await readFile(join(execution.artifactPath!, "manifest.json"), "utf8"),
      ).jobId,
      job.id,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}
