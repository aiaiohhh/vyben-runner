const SECRET_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bBearer\s+[^\s"']+/gi,
];

export class Redactor {
  private readonly secrets = new Set<string>();

  add(secret: string | undefined): void {
    if (secret && secret.length >= 4) this.secrets.add(secret);
  }

  redact(value: string): string {
    let redacted = value;
    for (const secret of [...this.secrets].sort(
      (left, right) => right.length - left.length,
    )) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
    for (const pattern of SECRET_PATTERNS)
      redacted = redacted.replace(pattern, "[REDACTED]");
    return redacted;
  }
}

export function boundedMessage(value: string, maxLength = 500): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}
