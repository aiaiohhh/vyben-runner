import { RunnerError } from "./errors.js";
export async function readJson(response, maxBytes = 65_536) {
    const reader = response.body?.getReader();
    if (!reader)
        return null;
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new RunnerError("response_too_large", "Remote response exceeded the allowed size");
        }
        chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        throw new RunnerError("invalid_response", "Remote service returned invalid JSON");
    }
}
export function timeoutSignal(milliseconds) {
    return AbortSignal.timeout(milliseconds);
}
