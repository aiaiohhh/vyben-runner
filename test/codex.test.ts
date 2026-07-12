import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareCodexExecution } from "../src/codex.js";
import { RunnerError } from "../src/errors.js";
import { runnerJob } from "./helpers.js";

test("creates an isolated Codex home using only the job-scoped Responses proxy", async () => {
  const execution = await prepareCodexExecution(
    runnerJob(),
    new URL("https://api.vyben.example/api"),
    tmpdir(),
  );
  const configPath = `${execution.codexHome}/config.toml`;
  const config = await readFile(configPath, "utf8");
  assert.match(config, /model_provider = "vyben"/);
  assert.match(
    config,
    /base_url = "https:\/\/api\.vyben\.example\/api\/runner\/openai\/v1"/,
  );
  assert.match(config, /env_key = "VYBEN_AGENT_TOKEN"/);
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /sandbox_mode = "workspace-write"/);
  assert.doesNotMatch(
    config,
    /job-scoped-access-token|OPENAI_API_KEY|CODEX_API_KEY/,
  );
  assert.deepEqual(execution.invocation.args, [
    "exec",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "--model",
    "gpt-5.3-codex",
    "-",
  ]);
  if (process.platform !== "win32")
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(execution.tempDir)).isDirectory(), true);
  await execution.cleanup();
  await assert.rejects(access(execution.codexHome));
  await assert.rejects(access(execution.tempDir));
});

test("refuses future provider metadata until a dedicated adapter exists", async () => {
  await assert.rejects(
    prepareCodexExecution(
      runnerJob({
        executor: { ...runnerJob().executor, provider: "openclaw" },
      }),
      new URL("https://api.vyben.example/api"),
      tmpdir(),
    ),
    (error: unknown) =>
      error instanceof RunnerError && error.code === "provider_not_implemented",
  );
});
