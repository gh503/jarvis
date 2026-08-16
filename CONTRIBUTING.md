# Contributing

Jarvis is developed through public Issues and pull requests. The current priority is a safe, local-first macOS assistant before remote, voice, or smart-home capabilities.

## Workflow

1. Check the [roadmap](docs/plan/README.md) and existing Issues.
2. Open or claim one Issue with explicit acceptance criteria.
3. Create a focused branch from `main`.
4. Run `npm run verify` before opening a pull request.
5. Explain behavior, safety impact, tests, and any unresolved limitation in the pull request.

## Engineering Rules

- Keep Harness integration behind the plugin boundary; do not fork or copy Harness internals.
- Preserve loopback-only defaults. Remote access requires a Jarvis-owned authenticated gateway.
- Do not add arbitrary shell execution or unrestricted filesystem access.
- Bind approvals to deterministic action data before expanding side-effect capabilities.
- Never commit API keys, `.env`, local sessions, reminders, audit logs, device identifiers, or generated credentials.
- Separate build evidence from real model, browser, device, and hardware evidence.

## Local Verification

```bash
npm ci
npm run verify
```

For runtime changes, also start the app and verify `GET /jarvis/health`, the Web UI, the approval path, and the affected user journey.
