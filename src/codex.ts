import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerJob } from "./contracts.js";
import { RunnerError } from "./errors.js";
import type { AgentInvocation } from "./process.js";

export interface CodexExecution {
  codexHome: string;
  tempDir: string;
  invocation: AgentInvocation;
  cleanup(): Promise<void>;
}

export async function prepareCodexExecution(
  job: RunnerJob,
  apiBaseUrl: URL,
  runnerTemp: string,
): Promise<CodexExecution> {
  if (job.executor.provider !== "codex_cli") {
    throw new RunnerError(
      "provider_not_implemented",
      `${job.executor.provider} is reserved for a future executor adapter`,
    );
  }

  const executionRoot = await mkdtemp(join(runnerTemp, "vyben-codex-"));
  const codexHome = join(executionRoot, "home");
  const tempDir = join(executionRoot, "tmp");
  const proxyBaseUrl = new URL(
    `${apiBaseUrl.pathname}/runner/openai/v1`,
    apiBaseUrl.origin,
  )
    .toString()
    .replace(/\/$/, "");
  const config = [
    `model = ${tomlString(job.executor.model)}`,
    'model_provider = "vyben"',
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    "",
    "[sandbox_workspace_write]",
    "network_access = false",
    "",
    "[model_providers.vyben]",
    'name = "Vyben job-scoped Responses proxy"',
    `base_url = ${tomlString(proxyBaseUrl)}`,
    'env_key = "VYBEN_AGENT_TOKEN"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");

  try {
    await Promise.all([
      mkdir(codexHome, { mode: 0o700 }),
      mkdir(tempDir, { mode: 0o700 }),
    ]);
    await writeFile(join(codexHome, "config.toml"), config, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    await rm(executionRoot, { recursive: true, force: true });
    throw new RunnerError(
      "codex_config_failed",
      "Could not create isolated Codex configuration",
      {
        cause: error,
      },
    );
  }

  return {
    codexHome,
    tempDir,
    invocation: {
      command: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--sandbox",
        "workspace-write",
        "--model",
        job.executor.model,
        "-",
      ],
      task: job.task,
      timeoutSeconds: job.limits.timeoutSeconds,
      maxOutputBytes: job.limits.maxOutputBytes,
    },
    async cleanup(): Promise<void> {
      await rm(executionRoot, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
