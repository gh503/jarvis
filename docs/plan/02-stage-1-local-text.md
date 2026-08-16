# Stage 1: Local Text Jarvis

Status: planned
Effort: 10-15 focused engineering days

## Objective

Deliver a useful single-owner Jarvis on the development Mac that can hold conversations, execute a minimal safe tool set, request approval, preserve state across restart, and expose complete audit evidence.

## Initial Workflows

The final five workflows require user confirmation. The technical baseline uses these replaceable examples:

1. Summarize local notes from an allowlisted directory.
2. Create a personal reminder after explicit confirmation of date and text.
3. Show current computer status without changing it.
4. Open an allowlisted application.
5. Draft, but do not send, a message or email.

## Modules

### `apps/gateway`

Deliver:

- Fastify-based loopback HTTP server.
- `/v1/health`, `/v1/ready`, `/v1/conversations`, `/v1/messages`, `/v1/approvals`, and `/v1/events`.
- Server-generated correlation IDs, request limits, timeouts, and structured errors.
- Development authentication using one local bootstrap credential; no public binding.

Acceptance:

- Unauthenticated requests reject.
- Payload and message size limits reject before Harness admission.
- Event reconnect resumes from the last acknowledged event where retained.

### `apps/web`

Deliver:

- Responsive conversation view.
- Agent status, tool activity, approval request, and failure states.
- Conversation list and restart-resume behavior.
- Accessible keyboard and screen-reader behavior for primary actions.

Acceptance:

- A user can complete all five baseline workflows without opening developer tools.
- Pending, running, cancelled, failed, and completed states are visually distinct.

### Conversation service

Deliver:

- Jarvis conversation ID to Harness session ID mapping.
- Create, list, open, message, cancel, and archive operations.
- Transactional persistence of mapping before a prompt is accepted.
- Session event projection into versioned Jarvis events.

Acceptance:

- Process restart does not create a second Harness session for an existing conversation.
- Duplicate message submissions are idempotent.
- Cancellation does not silently drop a queued later message.

### `packages/tools-core`

Deliver:

- Read-only computer status tool.
- Allowlisted application-open proposal and executor.
- Reminder proposal tool backed by Jarvis structured storage.
- Draft-only communication tool with no send capability.

Acceptance:

- Tool schemas reject unknown fields.
- Application targets outside the allowlist deny.
- Draft tools cannot reach a network send adapter.

### `packages/policy`

Deliver:

- Capability registry and risk classification.
- Deterministic policy evaluation before every Jarvis tool execution.
- Exact-command approval requirement for medium and high risk.
- Prohibited capability response.

Acceptance:

- Changing any approved command argument invalidates the approval.
- Expired approvals cannot execute.
- Model text cannot override policy.

### `packages/audit`

Deliver:

- Append-only audit table.
- Actor, owner, conversation, command, target, policy decision, approval, outcome, and correlation fields.
- Redacted diagnostic export.

Acceptance:

- Every attempted action has one traceable audit chain, including denial and timeout.
- Audit write failure prevents side-effect execution.

### Persistence and migration

Deliver:

- Jarvis SQLite database with migration table.
- Separate Harness data directory.
- Atomic backup command for both stores after quiescing or flushing Harness.
- Restore validation command.

Acceptance:

- Backup and restore preserve one complete acceptance conversation and its audit chain.
- Failed migration leaves the prior database recoverable.

### Minimal memory

Deliver:

- User-confirmed profile facts only.
- Read, edit, and delete operations.
- Provenance pointing to the confirming conversation event.

Acceptance:

- The model cannot directly commit memory.
- Deleted facts are absent from later prompt context.

## Acceptance Journeys

### A-101: Conversation restart

Create a conversation, exchange messages, restart gateway and core, reopen the conversation, and continue with correct prior context.

### A-102: Safe read

Ask for computer status. Verify policy allows the read, output reflects the target host, and audit records the result.

### A-103: Approval-bound action

Request opening an allowlisted application. Verify the exact action waits, approval executes once, duplicate delivery does not reopen it, and audit records all transitions.

### A-104: Changed action after approval

Approve one application, then mutate the target before dispatch. Verify digest mismatch denies execution.

### A-105: Cancellation

Cancel an active turn. Verify the agent becomes idle, the UI settles, and a later message still runs.

### A-106: Backup and restore

Back up, remove the disposable test data directory, restore, and verify conversation, mapping, profile fact, and audit parity.

## Exit Gate

Stage 1 closes when A-101 through A-106 pass from the Web client against real local processes. Mock-only evidence is insufficient.

## Explicit Non-Goals

- Remote phone access.
- Arbitrary shell execution.
- Full filesystem access.
- Sending communications.
- Smart-home control.
- Voice input or output.
