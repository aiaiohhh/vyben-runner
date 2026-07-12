import { spawn } from "node:child_process";
import type { RunnerJob } from "./contracts.js";

const FORWARDED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
] as const;

export interface AgentRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  cancelled: boolean;
  spawnError: string | null;
}

export interface AgentInvocation {
  command: "codex";
  args: readonly [
    "exec",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "--model",
    string,
    "-",
  ];
  task: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
}

export function agentEnvironment(
  source: NodeJS.ProcessEnv,
  job: RunnerJob,
  agentToken: string,
  apiBaseUrl: URL,
  workspace: string,
  codexHome: string,
  tempDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV || "production" };
  for (const name of FORWARDED_ENV) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return {
    ...env,
    CI: "true",
    CODEX_HOME: codexHome,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    GITHUB_WORKSPACE: workspace,
    VYBEN_AGENT_API_URL: apiBaseUrl.toString().replace(/\/$/, ""),
    VYBEN_AGENT_TOKEN: agentToken,
    VYBEN_JOB_ID: job.id,
    VYBEN_REPOSITORY: job.repository,
    VYBEN_TARGET_BRANCH: job.branch,
  };
}

export function runAgent(
  invocation: AgentInvocation,
  workspace: string,
  env: NodeJS.ProcessEnv,
  abortSignal?: AbortSignal,
  now: () => number = Date.now,
): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    const startedAt = now();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let cancelled = abortSignal?.aborted ?? false;
    let spawnError: string | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const child = spawn(invocation.command, invocation.args, {
      cwd: workspace,
      detached: process.platform !== "win32",
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may already have exited.
      }
    };
    const terminate = (): void => {
      kill("SIGTERM");
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => kill("SIGKILL"), 5_000);
        forceKillTimer.unref();
      }
    };

    const capture = (destination: Buffer[], chunk: Buffer | string): void => {
      if (outputLimitExceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = invocation.maxOutputBytes - capturedBytes;
      if (buffer.byteLength > remaining) {
        if (remaining > 0) destination.push(buffer.subarray(0, remaining));
        capturedBytes = invocation.maxOutputBytes;
        outputLimitExceeded = true;
        terminate();
        return;
      }
      destination.push(buffer);
      capturedBytes += buffer.byteLength;
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(invocation.task, "utf8");

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, invocation.timeoutSeconds * 1_000);
    timeout.unref();

    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (cancelled) terminate();

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      // A coding task must not leave background processes alive to race the
      // patch handoff or observe credentials used by later workflow steps.
      if (process.platform !== "win32") kill("SIGKILL");
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Math.max(0, now() - startedAt),
        timedOut,
        outputLimitExceeded,
        cancelled,
        spawnError,
      });
    });
  });
}
