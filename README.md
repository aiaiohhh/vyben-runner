# Vyben remote coding runner

This repository contains the GitHub Action used by Vyben's remote coding flow.
It lets a user dispatch a bounded coding job from Vyben while their own
computer is offline. Execution happens on GitHub-hosted Actions infrastructure.

## Security model

- The agent job receives `contents: read` and `id-token: write` only.
- Checkout credentials are never persisted or passed to the coding process.
- A job-scoped GitHub OIDC token is exchanged for a short-lived Vyben token.
- AI provider keys remain behind the Vyben API and are never injected into the
  runner.
- The generated patch is capped, hashed, and handed to a fresh finalizer job;
  runner logs and error messages are redacted.
- Only the finalizer receives an ephemeral `GITHUB_TOKEN` with narrowly scoped
  `contents: write` access.
- The finalizer may push only `vyben/<job-id>` and cannot force-push or merge.
- Vyben opens a draft pull request only after the user reviews and approves the
  exact finalized commit.

## Use from a repository

Copy the reviewed workflow supplied by Vyben to
`.github/workflows/vyben-remote.yml`. Pin both runner steps to the same full
40-character commit SHA:

```yaml
- uses: aiaiohhh/vyben-runner@0123456789abcdef0123456789abcdef01234567
  with:
    mode: run
    job-id: ${{ inputs.job_id }}
```

Never use `main`, a mutable tag, or a pull-request ref. Vyben also records the
SHA-256 digest of the installed workflow and refuses to dispatch modified or
unapproved workflow bytes.

The connected repository stores no OpenAI, Supabase, GitHub App, or Vyben
server secret. See the workflow supplied by the Vyben app for the complete
read-only execution and isolated finalization jobs.

## Development

Node.js 22 or newer is required.

```bash
npm ci
npm test
```

`dist/` is committed because GitHub Actions executes the bundled JavaScript
directly. A release is valid only when rebuilding produces no diff in `dist/`
and all tests pass.

## License

MIT
