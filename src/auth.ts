import type {
  ExchangeRequest,
  ExchangeResponse,
  GitHubContext,
} from "./contracts.js";
import { RUNNER_KIND } from "./contracts.js";
import { RunnerError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { readJson, timeoutSignal } from "./http.js";
import type { OidcProvider } from "./oidc.js";
import { isRecord } from "./validation.js";

const REFRESH_WINDOW_MS = 60_000;

export interface TokenProvider {
  getToken(forceRefresh?: boolean): Promise<string>;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class RefreshingTokenProvider implements TokenProvider {
  private cached?: CachedToken;
  private refresh?: Promise<CachedToken>;

  constructor(
    private readonly apiBaseUrl: URL,
    private readonly jobId: string,
    private readonly github: GitHubContext,
    private readonly oidc: OidcProvider,
    private readonly onSecret: (secret: string) => void,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(forceRefresh = false): Promise<string> {
    if (
      !forceRefresh &&
      this.cached &&
      this.cached.expiresAt - this.now() > REFRESH_WINDOW_MS
    ) {
      return this.cached.value;
    }
    if (!this.refresh) {
      this.refresh = this.exchange().finally(() => {
        this.refresh = undefined;
      });
    }
    this.cached = await this.refresh;
    return this.cached.value;
  }

  private async exchange(): Promise<CachedToken> {
    const oidcToken = await this.oidc.getToken();
    this.onSecret(oidcToken);
    const payload: ExchangeRequest = {
      oidcToken,
      jobId: this.jobId,
      runner: RUNNER_KIND,
      context: this.github,
    };
    const response = await this.fetchImpl(
      new URL(
        `${this.apiBaseUrl.pathname}/runner/exchange`,
        this.apiBaseUrl.origin,
      ),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: timeoutSignal(15_000),
      },
    );
    if (!response.ok) {
      throw new RunnerError(
        "token_exchange_failed",
        `Vyben token exchange failed with status ${response.status}`,
      );
    }

    const parsed = parseExchangeResponse(await readJson(response));
    const expiresAt = Date.parse(parsed.expiresAt);
    const remaining = expiresAt - this.now();
    if (
      !Number.isFinite(expiresAt) ||
      remaining < REFRESH_WINDOW_MS ||
      remaining > 3_600_000
    ) {
      throw new RunnerError(
        "invalid_exchange_response",
        "Vyben returned an invalid runner-token expiry",
      );
    }
    this.onSecret(parsed.accessToken);
    return { value: parsed.accessToken, expiresAt };
  }
}

function parseExchangeResponse(value: unknown): ExchangeResponse {
  if (!isRecord(value))
    throw new RunnerError(
      "invalid_exchange_response",
      "Vyben returned an invalid token response",
    );
  const accessToken = value.accessToken;
  const expiresAt = value.expiresAt;
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 16 ||
    accessToken.length > 16_384 ||
    typeof expiresAt !== "string" ||
    expiresAt.length > 64
  ) {
    throw new RunnerError(
      "invalid_exchange_response",
      "Vyben returned an invalid token response",
    );
  }
  return { accessToken, expiresAt };
}
