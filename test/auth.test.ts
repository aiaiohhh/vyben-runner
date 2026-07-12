import assert from "node:assert/strict";
import test from "node:test";
import { RunnerApi } from "../src/api.js";
import { RefreshingTokenProvider, type TokenProvider } from "../src/auth.js";
import { RunnerError } from "../src/errors.js";
import { GitHubActionsOidcProvider, type OidcProvider } from "../src/oidc.js";
import { runnerConfig } from "./helpers.js";

test("requests a GitHub OIDC token with the configured audience", async () => {
  let request: { url: URL; init?: RequestInit } | undefined;
  const provider = new GitHubActionsOidcProvider(
    new URL(
      "https://pipelines.actions.githubusercontent.com/token?api-version=2.0",
    ),
    "request-secret",
    "https://api.vyben.example/runner",
    async (input, init) => {
      request = { url: new URL(input.toString()), init };
      return Response.json({ value: "header.payload.signature" });
    },
  );

  assert.equal(await provider.getToken(), "header.payload.signature");
  assert.equal(request?.url.searchParams.get("api-version"), "2.0");
  assert.equal(
    request?.url.searchParams.get("audience"),
    "https://api.vyben.example/runner",
  );
  assert.equal(
    (request?.init?.headers as Record<string, string>).Authorization,
    "Bearer request-secret",
  );
});

test("refreshes the runner token with a fresh OIDC assertion before expiry", async () => {
  const config = runnerConfig();
  let now = Date.parse("2026-07-11T00:00:00.000Z");
  let oidcCalls = 0;
  let exchanges = 0;
  const secrets: string[] = [];
  const oidc: OidcProvider = {
    async getToken() {
      oidcCalls += 1;
      return `header.payload-${oidcCalls}.signature`;
    },
  };
  const provider = new RefreshingTokenProvider(
    config.apiBaseUrl,
    config.jobId,
    config.github,
    oidc,
    (secret) => secrets.push(secret),
    async (_input, init) => {
      exchanges += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.runner, "github_actions");
      assert.equal(body.jobId, config.jobId);
      return Response.json({
        accessToken: `job-scoped-access-token-${exchanges}`,
        expiresAt: new Date(now + 120_000).toISOString(),
      });
    },
    () => now,
  );

  assert.equal(await provider.getToken(), "job-scoped-access-token-1");
  now += 30_000;
  assert.equal(await provider.getToken(), "job-scoped-access-token-1");
  now += 40_000;
  assert.equal(await provider.getToken(), "job-scoped-access-token-2");
  assert.equal(oidcCalls, 2);
  assert.equal(exchanges, 2);
  assert.ok(secrets.includes("header.payload-2.signature"));
  assert.ok(secrets.includes("job-scoped-access-token-2"));
});

test("retries an API request once with a force-refreshed token after 401", async () => {
  const forceRefreshes: boolean[] = [];
  const tokens: TokenProvider = {
    async getToken(force = false) {
      forceRefreshes.push(force);
      return force ? "fresh-token" : "stale-token";
    },
  };
  let calls = 0;
  const api = new RunnerApi(
    new URL("https://api.vyben.example/api"),
    runnerConfig().jobId,
    tokens,
    async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 401 })
        : Response.json({ id: "job" });
    },
  );
  assert.deepEqual(await api.getJob(), { id: "job" });
  assert.deepEqual(forceRefreshes, [false, true]);
});

test("retries transient GET failures with bounded jitter and Retry-After", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const api = new RunnerApi(
    new URL("https://api.vyben.example/api"),
    runnerConfig().jobId,
    staticTokens(),
    async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("temporary network failure");
      if (calls === 2)
        return new Response("busy", {
          status: 503,
          headers: { "Retry-After": "2" },
        });
      return Response.json({ id: "job" });
    },
    {
      random: () => 0.5,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );

  assert.deepEqual(await api.getJob(), { id: "job" });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 2_000]);
});

test("retries an interrupted response body for a retry-safe request", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const api = new RunnerApi(
    new URL("https://api.vyben.example/api"),
    runnerConfig().jobId,
    staticTokens(),
    async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("connection reset"));
            },
          }),
        );
      }
      return Response.json({ id: "job" });
    },
    {
      random: () => 0.5,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );

  assert.deepEqual(await api.getJob(), { id: "job" });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [250]);
});

test("retries finalize only with the same idempotency key", async () => {
  const keys: string[] = [];
  let calls = 0;
  const api = new RunnerApi(
    new URL("https://api.vyben.example/api"),
    runnerConfig().jobId,
    staticTokens(),
    async (_input, init) => {
      calls += 1;
      const key = new Headers(init?.headers).get("Idempotency-Key");
      assert.ok(key);
      keys.push(key);
      return calls === 1
        ? new Response(null, { status: 500 })
        : new Response(null, { status: 204 });
    },
    { sleep: async () => undefined },
  );
  const result = {
    branch: `vyben/${runnerConfig().jobId}`,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    patchSha256: "c".repeat(40),
  };

  await api.finalize(result);
  assert.equal(calls, 2);
  assert.deepEqual(keys, [
    `${runnerConfig().jobId}:finalize:${result.headSha}`,
    `${runnerConfig().jobId}:finalize:${result.headSha}`,
  ]);
});

test("stops transient retries after the fixed request budget", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const api = new RunnerApi(
    new URL("https://api.vyben.example/api"),
    runnerConfig().jobId,
    staticTokens(),
    async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
    {
      random: () => 0.5,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );

  await assert.rejects(
    api.getJob(),
    (error: unknown) =>
      error instanceof RunnerError && error.code === "api_request_failed",
  );
  assert.equal(calls, 5);
  assert.deepEqual(sleeps, [250, 500, 1_000, 2_000]);
});

function staticTokens(): TokenProvider {
  return { getToken: async () => "job-scoped-token" };
}
