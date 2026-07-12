import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { RunnerError } from "../src/errors.js";
import { JOB_ID, validEnv } from "./helpers.js";

test("loads action inputs and GitHub OIDC context", () => {
  const env = validEnv({
    VYBEN_JOB_ID: undefined,
    "INPUT_JOB-ID": JOB_ID,
  });
  const config = loadConfig(env);
  assert.equal(config.jobId, JOB_ID);
  assert.equal(config.apiBaseUrl.href, "https://api.vyben.app/api");
  assert.equal(
    config.oidcAudience,
    `https://api.vyben.app/api/runner/exchange#${JOB_ID}`,
  );
  assert.equal(config.oidcRequestUrl.searchParams.get("api-version"), "2.0");
});

test("ignores attacker-controlled API and audience values", () => {
  const config = loadConfig(
    validEnv({
      VYBEN_API_URL: "https://attacker.example/api",
      VYBEN_OIDC_AUDIENCE: "https://attacker.example/audience",
      "INPUT_API-URL": "https://attacker.example/api",
      "INPUT_OIDC-AUDIENCE": "https://attacker.example/audience",
    }),
  );
  assert.equal(config.apiBaseUrl.hostname, "api.vyben.app");
  assert.match(config.oidcAudience, /^https:\/\/api\.vyben\.app\/api\//);
});

test("rejects a non-GitHub OIDC request endpoint", () => {
  assert.throws(
    () =>
      loadConfig(
        validEnv({
          ACTIONS_ID_TOKEN_REQUEST_URL:
            "https://attacker.example/token?api-version=2.0",
        }),
      ),
    (error: unknown) =>
      error instanceof RunnerError && error.code === "invalid_environment",
  );
});

test("rejects workflow identity from another repository", () => {
  assert.throws(
    () =>
      loadConfig(
        validEnv({
          GITHUB_WORKFLOW_REF:
            "someone/else/.github/workflows/vyben.yml@refs/heads/main",
        }),
      ),
    (error: unknown) =>
      error instanceof RunnerError && error.code === "invalid_environment",
  );
});

test("enforces the 15-minute local execution ceiling", () => {
  assert.throws(
    () => loadConfig(validEnv({ VYBEN_MAX_AGENT_SECONDS: "901" })),
    (error: unknown) =>
      error instanceof RunnerError && error.code === "invalid_input",
  );
});

test("requires a new Vyben job instead of reusing idempotency keys on rerun", () => {
  assert.throws(
    () => loadConfig(validEnv({ GITHUB_RUN_ATTEMPT: "2" })),
    (error: unknown) =>
      error instanceof RunnerError && error.code === "invalid_environment",
  );
});
