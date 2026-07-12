import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  agentEnvironment,
  runAgent,
  type AgentInvocation,
} from "../src/process.js";
import { runnerJob } from "./helpers.js";

const BASE_INVOCATION: AgentInvocation = {
  command: "codex",
  args: [
    "exec",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "--model",
    "gpt-5.3-codex",
    "-",
  ],
  task: "task",
  timeoutSeconds: 2,
  maxOutputBytes: 4_096,
};

test("passes the task on stdin without a shell and strips parent secrets", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vyben-process-test-"));
  const marker = join(workspace, "should-not-exist");
  const shim = await codexShim(`
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => console.log(JSON.stringify({
  args: process.argv.slice(2),
  input,
  actionsToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  openaiKey: process.env.OPENAI_API_KEY,
  runnerToken: process.env.VYBEN_RUNNER_TOKEN,
  agentToken: process.env.VYBEN_AGENT_TOKEN,
  codexHome: process.env.CODEX_HOME,
  tmpdir: process.env.TMPDIR,
  tmp: process.env.TMP,
  temp: process.env.TEMP,
})));
`);
  try {
    const task = `$(touch ${marker}); echo not-a-shell`;
    const source: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: `${shim.bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      TMPDIR: "/parent-controlled-temp",
      TMP: "/parent-controlled-tmp",
      TEMP: "/parent-controlled-temp-win",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-secret",
      OPENAI_API_KEY: "real-provider-secret",
      VYBEN_RUNNER_TOKEN: "runner-secret",
    };
    const env = agentEnvironment(
      source,
      runnerJob({ task }),
      "job-scoped-agent-token",
      new URL("https://api.vyben.example/api"),
      workspace,
      shim.bin,
      join(workspace, "agent-temp"),
    );
    const result = await runAgent({ ...BASE_INVOCATION, task }, workspace, env);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.input, task);
    assert.equal(output.actionsToken, undefined);
    assert.equal(output.openaiKey, undefined);
    assert.equal(output.runnerToken, undefined);
    assert.equal(output.agentToken, "job-scoped-agent-token");
    assert.equal(output.codexHome, shim.bin);
    assert.equal(output.tmpdir, join(workspace, "agent-temp"));
    assert.equal(output.tmp, join(workspace, "agent-temp"));
    assert.equal(output.temp, join(workspace, "agent-temp"));
    await assert.rejects(
      import("node:fs/promises").then(({ access }) => access(marker)),
    );
  } finally {
    await Promise.all([
      shim.cleanup(),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
});

test("terminates an executor that exceeds its timeout", async () => {
  const shim = await codexShim("setInterval(() => undefined, 1000);");
  try {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: `${shim.bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
    };
    const result = await runAgent(
      { ...BASE_INVOCATION, timeoutSeconds: 0.05 },
      shim.bin,
      env,
    );
    assert.equal(result.timedOut, true);
    assert.notEqual(result.signal, null);
  } finally {
    await shim.cleanup();
  }
});

test("terminates an executor that exceeds its output budget", async () => {
  const shim = await codexShim('process.stdout.write("x".repeat(4096));');
  try {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: `${shim.bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
    };
    const result = await runAgent(
      { ...BASE_INVOCATION, maxOutputBytes: 64 },
      shim.bin,
      env,
    );
    assert.equal(result.outputLimitExceeded, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 64);
  } finally {
    await shim.cleanup();
  }
});

async function codexShim(
  source: string,
): Promise<{ bin: string; cleanup(): Promise<void> }> {
  const bin = await mkdtemp(join(tmpdir(), "vyben-codex-shim-"));
  const path = join(bin, "codex");
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(path, 0o700);
  return { bin, cleanup: () => rm(bin, { recursive: true, force: true }) };
}
