import { spawn } from "node:child_process";
import { RunnerError } from "./errors.js";
export function safeGitEnvironment(source, extra = {}) {
    const env = {
        NODE_ENV: source.NODE_ENV || "production",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
    };
    for (const key of [
        "PATH",
        "HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "WINDIR",
        "PATHEXT",
        "COMSPEC",
    ]) {
        if (source[key] !== undefined)
            env[key] = source[key];
    }
    return { ...env, ...extra };
}
export function runGit(cwd, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const maxOutputBytes = options.maxOutputBytes ?? 131_072;
    const allowedExitCodes = options.allowedExitCodes ?? [0];
    return new Promise((resolve, reject) => {
        const child = spawn("git", [
            "--no-optional-locks",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "submodule.recurse=false",
            ...args,
        ], {
            cwd,
            env: options.env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const stdout = [];
        const stderr = [];
        let bytes = 0;
        let exceeded = false;
        let spawnError;
        const capture = (destination, chunk) => {
            if (exceeded)
                return;
            bytes += chunk.byteLength;
            if (bytes > maxOutputBytes) {
                exceeded = true;
                child.kill("SIGKILL");
                return;
            }
            destination.push(chunk);
        };
        child.stdout.on("data", (chunk) => capture(stdout, chunk));
        child.stderr.on("data", (chunk) => capture(stderr, chunk));
        child.on("error", (error) => {
            spawnError = error;
        });
        const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        timeout.unref();
        child.on("close", (exitCode) => {
            clearTimeout(timeout);
            if (spawnError) {
                reject(new RunnerError("git_failed", "Could not start Git", {
                    cause: spawnError,
                }));
            }
            else if (exceeded) {
                reject(new RunnerError("git_output_limit", "Git output exceeded the allowed size"));
            }
            else if (exitCode === null || !allowedExitCodes.includes(exitCode)) {
                reject(new RunnerError("git_failed", "Git command failed"));
            }
            else {
                resolve({
                    stdout: Buffer.concat(stdout),
                    stderr: Buffer.concat(stderr),
                    exitCode,
                });
            }
        });
    });
}
