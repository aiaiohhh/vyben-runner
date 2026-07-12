import { realpath, stat } from "node:fs/promises";
import { RunnerError } from "./errors.js";
import { runGit, safeGitEnvironment } from "./git.js";
import { sha } from "./validation.js";

const MAX_CHANGED_FILES = 200;
const MAX_INDEX_BYTES = 16 * 1_024 * 1_024;
const MAX_STATUS_BYTES = 512 * 1_024;

export interface WorkspaceState {
  path: string;
  headSha: string;
  changedFiles: { path: string; additions: number; deletions: number }[];
  untrackedFiles: string[];
}

export async function inspectWorkspace(
  workspace: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceState> {
  const details = await stat(workspace).catch(() => null);
  if (!details?.isDirectory())
    throw new RunnerError(
      "invalid_workspace",
      "GitHub workspace is not a directory",
    );
  const canonicalPath = await realpath(workspace);
  const env = safeGitEnvironment(sourceEnv);

  const inside = (
    await runGit(canonicalPath, ["rev-parse", "--is-inside-work-tree"], { env })
  ).stdout.toString("utf8");
  if (inside.trim() !== "true")
    throw new RunnerError(
      "invalid_workspace",
      "GitHub workspace is not a Git worktree",
    );
  const headSha = sha(
    (
      await runGit(canonicalPath, ["rev-parse", "--verify", "HEAD"], { env })
    ).stdout
      .toString("utf8")
      .trim(),
    "workspace HEAD",
  );
  const indexEntries = (
    await runGit(canonicalPath, ["ls-files", "--stage", "-z"], {
      env,
      maxOutputBytes: MAX_INDEX_BYTES,
      timeoutMs: 30_000,
    })
  ).stdout.toString("utf8");
  if (indexEntries.split("\0").some((entry) => entry.startsWith("160000 "))) {
    throw new RunnerError(
      "unsupported_submodule",
      "Repositories with Git submodules are not supported by this runner release",
    );
  }
  const porcelain = (
    await runGit(
      canonicalPath,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
      ],
      { env, maxOutputBytes: MAX_STATUS_BYTES, timeoutMs: 30_000 },
    )
  ).stdout.toString("utf8");
  const status = parseStatus(porcelain);
  if (status.overflow) {
    throw new RunnerError(
      "too_many_changed_files",
      `Agent changed more than ${MAX_CHANGED_FILES} files`,
    );
  }
  return {
    path: canonicalPath,
    headSha,
    changedFiles: status.paths.map((path) => ({
      path,
      additions: 0,
      deletions: 0,
    })),
    untrackedFiles: status.untracked,
  };
}

export function parseChangedFiles(porcelain: string): string[] {
  return parseStatus(porcelain).paths;
}

function parseStatus(porcelain: string): {
  paths: string[];
  untracked: string[];
  overflow: boolean;
} {
  const entries = porcelain.split("\0");
  const paths = new Set<string>();
  const untracked = new Set<string>();
  let overflow = false;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4) throw invalidChangedPath();
    const path = entry.slice(3);
    overflow = addPath(paths, path) || overflow;
    if (entry.startsWith("??")) addPath(untracked, path);
    if (
      entry[0] === "R" ||
      entry[1] === "R" ||
      entry[0] === "C" ||
      entry[1] === "C"
    ) {
      index += 1;
      overflow = addPath(paths, entries[index] || "") || overflow;
    }
  }
  return {
    paths: [...paths].sort(),
    untracked: [...untracked].sort(),
    overflow,
  };
}

function addPath(paths: Set<string>, path: string): boolean {
  const safe =
    path.length > 0 &&
    path.length <= 1_024 &&
    !path.startsWith("/") &&
    !path.split("/").includes("..");
  if (!safe) throw invalidChangedPath();
  if (!paths.has(path) && paths.size >= MAX_CHANGED_FILES) return true;
  if (paths.size < MAX_CHANGED_FILES) {
    paths.add(path);
  }
  return false;
}

function invalidChangedPath(): RunnerError {
  return new RunnerError(
    "invalid_changed_path",
    "Git reported an unsafe or unsupported changed path",
  );
}
