import { createHash } from "node:crypto";
import { mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerJob, RunnerResult } from "./contracts.js";
import { RunnerError } from "./errors.js";
import { runGit, safeGitEnvironment } from "./git.js";
import type { WorkspaceState } from "./workspace.js";

export const MAX_PATCH_BYTES = 5 * 1_024 * 1_024;

export interface RunnerArtifactManifest {
  version: 1;
  createdAt: string;
  jobId: string;
  repository: string;
  baseSha: string;
  branch: string;
  patchSha256: string;
  result: RunnerResult;
}

export interface RunnerArtifact {
  path: string;
  manifest: RunnerArtifactManifest;
}

export async function createRunnerArtifact(
  job: RunnerJob,
  result: RunnerResult,
  workspace: WorkspaceState,
  runnerTemp: string,
  sourceEnv: NodeJS.ProcessEnv,
  createdAt: string,
): Promise<RunnerArtifact> {
  const tempDetails = await stat(runnerTemp).catch(() => null);
  if (!tempDetails?.isDirectory())
    throw new RunnerError(
      "invalid_runner_temp",
      "RUNNER_TEMP is not a directory",
    );
  const canonicalTemp = await realpath(runnerTemp);
  const patch = await buildPatch(workspace, sourceEnv);
  if (patch.byteLength === 0)
    throw new RunnerError(
      "no_changes",
      "Agent completed without repository changes",
    );
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  const manifest: RunnerArtifactManifest = {
    version: 1,
    createdAt,
    jobId: job.id,
    repository: job.repository,
    baseSha: job.baseSha,
    branch: job.branch,
    patchSha256,
    result,
  };
  const artifactPath = await mkdtemp(join(canonicalTemp, `vyben-${job.id}-`));
  await Promise.all([
    writeFile(join(artifactPath, "changes.patch"), patch, {
      mode: 0o600,
      flag: "wx",
    }),
    writeFile(
      join(artifactPath, "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    ),
    writeFile(
      join(artifactPath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    ),
  ]);
  return { path: artifactPath, manifest };
}

async function buildPatch(
  workspace: WorkspaceState,
  sourceEnv: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const env = safeGitEnvironment(sourceEnv);
  const parts: Buffer[] = [];
  let bytes = 0;
  const append = (part: Buffer): void => {
    bytes += part.byteLength;
    if (bytes > MAX_PATCH_BYTES)
      throw new RunnerError(
        "patch_too_large",
        "Repository patch exceeds 5 MiB",
      );
    parts.push(part);
  };

  append(
    (
      await runGit(
        workspace.path,
        [
          "diff",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=all",
          "HEAD",
          "--",
        ],
        {
          env,
          maxOutputBytes: MAX_PATCH_BYTES + 1,
          timeoutMs: 30_000,
        },
      )
    ).stdout,
  );
  for (const path of workspace.untrackedFiles) {
    append(
      (
        await runGit(
          workspace.path,
          [
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            "--no-index",
            "--",
            "/dev/null",
            path,
          ],
          {
            env,
            maxOutputBytes: MAX_PATCH_BYTES - bytes + 1,
            timeoutMs: 30_000,
            allowedExitCodes: [0, 1],
          },
        )
      ).stdout,
    );
  }
  return Buffer.concat(parts);
}
