import type { RunnerConfig } from "../src/config.js";
import { RUNNER_KIND, type RunnerJob } from "../src/contracts.js";
import { tmpdir } from "node:os";

export const JOB_ID = "11111111-1111-4111-8111-111111111111";
export const BASE_SHA = "a".repeat(40);

export function validEnv(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    VYBEN_JOB_ID: JOB_ID,
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://pipelines.actions.githubusercontent.com/token?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token-that-is-secret",
    GITHUB_REPOSITORY: "aiaiohhh/example",
    GITHUB_REPOSITORY_ID: "123456",
    GITHUB_ACTOR_ID: "654321",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: BASE_SHA,
    GITHUB_RUN_ID: "987654",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF:
      "aiaiohhh/example/.github/workflows/vyben.yml@refs/heads/main",
    GITHUB_WORKSPACE: process.cwd(),
    RUNNER_TEMP: process.env.RUNNER_TEMP || tmpdir(),
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  return Object.assign(env, overrides);
}

export function runnerConfig(
  overrides: Partial<RunnerConfig> = {},
): RunnerConfig {
  return {
    apiBaseUrl: new URL("https://api.vyben.example/api"),
    oidcAudience: "https://api.vyben.example/runner",
    oidcRequestUrl: new URL(
      "https://pipelines.actions.githubusercontent.com/token?api-version=2.0",
    ),
    oidcRequestToken: "github-request-token-that-is-secret",
    jobId: JOB_ID,
    workspace: process.cwd(),
    runnerTemp: process.env.RUNNER_TEMP || tmpdir(),
    maxAgentSeconds: 900,
    maxOutputBytes: 262_144,
    github: {
      repository: "aiaiohhh/example",
      repositoryId: "123456",
      actorId: "654321",
      ref: "refs/heads/main",
      sha: BASE_SHA,
      runId: "987654",
      runAttempt: 1,
      workflowRef:
        "aiaiohhh/example/.github/workflows/vyben.yml@refs/heads/main",
    },
    ...overrides,
  };
}

export function runnerJob(overrides: Partial<RunnerJob> = {}): RunnerJob {
  return {
    id: JOB_ID,
    runner: RUNNER_KIND,
    repository: "aiaiohhh/example",
    baseRef: "refs/heads/main",
    baseSha: BASE_SHA,
    branch: `vyben/${JOB_ID}`,
    task: "Make the requested change",
    executor: {
      type: "local_cli",
      provider: "codex_cli",
      model: "gpt-5.3-codex",
      capabilities: ["workspace.read", "workspace.write", "tests.run"],
    },
    limits: { timeoutSeconds: 30, maxOutputBytes: 4_096 },
    redactions: [],
    ...overrides,
  };
}
