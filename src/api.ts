import type {
  FinalizeRequest,
  RunnerEvent,
  RunnerResult,
} from "./contracts.js";
import { RunnerError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { readJson, timeoutSignal } from "./http.js";
import type { TokenProvider } from "./auth.js";

const MAX_REQUEST_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 10_000;

export interface RunnerApiOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export class RunnerApi {
  private sequence = 0;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly apiBaseUrl: URL,
    private readonly jobId: string,
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch,
    options: RunnerApiOptions = {},
  ) {
    this.sleep = options.sleep || delay;
    this.random = options.random || Math.random;
    this.now = options.now || Date.now;
  }

  getJob(): Promise<unknown> {
    return this.request(
      "GET",
      `/runner/jobs/${encodeURIComponent(this.jobId)}`,
    );
  }

  async postEvent(event: RunnerEvent): Promise<void> {
    const sequence = ++this.sequence;
    await this.request(
      "POST",
      `/runner/jobs/${encodeURIComponent(this.jobId)}/events`,
      event,
      `${this.jobId}:event:${sequence}`,
    );
  }

  async postResult(result: RunnerResult): Promise<void> {
    await this.request(
      "POST",
      `/runner/jobs/${encodeURIComponent(this.jobId)}/result`,
      result,
      `${this.jobId}:result`,
    );
  }

  async finalize(result: FinalizeRequest): Promise<void> {
    await this.request(
      "POST",
      `/runner/jobs/${encodeURIComponent(this.jobId)}/finalize`,
      result,
      `${this.jobId}:finalize:${result.headSha}`,
    );
  }

  async beginFinalize(result: FinalizeRequest): Promise<void> {
    await this.request(
      "POST",
      `/runner/jobs/${encodeURIComponent(this.jobId)}/finalize-intent`,
      result,
      `${this.jobId}:finalize-intent:${result.headSha}`,
    );
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const retrySafe = method === "GET" || idempotencyKey !== undefined;
    let authRefreshed = false;
    let forceRefresh = false;
    let transientAttempt = 0;
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
      const token = await this.tokens.getToken(forceRefresh);
      forceRefresh = false;
      let response: Response;
      try {
        response = await this.fetchImpl(
          new URL(`${this.apiBaseUrl.pathname}${path}`, this.apiBaseUrl.origin),
          {
            method,
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
              ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "error",
            signal: timeoutSignal(15_000),
          },
        );
      } catch (error) {
        if (retrySafe && attempt + 1 < MAX_REQUEST_ATTEMPTS) {
          await this.waitToRetry(undefined, transientAttempt++);
          continue;
        }
        throw new RunnerError(
          "api_request_failed",
          "Vyben API request failed before receiving a response",
          { cause: error },
        );
      }
      if (
        response.status === 401 &&
        !authRefreshed &&
        attempt + 1 < MAX_REQUEST_ATTEMPTS
      ) {
        await response.body?.cancel().catch(() => undefined);
        authRefreshed = true;
        forceRefresh = true;
        continue;
      }
      if (
        retrySafe &&
        isTransientStatus(response.status) &&
        attempt + 1 < MAX_REQUEST_ATTEMPTS
      ) {
        await response.body?.cancel().catch(() => undefined);
        await this.waitToRetry(
          response.headers.get("Retry-After"),
          transientAttempt++,
        );
        continue;
      }
      if (!response.ok) {
        throw new RunnerError(
          "api_request_failed",
          `Vyben API request failed with status ${response.status}`,
        );
      }
      if (response.status === 204) return null;
      try {
        return await readJson(response);
      } catch (error) {
        if (
          retrySafe &&
          !(error instanceof RunnerError) &&
          attempt + 1 < MAX_REQUEST_ATTEMPTS
        ) {
          await this.waitToRetry(undefined, transientAttempt++);
          continue;
        }
        if (error instanceof RunnerError) throw error;
        throw new RunnerError(
          "api_request_failed",
          "Vyben API response ended before it could be read",
          { cause: error },
        );
      }
    }
    throw new RunnerError(
      "api_request_failed",
      "Vyben API request exhausted its bounded retry budget",
    );
  }

  private waitToRetry(
    retryAfter: string | undefined | null,
    transientAttempt: number,
  ): Promise<void> {
    const serverDelay = parseRetryAfter(retryAfter, this.now());
    const exponential = Math.min(250 * 2 ** transientAttempt, 5_000);
    const jittered = Math.round(exponential * (0.75 + this.random() * 0.5));
    return this.sleep(Math.min(serverDelay ?? jittered, MAX_RETRY_DELAY_MS));
  }
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfter(
  value: string | undefined | null,
  now: number,
): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
