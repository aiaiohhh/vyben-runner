import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerError } from "./errors.js";

const CODEX_VERSION = "0.144.1";
const MAX_INSTALL_OUTPUT_BYTES = 256 * 1_024;

export interface CodexCliInstall {
  binDir: string;
  cleanup(): Promise<void>;
}

export function bundledCodexProjectPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../codex-cli");
}

export async function installCodexCli(
  runnerTemp: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  projectPath: string = bundledCodexProjectPath(),
): Promise<CodexCliInstall> {
  const canonicalTemp = await realpath(runnerTemp).catch(() => null);
  const tempDetails = canonicalTemp
    ? await stat(canonicalTemp).catch(() => null)
    : null;
  if (!canonicalTemp || !tempDetails?.isDirectory()) {
    throw new RunnerError(
      "invalid_runner_temp",
      "RUNNER_TEMP is not a directory",
    );
  }
  await validateLockedProject(projectPath);
  const installRoot = await mkdtemp(join(canonicalTemp, "vyben-codex-cli-"));
  const home = join(installRoot, "home");
  const temp = join(installRoot, "tmp");
  const npmCache = join(installRoot, "npm-cache");
  const npmrc = join(installRoot, "npmrc");
  try {
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      mkdir(temp, { mode: 0o700 }),
      mkdir(npmCache, { mode: 0o700 }),
      copyFile(
        join(projectPath, "package.json"),
        join(installRoot, "package.json"),
        constants.COPYFILE_EXCL,
      ),
      copyFile(
        join(projectPath, "package-lock.json"),
        join(installRoot, "package-lock.json"),
        constants.COPYFILE_EXCL,
      ),
      writeFile(npmrc, "", { mode: 0o600, flag: "wx" }),
    ]);
    const env = installEnvironment(sourceEnv, home, temp, npmCache, npmrc);
    await runBounded(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"],
      installRoot,
      env,
      120_000,
    );
    const binDir = join(installRoot, "node_modules", ".bin");
    const version = await runBounded(
      join(binDir, "codex"),
      ["--version"],
      installRoot,
      { ...env, PATH: `${binDir}${delimiter}${env.PATH || ""}` },
      10_000,
    );
    if (version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) {
      throw new RunnerError(
        "codex_install_failed",
        "Installed Codex CLI did not match the reviewed release",
      );
    }
    return {
      binDir,
      cleanup: () =>
        rm(installRoot, { recursive: true, force: true, maxRetries: 3 }),
    };
  } catch (error) {
    await rm(installRoot, { recursive: true, force: true, maxRetries: 3 });
    if (error instanceof RunnerError) throw error;
    throw new RunnerError(
      "codex_install_failed",
      "Could not install the integrity-locked Codex CLI",
      { cause: error },
    );
  }
}

async function validateLockedProject(projectPath: string): Promise<void> {
  try {
    const packageJson = JSON.parse(
      await readFile(join(projectPath, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, unknown> };
    const lock = JSON.parse(
      await readFile(join(projectPath, "package-lock.json"), "utf8"),
    ) as {
      lockfileVersion?: unknown;
      packages?: Record<
        string,
        { version?: unknown; resolved?: unknown; integrity?: unknown }
      >;
    };
    const entries = Object.entries(lock.packages || {}).filter(([path]) =>
      path.startsWith("node_modules/"),
    );
    const dependencies = Object.entries(packageJson.dependencies || {});
    const codex = lock.packages?.["node_modules/@openai/codex"];
    if (
      dependencies.length !== 1 ||
      dependencies[0]?.[0] !== "@openai/codex" ||
      dependencies[0]?.[1] !== CODEX_VERSION ||
      lock.lockfileVersion !== 3 ||
      codex?.version !== CODEX_VERSION ||
      entries.length === 0 ||
      entries.some(
        ([, entry]) =>
          typeof entry.resolved !== "string" ||
          !entry.resolved.startsWith("https://registry.npmjs.org/") ||
          typeof entry.integrity !== "string" ||
          !entry.integrity.startsWith("sha512-"),
      )
    ) {
      throw new Error("invalid Codex lock project");
    }
  } catch (error) {
    throw new RunnerError(
      "codex_install_failed",
      "Bundled Codex CLI lock files are missing or invalid",
      { cause: error },
    );
  }
}

function installEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
  temp: string,
  npmCache: string,
  npmrc: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    CI: "true",
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    npm_config_userconfig: npmrc,
    npm_config_cache: npmCache,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_provenance: "false",
    npm_config_save: "false",
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function runBounded(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let spawnError: Error | undefined;
    const killTree = (): void => {
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // The install process group may already have exited.
      }
    };
    const capture = (destination: Buffer[], chunk: Buffer): void => {
      if (failed) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_INSTALL_OUTPUT_BYTES) {
        failed = true;
        killTree();
      } else {
        destination.push(chunk);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture([], chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    const timeout = setTimeout(() => {
      failed = true;
      killTree();
    }, timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (spawnError || failed || exitCode !== 0) {
        reject(
          new RunnerError(
            "codex_install_failed",
            "Integrity-locked Codex CLI installation failed",
            { cause: spawnError },
          ),
        );
      } else {
        resolvePromise({ stdout: Buffer.concat(stdout).toString("utf8") });
      }
    });
  });
}
