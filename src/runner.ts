import { RunnerApi } from "./api.js";
import { createRunnerArtifact } from "./artifact.js";
import { RefreshingTokenProvider } from "./auth.js";
import type { RunnerConfig } from "./config.js";
import { prepareCodexExecution } from "./codex.js";
import { RUNNER_KIND, type RunnerJob, type RunnerResult } from "./contracts.js";
import { RunnerError, toRunnerError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { parseJob } from "./job.js";
import { GitHubActionsOidcProvider } from "./oidc.js";
import { agentEnvironment, runAgent, type AgentRunResult } from "./process.js";
import { boundedMessage, Redactor } from "./redaction.js";
import { inspectWorkspace, type WorkspaceState } from "./workspace.js";

const LOG_CHUNK_CHARACTERS = 3_500;

export interface RunnerDependencies {
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface RunnerExecution {
  result: RunnerResult;
  artifactPath: string | null;
}

export async function executeRunner(
  config: RunnerConfig,
  dependencies: RunnerDependencies = {},
): Promise<RunnerExecution> {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const env = dependencies.env || process.env;
  const now = dependencies.now || Date.now;
  const redactor = new Redactor();
  redactor.add(config.oidcRequestToken);

  const oidc = new GitHubActionsOidcProvider(
    config.oidcRequestUrl,
    config.oidcRequestToken,
    config.oidcAudience,
    fetchImpl,
  );
  const tokens = new RefreshingTokenProvider(
    config.apiBaseUrl,
    config.jobId,
    config.github,
    oidc,
    (secret) => redactor.add(secret),
    fetchImpl,
    now,
  );
  const api = new RunnerApi(config.apiBaseUrl, config.jobId, tokens, fetchImpl);
  let job: RunnerJob | undefined;

  try {
    job = parseJob(await api.getJob(), config);
    for (const secret of job.redactions) redactor.add(secret);

    const initialWorkspace = await inspectWorkspace(config.workspace, env);
    if (
      initialWorkspace.headSha !== job.baseSha ||
      initialWorkspace.changedFiles.length > 0
    ) {
      throw new RunnerError(
        "workspace_mismatch",
        "Checked-out workspace does not match the clean job base SHA",
      );
    }

    await api.postEvent({
      kind: "status",
      level: "info",
      message: "GitHub Actions runner started",
      metadata: {
        at: new Date(now()).toISOString(),
        runner: RUNNER_KIND,
        branch: job.branch,
      },
    });

    // Refresh immediately before execution so the job-scoped token remains valid
    // for the full 15-minute MVP run and can authenticate only the agent proxy.
    const agentToken = await tokens.getToken(true);
    redactor.add(agentToken);
    const execution = await prepareCodexExecution(
      job,
      config.apiBaseUrl,
      config.runnerTemp,
    );
    let result: AgentRunResult;
    try {
      result = await runAgent(
        execution.invocation,
        initialWorkspace.path,
        agentEnvironment(
          env,
          job,
          agentToken,
          config.apiBaseUrl,
          initialWorkspace.path,
          execution.codexHome,
          execution.tempDir,
        ),
        dependencies.abortSignal,
        now,
      );
    } finally {
      await execution.cleanup();
    }

    await postLogs(api, redactor.redact(result.stdout), "stdout", now);
    await postLogs(api, redactor.redact(result.stderr), "stderr", now);

    let workspace: WorkspaceState;
    try {
      workspace = await inspectWorkspace(initialWorkspace.path, env);
    } catch (error) {
      const failure = toRunnerError(error);
      const report = createResult(
        job,
        result,
        undefined,
        failure.code,
        redactor.redact(failure.message),
      );
      await api.postResult(report);
      return { result: report, artifactPath: null };
    }

    let report = createResult(job, result, workspace);
    let artifactPath: string | null = null;
    if (report.status === "succeeded") {
      try {
        const artifact = await createRunnerArtifact(
          job,
          report,
          workspace,
          config.runnerTemp,
          env,
          new Date(now()).toISOString(),
        );
        artifactPath = artifact.path;
      } catch (error) {
        const failure = toRunnerError(error);
        report = createResult(
          job,
          result,
          workspace,
          failure.code,
          redactor.redact(failure.message),
        );
      }
    }
    await api.postResult(report);
    return { result: report, artifactPath };
  } catch (error) {
    const failure = toRunnerError(error);
    if (job) {
      const report: RunnerResult = {
        status: dependencies.abortSignal?.aborted ? "cancelled" : "failed",
        summary: dependencies.abortSignal?.aborted
          ? "Runner was cancelled."
          : "Runner failed before the agent completed.",
        branch: job.branch,
        baseSha: job.baseSha,
        headSha: null,
        changedFiles: [],
        tests: [],
        errorCode: failure.code,
        errorMessage: boundedMessage(redactor.redact(failure.message)),
      };
      try {
        await api.postResult(report);
      } catch {
        // Preserve the original failure; result delivery uses an idempotency key.
      }
    }
    throw new RunnerError(
      failure.code,
      boundedMessage(redactor.redact(failure.message)),
      { cause: failure },
    );
  }
}

function createResult(
  job: RunnerJob,
  run: AgentRunResult,
  workspace?: WorkspaceState,
  overrideCode?: string,
  overrideMessage?: string,
): RunnerResult {
  const cancelled = run.cancelled;
  const succeeded =
    !overrideCode &&
    !cancelled &&
    !run.timedOut &&
    !run.outputLimitExceeded &&
    !run.spawnError &&
    run.exitCode === 0;
  const status: RunnerResult["status"] = cancelled
    ? "cancelled"
    : succeeded
      ? "succeeded"
      : "failed";
  const errorCode = overrideCode || classifyFailure(run);
  const changedFiles = (workspace?.changedFiles || []).slice(0, 200);
  const summary =
    status === "succeeded"
      ? `Agent completed with ${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}.`
      : status === "cancelled"
        ? "Agent execution was cancelled."
        : "Agent execution failed.";
  return {
    status,
    summary,
    branch: job.branch,
    baseSha: job.baseSha,
    headSha: workspace?.headSha || null,
    changedFiles,
    tests: [
      {
        name: `${job.executor.provider} execution`,
        status:
          status === "succeeded"
            ? "passed"
            : status === "cancelled"
              ? "skipped"
              : "failed",
        durationMs: Math.min(run.durationMs, 900_000),
      },
    ],
    errorCode,
    errorMessage: errorCode
      ? boundedMessage(overrideMessage || failureMessage(run))
      : null,
  };
}

function classifyFailure(run: AgentRunResult): string | null {
  if (run.cancelled) return "agent_cancelled";
  if (run.timedOut) return "agent_timeout";
  if (run.outputLimitExceeded) return "agent_output_limit";
  if (run.spawnError) return "agent_spawn_failed";
  if (run.exitCode !== 0) return "agent_exit_nonzero";
  return null;
}

function failureMessage(run: AgentRunResult): string {
  if (run.cancelled) return "Agent process was cancelled";
  if (run.timedOut) return "Agent exceeded the 15-minute execution limit";
  if (run.outputLimitExceeded)
    return "Agent exceeded the configured output limit";
  if (run.spawnError) return "Agent process could not be started";
  return `Agent exited with code ${run.exitCode ?? "unknown"}`;
}

async function postLogs(
  api: RunnerApi,
  output: string,
  stream: "stdout" | "stderr",
  now: () => number,
): Promise<void> {
  for (let offset = 0; offset < output.length; offset += LOG_CHUNK_CHARACTERS) {
    const message = output.slice(offset, offset + LOG_CHUNK_CHARACTERS);
    if (!message.trim()) continue;
    await api.postEvent({
      kind: "output",
      level: stream === "stdout" ? "info" : "warning",
      message,
      metadata: { stream, at: new Date(now()).toISOString() },
    });
  }
}
