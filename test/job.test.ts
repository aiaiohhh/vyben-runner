import assert from "node:assert/strict";
import test from "node:test";
import { RunnerError } from "../src/errors.js";
import { parseJob } from "../src/job.js";
import { JOB_ID, runnerConfig, runnerJob } from "./helpers.js";

test("accepts a provider-neutral local executor", () => {
  const parsed = parseJob(runnerJob(), runnerConfig());
  assert.equal(parsed.executor.provider, "codex_cli");
  assert.equal(parsed.executor.model, "gpt-5.3-codex");
  assert.deepEqual(parsed.executor.capabilities, [
    "workspace.read",
    "workspace.write",
    "tests.run",
  ]);
});

test("accepts future providers only through the local allowlisted executor", () => {
  const parsed = parseJob(
    runnerJob({
      executor: {
        type: "local_cli",
        provider: "hermes",
        model: "gpt-5.3-codex",
        capabilities: ["tile.context"],
      },
    }),
    runnerConfig(),
  );
  assert.equal(parsed.executor.provider, "hermes");
  assert.equal(parsed.executor.model, "gpt-5.3-codex");
});

test("rejects direct-main and non-job branches", () => {
  for (const branch of ["main", "vyben/another-job", `vyben/${JOB_ID}/extra`]) {
    assert.throws(
      () => parseJob(runnerJob({ branch }), runnerConfig()),
      (error: unknown) => error instanceof RunnerError,
    );
  }
});

test("rejects repository, ref, and SHA mismatches", () => {
  for (const patch of [
    { repository: "attacker/repo" },
    { baseRef: "refs/heads/other" },
    { baseSha: "b".repeat(40) },
  ]) {
    assert.throws(
      () => parseJob(runnerJob(patch), runnerConfig()),
      (error: unknown) =>
        error instanceof RunnerError && error.code.endsWith("_mismatch"),
    );
  }
});

test("rejects server-supplied commands, arguments, and model injection", () => {
  for (const executor of [
    { ...runnerJob().executor, command: "bash" },
    {
      ...runnerJob().executor,
      args: ["--dangerously-bypass-approvals-and-sandbox"],
    },
    { ...runnerJob().executor, model: 'model"\nmodel_provider="attacker"' },
  ]) {
    assert.throws(
      () =>
        parseJob(runnerJob({ executor: executor as never }), runnerConfig()),
      (error: unknown) => error instanceof RunnerError,
    );
  }
});

test("rejects network executor types and undeclared capabilities", () => {
  const raw = runnerJob() as unknown as Record<string, unknown>;
  raw.executor = {
    ...runnerJob().executor,
    type: "remote_api",
    capabilities: ["network.control"],
  };
  assert.throws(
    () => parseJob(raw, runnerConfig()),
    (error: unknown) =>
      error instanceof RunnerError && error.code === "invalid_job",
  );
});
