import { RunnerError } from "./errors.js";
import { readJson, timeoutSignal } from "./http.js";
const MAX_REQUEST_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 10_000;
export class RunnerApi {
    apiBaseUrl;
    jobId;
    tokens;
    fetchImpl;
    sequence = 0;
    sleep;
    random;
    now;
    constructor(apiBaseUrl, jobId, tokens, fetchImpl = fetch, options = {}) {
        this.apiBaseUrl = apiBaseUrl;
        this.jobId = jobId;
        this.tokens = tokens;
        this.fetchImpl = fetchImpl;
        this.sleep = options.sleep || delay;
        this.random = options.random || Math.random;
        this.now = options.now || Date.now;
    }
    getJob() {
        return this.request("GET", `/runner/jobs/${encodeURIComponent(this.jobId)}`);
    }
    async postEvent(event) {
        const sequence = ++this.sequence;
        await this.request("POST", `/runner/jobs/${encodeURIComponent(this.jobId)}/events`, event, `${this.jobId}:event:${sequence}`);
    }
    async postResult(result) {
        await this.request("POST", `/runner/jobs/${encodeURIComponent(this.jobId)}/result`, result, `${this.jobId}:result`);
    }
    async finalize(result) {
        await this.request("POST", `/runner/jobs/${encodeURIComponent(this.jobId)}/finalize`, result, `${this.jobId}:finalize:${result.headSha}`);
    }
    async beginFinalize(result) {
        await this.request("POST", `/runner/jobs/${encodeURIComponent(this.jobId)}/finalize-intent`, result, `${this.jobId}:finalize-intent:${result.headSha}`);
    }
    async request(method, path, body, idempotencyKey) {
        const retrySafe = method === "GET" || idempotencyKey !== undefined;
        let authRefreshed = false;
        let forceRefresh = false;
        let transientAttempt = 0;
        for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
            const token = await this.tokens.getToken(forceRefresh);
            forceRefresh = false;
            let response;
            try {
                response = await this.fetchImpl(new URL(`${this.apiBaseUrl.pathname}${path}`, this.apiBaseUrl.origin), {
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
                });
            }
            catch (error) {
                if (retrySafe && attempt + 1 < MAX_REQUEST_ATTEMPTS) {
                    await this.waitToRetry(undefined, transientAttempt++);
                    continue;
                }
                throw new RunnerError("api_request_failed", "Vyben API request failed before receiving a response", { cause: error });
            }
            if (response.status === 401 &&
                !authRefreshed &&
                attempt + 1 < MAX_REQUEST_ATTEMPTS) {
                await response.body?.cancel().catch(() => undefined);
                authRefreshed = true;
                forceRefresh = true;
                continue;
            }
            if (retrySafe &&
                isTransientStatus(response.status) &&
                attempt + 1 < MAX_REQUEST_ATTEMPTS) {
                await response.body?.cancel().catch(() => undefined);
                await this.waitToRetry(response.headers.get("Retry-After"), transientAttempt++);
                continue;
            }
            if (!response.ok) {
                throw new RunnerError("api_request_failed", `Vyben API request failed with status ${response.status}`);
            }
            if (response.status === 204)
                return null;
            try {
                return await readJson(response);
            }
            catch (error) {
                if (retrySafe &&
                    !(error instanceof RunnerError) &&
                    attempt + 1 < MAX_REQUEST_ATTEMPTS) {
                    await this.waitToRetry(undefined, transientAttempt++);
                    continue;
                }
                if (error instanceof RunnerError)
                    throw error;
                throw new RunnerError("api_request_failed", "Vyben API response ended before it could be read", { cause: error });
            }
        }
        throw new RunnerError("api_request_failed", "Vyben API request exhausted its bounded retry budget");
    }
    waitToRetry(retryAfter, transientAttempt) {
        const serverDelay = parseRetryAfter(retryAfter, this.now());
        const exponential = Math.min(250 * 2 ** transientAttempt, 5_000);
        const jittered = Math.round(exponential * (0.75 + this.random() * 0.5));
        return this.sleep(Math.min(serverDelay ?? jittered, MAX_RETRY_DELAY_MS));
    }
}
function isTransientStatus(status) {
    return status === 429 || (status >= 500 && status <= 599);
}
function parseRetryAfter(value, now) {
    if (!value)
        return null;
    if (/^\d+$/.test(value))
        return Number(value) * 1_000;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
