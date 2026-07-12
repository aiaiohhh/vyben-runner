import { RunnerError } from "./errors.js";
import { readJson, timeoutSignal } from "./http.js";
import { isRecord } from "./validation.js";
export class GitHubActionsOidcProvider {
    requestUrl;
    requestToken;
    audience;
    fetchImpl;
    constructor(requestUrl, requestToken, audience, fetchImpl = fetch) {
        this.requestUrl = requestUrl;
        this.requestToken = requestToken;
        this.audience = audience;
        this.fetchImpl = fetchImpl;
    }
    async getToken() {
        const url = new URL(this.requestUrl);
        url.searchParams.set("audience", this.audience);
        const response = await this.fetchImpl(url, {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${this.requestToken}`,
            },
            redirect: "error",
            signal: timeoutSignal(10_000),
        });
        if (!response.ok) {
            throw new RunnerError("oidc_request_failed", `GitHub OIDC request failed with status ${response.status}`);
        }
        const body = await readJson(response, 32_768);
        const token = isRecord(body) ? body.value : undefined;
        if (typeof token !== "string" ||
            token.length > 16_384 ||
            !/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(token)) {
            throw new RunnerError("invalid_oidc_response", "GitHub OIDC response did not contain a valid JWT");
        }
        return token;
    }
}
