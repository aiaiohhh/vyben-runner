import assert from "node:assert/strict";
import test from "node:test";
import { Redactor } from "../src/redaction.js";

test("redacts exact secrets and common credential formats", () => {
  const redactor = new Redactor();
  redactor.add("exact-secret-value");
  const output = redactor.redact(
    "exact-secret-value github_pat_abcdefghijklmnopqrstuvwxyz123456 Bearer abc.def.ghi sk-test_abcdefghijklmnop",
  );
  assert.equal(output.includes("exact-secret-value"), false);
  assert.equal(output.includes("github_pat_"), false);
  assert.equal(output.includes("Bearer abc"), false);
  assert.equal(output.includes("sk-test_"), false);
  assert.match(output, /\[REDACTED\]/);
});
