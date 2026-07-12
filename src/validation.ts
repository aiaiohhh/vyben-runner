import { RunnerError } from "./errors.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function requiredString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new RunnerError("invalid_input", `${name} is missing or invalid`);
  }
  return value;
}

export function uuid(value: unknown, name = "job ID"): string {
  const parsed = requiredString(value, name, 64);
  if (!UUID_RE.test(parsed))
    throw new RunnerError("invalid_input", `${name} must be a UUID`);
  return parsed.toLowerCase();
}

export function repository(value: unknown): string {
  const parsed = requiredString(value, "repository", 201);
  if (!REPOSITORY_RE.test(parsed) || parsed.includes("..")) {
    throw new RunnerError(
      "invalid_input",
      "repository must use the owner/name form",
    );
  }
  return parsed;
}

export function sha(value: unknown, name = "SHA"): string {
  const parsed = requiredString(value, name, 64);
  if (!SHA_RE.test(parsed))
    throw new RunnerError("invalid_input", `${name} is invalid`);
  return parsed.toLowerCase();
}

export function positiveInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    !Number.isSafeInteger(parsed) ||
    Number(parsed) < minimum ||
    Number(parsed) > maximum
  ) {
    throw new RunnerError(
      "invalid_input",
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return Number(parsed);
}

export function commandName(value: unknown): string {
  const parsed = requiredString(value, "agent command", 64);
  if (!COMMAND_RE.test(parsed)) {
    throw new RunnerError(
      "invalid_job",
      "agent command must be an executable basename",
    );
  }
  return parsed;
}

export function branch(value: unknown): string {
  const parsed = requiredString(value, "branch", 127);
  const invalid =
    !/^vyben\/[a-z0-9][a-z0-9._/-]*$/i.test(parsed) ||
    parsed.includes("..") ||
    parsed.includes("//") ||
    parsed.includes("@{") ||
    parsed.endsWith("/") ||
    parsed.endsWith(".") ||
    parsed.toLowerCase().endsWith(".lock");
  if (invalid) {
    throw new RunnerError(
      "invalid_job",
      "branch must be a valid vyben/* branch",
    );
  }
  return parsed;
}

export function safeHttpsUrl(
  value: unknown,
  name: string,
  allowLocalhost = false,
): URL {
  const parsed = requiredString(value, name, 2_048);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new RunnerError("invalid_input", `${name} must be an absolute URL`);
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" &&
      !(allowLocalhost && local && url.protocol === "http:")) ||
    url.username ||
    url.password
  ) {
    throw new RunnerError(
      "invalid_input",
      `${name} must use HTTPS without embedded credentials`,
    );
  }
  if (url.search || url.hash) {
    throw new RunnerError(
      "invalid_input",
      `${name} must not include a query or fragment`,
    );
  }
  return url;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
