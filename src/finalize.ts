import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { RunnerApi } from "./api.js";
import { MAX_PATCH_BYTES, type RunnerArtifactManifest } from "./artifact.js";
import { RefreshingTokenProvider } from "./auth.js";
import type { RunnerConfig } from "./config.js";
import { RunnerError } from "./errors.js";
import { runGit, safeGitEnvironment } from "./git.js";
import type { FetchLike } from "./http.js";
import { GitHubActionsOidcProvider } from "./oidc.js";
import {
  branch,
  isRecord,
  positiveInteger,
  requiredString,
  sha,
  uuid,
} from "./validation.js";
import { inspectWorkspace } from "./workspace.js";

export interface FinalizeDependencies {
  artifactPath: string;
  githubToken: string;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface FinalizeResult {
  branch: string;
  headSha: string;
}

export async function finalizeRunnerArtifact(
  config: RunnerConfig,
  dependencies: FinalizeDependencies,
): Promise<FinalizeResult> {
  const env = dependencies.env || process.env;
  const manifest = await readArtifact(config, dependencies.artifactPath);
  const workspace = await inspectWorkspace(config.workspace, env);
  if (
    workspace.headSha !== manifest.baseSha ||
    workspace.changedFiles.length > 0
  ) {
    throw new RunnerError(
      "workspace_mismatch",
      "Finalize workspace does not match the clean base SHA",
    );
  }
  await assertOrigin(workspace.path, manifest.repository, env);

  const artifactPath = await realpath(dependencies.artifactPath);
  const patchPath = resolve(artifactPath, "changes.patch");
  const gitEnv = safeGitEnvironment(env);
  await runGit(
    workspace.path,
    ["apply", "--check", "--index", "--binary", patchPath],
    {
      env: gitEnv,
      timeoutMs: 30_000,
    },
  );
  await runGit(workspace.path, ["apply", "--index", "--binary", patchPath], {
    env: gitEnv,
    timeoutMs: 30_000,
  });

  const commitEnv = safeGitEnvironment(env, {
    GIT_AUTHOR_DATE: manifest.createdAt,
    GIT_COMMITTER_DATE: manifest.createdAt,
  });
  await runGit(
    workspace.path,
    [
      "-c",
      "user.name=Vyben Runner",
      "-c",
      "user.email=runner@vyben.app",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      `Vyben: remote coding job ${manifest.jobId}`,
    ],
    { env: commitEnv, timeoutMs: 30_000 },
  );
  const headSha = sha(
    (
      await runGit(workspace.path, ["rev-parse", "--verify", "HEAD"], {
        env: gitEnv,
      })
    ).stdout
      .toString("utf8")
      .trim(),
    "finalized HEAD",
  );

  const finalization = {
    branch: manifest.branch,
    baseSha: manifest.baseSha,
    headSha,
    patchSha256: manifest.patchSha256,
  };
  const fetchImpl = dependencies.fetchImpl || fetch;
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
    () => undefined,
    fetchImpl,
    dependencies.now || Date.now,
  );
  const api = new RunnerApi(config.apiBaseUrl, config.jobId, tokens, fetchImpl);
  await api.beginFinalize(finalization);

  const authHeader = Buffer.from(
    `x-access-token:${dependencies.githubToken}`,
    "utf8",
  ).toString("base64");
  const pushEnv = safeGitEnvironment(env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authHeader}`,
  });
  const remoteHead = (
    await runGit(
      workspace.path,
      ["ls-remote", "--heads", "origin", `refs/heads/${manifest.branch}`],
      {
        env: pushEnv,
        timeoutMs: 30_000,
      },
    )
  ).stdout
    .toString("utf8")
    .trim()
    .split(/\s+/)[0];
  if (remoteHead && remoteHead !== headSha) {
    throw new RunnerError(
      "branch_exists",
      "The job branch already exists at a different commit",
    );
  }
  if (!remoteHead) {
    await runGit(
      workspace.path,
      ["push", "origin", `HEAD:refs/heads/${manifest.branch}`],
      {
        env: pushEnv,
        timeoutMs: 60_000,
      },
    );
  }

  await api.finalize(finalization);
  return { branch: manifest.branch, headSha };
}

async function readArtifact(
  config: RunnerConfig,
  inputPath: string,
): Promise<RunnerArtifactManifest> {
  const runnerTemp = await realpath(config.runnerTemp);
  const artifactPath = await realpath(
    resolve(requiredString(inputPath, "artifact path", 4_096)),
  );
  const relation = relative(runnerTemp, artifactPath);
  if (
    !relation ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    relation.startsWith(sep)
  ) {
    throw new RunnerError(
      "invalid_artifact",
      "Artifact must be inside RUNNER_TEMP",
    );
  }
  const manifestPath = resolve(artifactPath, "manifest.json");
  const patchPath = resolve(artifactPath, "changes.patch");
  await assertRegularFile(manifestPath, 512_000);
  await assertRegularFile(patchPath, MAX_PATCH_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new RunnerError("invalid_artifact", "Artifact manifest is invalid", {
      cause: error,
    });
  }
  const manifest = parseManifest(value, config);
  const patch = await readFile(patchPath);
  if (
    patch.byteLength === 0 ||
    createHash("sha256").update(patch).digest("hex") !== manifest.patchSha256
  ) {
    throw new RunnerError(
      "invalid_artifact",
      "Artifact patch digest does not match its manifest",
    );
  }
  return manifest;
}

function parseManifest(
  value: unknown,
  config: RunnerConfig,
): RunnerArtifactManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.result) ||
    value.result.status !== "succeeded"
  ) {
    throw new RunnerError(
      "invalid_artifact",
      "Artifact manifest has an unsupported shape",
    );
  }
  const jobId = uuid(value.jobId);
  const repository = requiredString(
    value.repository,
    "artifact repository",
    201,
  );
  const baseSha = sha(value.baseSha, "artifact base SHA");
  const targetBranch = branch(value.branch);
  const createdAt = requiredString(value.createdAt, "artifact timestamp", 64);
  const patchSha256 = sha(value.patchSha256, "artifact patch digest");
  const result = parseArtifactResult(value.result);
  if (
    jobId !== config.jobId ||
    repository.toLowerCase() !== config.github.repository.toLowerCase() ||
    baseSha !== config.github.sha ||
    targetBranch !== `vyben/${config.jobId}` ||
    result.branch !== targetBranch ||
    result.baseSha !== baseSha ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new RunnerError(
      "artifact_mismatch",
      "Artifact identity does not match this finalize job",
    );
  }
  return {
    version: 1,
    createdAt,
    jobId,
    repository,
    baseSha,
    branch: targetBranch,
    patchSha256,
    result,
  };
}

function parseArtifactResult(value: unknown): RunnerArtifactManifest["result"] {
  if (!isRecord(value) || value.status !== "succeeded") {
    throw new RunnerError(
      "invalid_artifact",
      "Artifact result must be successful",
    );
  }
  if (!Array.isArray(value.changedFiles) || value.changedFiles.length > 200) {
    throw new RunnerError(
      "invalid_artifact",
      "Artifact changed-files result is invalid",
    );
  }
  const changedFiles = value.changedFiles.map((entry) => {
    if (!isRecord(entry))
      throw new RunnerError(
        "invalid_artifact",
        "Artifact changed file is invalid",
      );
    return {
      path: requiredString(entry.path, "changed file path", 1_024),
      additions: positiveInteger(
        entry.additions,
        "changed file additions",
        0,
        1_000_000,
      ),
      deletions: positiveInteger(
        entry.deletions,
        "changed file deletions",
        0,
        1_000_000,
      ),
    };
  });
  if (!Array.isArray(value.tests) || value.tests.length > 20) {
    throw new RunnerError(
      "invalid_artifact",
      "Artifact tests result is invalid",
    );
  }
  const tests = value.tests.map((entry) => {
    if (
      !isRecord(entry) ||
      (entry.status !== "passed" &&
        entry.status !== "failed" &&
        entry.status !== "skipped")
    ) {
      throw new RunnerError(
        "invalid_artifact",
        "Artifact test result is invalid",
      );
    }
    const status: RunnerArtifactManifest["result"]["tests"][number]["status"] =
      entry.status;
    return {
      name: requiredString(entry.name, "test name", 240),
      status,
      durationMs: positiveInteger(
        entry.durationMs,
        "test duration",
        0,
        900_000,
      ),
    };
  });
  const errorCode = nullableString(value.errorCode, "error code", 120);
  const errorMessage = nullableString(
    value.errorMessage,
    "error message",
    8_000,
  );
  return {
    status: "succeeded",
    summary: requiredString(value.summary, "result summary", 8_000),
    branch: branch(value.branch),
    baseSha: sha(value.baseSha, "result base SHA"),
    headSha:
      value.headSha === null ? null : sha(value.headSha, "result head SHA"),
    changedFiles,
    tests,
    errorCode,
    errorMessage,
  };
}

function nullableString(
  value: unknown,
  name: string,
  maxLength: number,
): string | null {
  return value === null ? null : requiredString(value, name, maxLength);
}

async function assertRegularFile(
  path: string,
  maxBytes: number,
): Promise<void> {
  const details = await lstat(path).catch(() => null);
  if (
    !details?.isFile() ||
    details.isSymbolicLink() ||
    details.size < 1 ||
    details.size > maxBytes
  ) {
    throw new RunnerError(
      "invalid_artifact",
      "Artifact contains a missing or invalid file",
    );
  }
}

async function assertOrigin(
  workspace: string,
  repository: string,
  sourceEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const output = (
    await runGit(workspace, ["remote", "get-url", "origin"], {
      env: safeGitEnvironment(sourceEnv),
    })
  ).stdout
    .toString("utf8")
    .trim();
  let url: URL;
  try {
    url = new URL(output);
  } catch {
    throw new RunnerError(
      "origin_mismatch",
      "Git origin must be an HTTPS GitHub URL",
    );
  }
  const expectedPath = `/${repository.toLowerCase()}`;
  const actualPath = url.pathname.toLowerCase().replace(/\.git$/, "");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    actualPath !== expectedPath
  ) {
    throw new RunnerError(
      "origin_mismatch",
      "Git origin does not match the authorized repository",
    );
  }
}
