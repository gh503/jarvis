# Mac MVP Qualification

This document records the evidence boundary for the first public Mac release.
It deliberately never records an API key, transcript, reminder text, device identifier, or raw audit log.

## Automated checks

Run from a clean checkout:

```bash
npm ci
npm run verify
npm run verify:runtime
```

These checks prove TypeScript compilation, unit behavior, a no-key local startup,
the loopback health response, and rejection of an unsupported HTTP method. They do
not prove that the DeepSeek API accepts an owner's key or that the Web UI can
complete a model conversation.

## Owner-operated checks

Use a disposable reminder and a harmless allowlisted application. Keep the values
local and report only pass/fail plus timestamps.

1. Put the owner-provided key in the untracked `.env` file, start Jarvis, and open the local Web UI.
2. Start a fresh conversation and ask for a short text reply. Confirm committed assistant text appears.
3. Ask for current Mac status and create/list a reminder. Confirm both tool results appear.
4. Ask to open `Notes`. Confirm the request pauses for approval; decline once and confirm no launch; repeat and approve once.
5. Restart Jarvis. Reopen the same conversation and confirm the reminder remains available.
6. Remove the local key and disposable data after the check if the machine is not the development host.

Record evidence in the GitHub Issue without attaching secrets or private content:

```text
Date: YYYY-MM-DD
Automated checks: pass/fail
Fresh text conversation: pass/fail
System status and reminder tools: pass/fail
Decline and approved Notes launch: pass/fail
Restart persistence: pass/fail
Evidence retained locally: yes/no
```

The Mac MVP is not considered fully qualified until these owner-operated checks
are recorded separately from automated startup and unit-test evidence.
