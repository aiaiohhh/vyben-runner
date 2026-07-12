import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { finalizeRunnerArtifact } from "../src/finalize.js";
import { runnerConfig, runnerJob } from "./helpers.js";

test("finalize mode records intent before pushing the exact job branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "vyben-finalize-test-"));
  const workspace = join(root, "workspace");
  const runnerTemp = join(root, "runner-temp");
  const artifact = join(runnerTemp, "artifact");
  const bin = join(root, "bin");
  const statePath = join(root, "git-state.json");
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const job = runnerJob({ baseSha });
  try {
    await Promise.all([
      mkdir(workspace),
      mkdir(artifact, { recursive: true }),
      mkdir(bin),
    ]);
    const patch = Buffer.from("synthetic-patch-for-isolated-finalize-test\n");
    const patchSha256 = createHash("sha256").update(patch).digest("hex");
    await writeFile(join(artifact, "changes.patch"), patch);
    await writeFile(
      join(artifact, "manifest.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-07-11T00:00:00.000Z",
        jobId: job.id,
        repository: job.repository,
        baseSha,
        branch: job.branch,
        patchSha256,
        result: {
          status: "succeeded",
          summary: "Agent completed.",
          branch: job.branch,
          baseSha,
          headSha: baseSha,
          changedFiles: [{ path: "generated.txt", additions: 0, deletions: 0 }],
          tests: [
            { name: "codex_cli execution", status: "passed", durationMs: 1 },
          ],
          errorCode: null,
          errorMessage: null,
        },
      }),
    );
    const fakeGit = join(bin, "git");
    await writeFile(
      fakeGit,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let state = {};
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
const has = (value) => args.includes(value);
if (has("--is-inside-work-tree")) process.stdout.write("true\\n");
else if (has("status")) process.stdout.write("");
else if (has("rev-parse")) process.stdout.write((state.committed ? ${JSON.stringify(headSha)} : ${JSON.stringify(baseSha)}) + "\\n");
else if (has("get-url")) process.stdout.write("https://github.com/aiaiohhh/example.git\\n");
else if (has("commit")) { state.committed = true; fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state)); }
else if (has("ls-remote")) process.stdout.write("");
else if (has("push")) {
  state.pushArgs = args;
  state.hadAuth = Boolean(process.env.GIT_CONFIG_VALUE_0);
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
`,
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(fakeGit, 0o700);

    const now = Date.parse("2026-07-11T00:01:00.000Z");
    let intentBody: Record<string, unknown> | undefined;
    let finalizeBody: Record<string, unknown> | undefined;
    const result = await finalizeRunnerArtifact(
      runnerConfig({
        workspace,
        runnerTemp,
        github: { ...runnerConfig().github, sha: baseSha },
      }),
      {
        artifactPath: artifact,
        githubToken: "fresh-finalize-job-token",
        now: () => now,
        env: {
          NODE_ENV: "test",
          PATH: `${bin}:${process.env.PATH}`,
          HOME: process.env.HOME,
        },
        fetchImpl: async (input, init) => {
          const url = new URL(input.toString());
          if (url.hostname.endsWith("actions.githubusercontent.com")) {
            return Response.json({ value: "header.payload.signature" });
          }
          if (url.pathname.endsWith("/runner/exchange")) {
            return Response.json({
              accessToken: "finalize-job-scoped-token",
              expiresAt: new Date(now + 900_000).toISOString(),
            });
          }
          if (url.pathname.endsWith("/finalize-intent")) {
            intentBody = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            const pushState = await readFile(statePath, "utf8").then(
              (value) => JSON.parse(value) as { pushArgs?: string[] },
              () => ({}) as { pushArgs?: string[] },
            );
            assert.equal(pushState.pushArgs, undefined);
            return new Response(null, { status: 204 });
          }
          if (url.pathname.endsWith("/finalize")) {
            finalizeBody = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return new Response(null, { status: 204 });
          }
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    );

    assert.equal(result.headSha, headSha);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      pushArgs: string[];
      hadAuth: boolean;
    };
    assert.equal(state.hadAuth, true);
    assert.ok(state.pushArgs.includes(`HEAD:refs/heads/${job.branch}`));
    assert.equal(
      state.pushArgs.some((arg) => arg.includes("force")),
      false,
    );
    assert.equal(
      state.pushArgs.some((arg) => /heads\/(main|master)$/.test(arg)),
      false,
    );
    assert.deepEqual(finalizeBody, {
      branch: job.branch,
      baseSha,
      headSha,
      patchSha256,
    });
    assert.deepEqual(intentBody, finalizeBody);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
