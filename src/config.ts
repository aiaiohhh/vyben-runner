import { resolve } from "node:path";
import type { GitHubContext } from "./contracts.js";
import { RunnerError } from "./errors.js";
import {
  positiveInteger,
  repository,
  requiredString,
  sha,
  uuid,
} from "./validation.js";

const MAX_AGENT_SECONDS = 900;
const MAX_OUTPUT_BYTES = 1_048_576;
const VYBEN_API_BASE_URL = "https://api.vyben.app/api";
const VYBEN_OIDC_AUDIENCE_BASE = `${VYBEN_API_BASE_URL}/runner/exchange`;

export interface RunnerConfig {
  apiBaseUrl: URL;
  oidcAudience: string;
  oidcRequestUrl: URL;
  oidcRequestToken: string;
  jobId: string;
  workspace: string;
  runnerTemp: string;
  maxAgentSeconds: number;
  maxOutputBytes: number;
  github: GitHubContext;
}

export function actionInput(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const toolkitName = `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
  return env[toolkitName] || env[toolkitName.replaceAll("-", "_")];
}

function input(
  env: NodeJS.ProcessEnv,
  name: string,
  actionName: string,
): string | undefined {
  return env[name] || actionInput(env, actionName);
}

function parseOidcUrl(value: unknown): URL {
  const parsed = requiredString(value, "ACTIONS_ID_TOKEN_REQUEST_URL", 2_048);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new RunnerError(
      "invalid_environment",
      "ACTIONS_ID_TOKEN_REQUEST_URL must be an absolute URL",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new RunnerError(
      "invalid_environment",
      "OIDC request URL must use HTTPS without credentials or a fragment",
    );
  }
  if (
    url.hostname !== "pipelines.actions.githubusercontent.com" &&
    !url.hostname.endsWith(".actions.githubusercontent.com")
  ) {
    throw new RunnerError(
      "invalid_environment",
      "OIDC request URL is not a GitHub Actions endpoint",
    );
  }
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const repo = repository(env.GITHUB_REPOSITORY);
  if (
    !/^\d+$/.test(env.GITHUB_REPOSITORY_ID || "") ||
    !/^\d+$/.test(env.GITHUB_ACTOR_ID || "") ||
    !/^\d+$/.test(env.GITHUB_RUN_ID || "")
  ) {
    throw new RunnerError(
      "invalid_environment",
      "GitHub numeric identifiers are missing or invalid",
    );
  }
  const workflowRef = requiredString(
    env.GITHUB_WORKFLOW_REF,
    "GITHUB_WORKFLOW_REF",
    512,
  );
  if (
    !workflowRef.startsWith(`${repo}/.github/workflows/`) ||
    !workflowRef.includes("@refs/")
  ) {
    throw new RunnerError(
      "invalid_environment",
      "GITHUB_WORKFLOW_REF does not match the repository",
    );
  }

  const jobId = uuid(input(env, "VYBEN_JOB_ID", "job-id"));
  const runAttempt = positiveInteger(
    env.GITHUB_RUN_ATTEMPT,
    "GITHUB_RUN_ATTEMPT",
    1,
    1_000,
  );
  if (runAttempt !== 1) {
    throw new RunnerError(
      "invalid_environment",
      "Workflow reruns require a new Vyben job",
    );
  }

  return {
    apiBaseUrl: new URL(VYBEN_API_BASE_URL),
    oidcAudience: `${VYBEN_OIDC_AUDIENCE_BASE}#${jobId}`,
    oidcRequestUrl: parseOidcUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL),
    oidcRequestToken: requiredString(
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      "OIDC request token",
      16_384,
    ),
    jobId,
    workspace: resolve(
      requiredString(env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE", 4_096),
    ),
    runnerTemp: resolve(requiredString(env.RUNNER_TEMP, "RUNNER_TEMP", 4_096)),
    maxAgentSeconds: positiveInteger(
      env.VYBEN_MAX_AGENT_SECONDS || MAX_AGENT_SECONDS,
      "max agent seconds",
      1,
      MAX_AGENT_SECONDS,
    ),
    maxOutputBytes: positiveInteger(
      env.VYBEN_MAX_OUTPUT_BYTES || 262_144,
      "max output bytes",
      1_024,
      MAX_OUTPUT_BYTES,
    ),
    github: {
      repository: repo,
      repositoryId: requiredString(
        env.GITHUB_REPOSITORY_ID,
        "GITHUB_REPOSITORY_ID",
        32,
      ),
      actorId: requiredString(env.GITHUB_ACTOR_ID, "GITHUB_ACTOR_ID", 32),
      ref: requiredString(env.GITHUB_REF, "GITHUB_REF", 512),
      sha: sha(env.GITHUB_SHA, "GITHUB_SHA"),
      runId: requiredString(env.GITHUB_RUN_ID, "GITHUB_RUN_ID", 32),
      runAttempt,
      workflowRef,
    },
  };
}
