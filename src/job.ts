import type { RunnerConfig } from "./config.js";
import { RUNNER_KIND, type RunnerJob } from "./contracts.js";
import { RunnerError } from "./errors.js";
import {
  branch,
  isRecord,
  positiveInteger,
  repository,
  requiredString,
  sha,
  uuid,
} from "./validation.js";

const MAX_TASK_BYTES = 32_768;
const PROVIDERS = new Set(["codex_cli", "openclaw", "hermes"] as const);
const CAPABILITIES = new Set([
  "workspace.read",
  "workspace.write",
  "tests.run",
  "tile.context",
] as const);

export function parseJob(value: unknown, config: RunnerConfig): RunnerJob {
  if (!isRecord(value))
    throw new RunnerError("invalid_job", "Vyben returned an invalid job");

  const id = uuid(value.id);
  if (id !== config.jobId)
    throw new RunnerError(
      "job_mismatch",
      "Returned job ID does not match this run",
    );
  if (value.runner !== RUNNER_KIND)
    throw new RunnerError(
      "runner_mismatch",
      "Job is not assigned to GitHub Actions",
    );

  const repo = repository(value.repository);
  if (repo.toLowerCase() !== config.github.repository.toLowerCase()) {
    throw new RunnerError(
      "repository_mismatch",
      "Job repository does not match the GitHub workflow",
    );
  }
  const baseRef = requiredString(value.baseRef, "base ref", 512);
  if (baseRef !== config.github.ref)
    throw new RunnerError(
      "ref_mismatch",
      "Job base ref does not match the workflow ref",
    );
  const baseSha = sha(value.baseSha, "base SHA");
  if (baseSha !== config.github.sha)
    throw new RunnerError(
      "sha_mismatch",
      "Job base SHA does not match the checked-out revision",
    );

  const targetBranch = branch(value.branch);
  if (targetBranch !== `vyben/${config.jobId}`) {
    throw new RunnerError(
      "branch_mismatch",
      "Job branch must be vyben/<job-id>",
    );
  }

  const task = requiredString(value.task, "task", MAX_TASK_BYTES);
  if (
    Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES ||
    task.trim().length === 0
  ) {
    throw new RunnerError(
      "invalid_job",
      "Task must contain at most 32 KiB of text",
    );
  }

  if (!isRecord(value.executor) || value.executor.type !== "local_cli") {
    throw new RunnerError("invalid_job", "Job must use the local_cli executor");
  }
  if ("command" in value.executor || "args" in value.executor) {
    throw new RunnerError(
      "invalid_job",
      "Jobs cannot override the runner's fixed executor command",
    );
  }
  const provider = value.executor.provider;
  if (
    typeof provider !== "string" ||
    !PROVIDERS.has(provider as "codex_cli" | "openclaw" | "hermes")
  ) {
    throw new RunnerError("invalid_job", "Executor provider is not supported");
  }
  const model = requiredString(value.executor.model, "executor model", 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(model)) {
    throw new RunnerError("invalid_job", "Executor model is invalid");
  }
  if (
    !Array.isArray(value.executor.capabilities) ||
    value.executor.capabilities.length > CAPABILITIES.size
  ) {
    throw new RunnerError("invalid_job", "Executor capabilities are invalid");
  }
  const capabilities = value.executor.capabilities.map((capability) => {
    if (
      typeof capability !== "string" ||
      !CAPABILITIES.has(capability as "workspace.read")
    ) {
      throw new RunnerError(
        "invalid_job",
        "Executor capability is not supported",
      );
    }
    return capability as RunnerJob["executor"]["capabilities"][number];
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new RunnerError(
      "invalid_job",
      "Executor capabilities must be unique",
    );
  }

  if (!isRecord(value.limits))
    throw new RunnerError("invalid_job", "Job limits are missing");
  const timeoutSeconds = positiveInteger(
    value.limits.timeoutSeconds,
    "job timeout",
    1,
    config.maxAgentSeconds,
  );
  const maxOutputBytes = positiveInteger(
    value.limits.maxOutputBytes,
    "job output limit",
    1_024,
    config.maxOutputBytes,
  );

  const rawRedactions = value.redactions ?? [];
  if (!Array.isArray(rawRedactions) || rawRedactions.length > 32) {
    throw new RunnerError("invalid_job", "Job redactions are invalid");
  }
  const redactions = rawRedactions.map((entry, index) =>
    requiredString(entry, `redaction ${index + 1}`, 4_096),
  );

  return {
    id,
    runner: RUNNER_KIND,
    repository: repo,
    baseRef,
    baseSha,
    branch: targetBranch,
    task,
    executor: {
      type: "local_cli",
      provider: provider as RunnerJob["executor"]["provider"],
      model,
      capabilities,
    },
    limits: { timeoutSeconds, maxOutputBytes },
    redactions,
  };
}
