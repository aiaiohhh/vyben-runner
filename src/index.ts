#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { actionInput, loadConfig } from "./config.js";
import { toRunnerError } from "./errors.js";
import { finalizeRunnerArtifact } from "./finalize.js";
import { installCodexCli } from "./install.js";
import { boundedMessage } from "./redaction.js";
import { executeRunner } from "./runner.js";
import { requiredString } from "./validation.js";

const controller = new AbortController();
const cancel = (): void => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const config = loadConfig();
  const mode = actionInput(process.env, "mode") || "run";
  if (mode === "finalize") {
    const finalized = await finalizeRunnerArtifact(config, {
      artifactPath: requiredString(
        actionInput(process.env, "artifact-path"),
        "artifact path",
        4_096,
      ),
      githubToken: requiredString(
        actionInput(process.env, "github-token"),
        "GitHub token",
        16_384,
      ),
    });
    await setActionOutputs({
      status: "finalized",
      "head-sha": finalized.headSha,
    });
    console.log(`Vyben runner finalized ${finalized.branch}.`);
  } else if (mode === "run") {
    const codex = await installCodexCli(config.runnerTemp);
    let execution: Awaited<ReturnType<typeof executeRunner>>;
    try {
      execution = await executeRunner(config, {
        abortSignal: controller.signal,
        env: {
          ...process.env,
          PATH: `${codex.binDir}${delimiter}${process.env.PATH || ""}`,
        },
      });
    } finally {
      await codex.cleanup();
    }
    const result = execution.result;
    await setActionOutputs({
      status: result.status,
      ...(execution.artifactPath
        ? { "artifact-path": execution.artifactPath }
        : {}),
    });
    if (result.status === "succeeded") {
      console.log(`Vyben runner completed: ${result.summary}`);
    } else {
      console.error(
        `Vyben runner ${result.status}: ${result.errorCode || "unknown_error"}`,
      );
      process.exitCode = 1;
    }
  } else {
    throw new Error("Action mode must be 'run' or 'finalize'");
  }
} catch (error) {
  const failure = toRunnerError(error);
  console.error(
    `Vyben runner failed (${failure.code}): ${boundedMessage(failure.message)}`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}

async function setActionOutputs(
  outputs: Record<string, string>,
): Promise<void> {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const lines = Object.entries(outputs).map(([name, value]) => {
    if (!/^[a-z-]+$/.test(name) || /[\r\n]/.test(value))
      throw new Error("Invalid action output");
    return `${name}=${value}`;
  });
  await appendFile(outputFile, `${lines.join("\n")}\n`, { encoding: "utf8" });
}
