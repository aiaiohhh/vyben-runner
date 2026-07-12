export const RUNNER_KIND = "github_actions" as const;

export interface GitHubContext {
  repository: string;
  repositoryId: string;
  actorId: string;
  ref: string;
  sha: string;
  runId: string;
  runAttempt: number;
  workflowRef: string;
}

export interface ExchangeRequest {
  oidcToken: string;
  jobId: string;
  runner: typeof RUNNER_KIND;
  context: GitHubContext;
}

export interface ExchangeResponse {
  accessToken: string;
  expiresAt: string;
}

export interface RunnerJob {
  id: string;
  runner: typeof RUNNER_KIND;
  repository: string;
  baseRef: string;
  baseSha: string;
  branch: string;
  task: string;
  executor: {
    type: "local_cli";
    provider: "codex_cli" | "openclaw" | "hermes";
    model: string;
    capabilities: (
      | "workspace.read"
      | "workspace.write"
      | "tests.run"
      | "tile.context"
    )[];
  };
  limits: {
    timeoutSeconds: number;
    maxOutputBytes: number;
  };
  redactions: string[];
}

export interface RunnerEvent {
  kind: "status" | "output" | "warning" | "error";
  level: "debug" | "info" | "warning" | "error";
  message: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RunnerResult {
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  branch: string;
  baseSha: string;
  headSha: string | null;
  changedFiles: {
    path: string;
    additions: number;
    deletions: number;
  }[];
  tests: {
    name: string;
    status: "passed" | "failed" | "skipped";
    durationMs: number;
  }[];
  errorCode: string | null;
  errorMessage: string | null;
}

export interface FinalizeRequest {
  branch: string;
  baseSha: string;
  headSha: string;
  patchSha256: string;
}
