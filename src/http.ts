import { RunnerError } from "./errors.js";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function readJson(
  response: Response,
  maxBytes = 65_536,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RunnerError(
        "response_too_large",
        "Remote response exceeded the allowed size",
      );
    }
    chunks.push(value);
  }

  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
  ).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RunnerError(
      "invalid_response",
      "Remote service returned invalid JSON",
    );
  }
}

export function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}
