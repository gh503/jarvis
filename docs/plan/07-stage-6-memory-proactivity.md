# Stage 6: Curated Memory and Proactive Service

Status: planned
Effort: 12-18 focused engineering days

## Objective

Add owner-controlled long-term memory and reliable proactive notifications while keeping model suggestions separate from deterministic storage, scheduling, policy, and action execution.

## Harness Boundary

Harness session logs remain the source for conversation reconstruction and compaction. They are not the Jarvis personal-memory database.

Harness Schedule is retained only for session-local reminders. Its current delivery requires the original root session to be live, has no external notification receipt, and does not provide a cold-session reliable scheduler. Jarvis-owned reminders and automations therefore use a separate durable scheduler.

## Memory Classes

| Class | Example | Authority | Default retention |
|---|---|---|---|
| Profile fact | Preferred language | Owner-confirmed fact store | Until edited/deleted |
| Episodic memory | Project decision summary | Curated event with provenance | Configurable |
| Operational state | Reminder, task, device state | Structured domain service | Domain-specific |
| Retrieval index | Text/embedding projection | Rebuildable derivative | Until source deletion |

Raw model reasoning is never a memory authority.

## Current Increment

The versioned owner-controlled source store is tracked by [#88](https://github.com/gh503/jarvis/issues/88).

- Candidates enter only the proposed state and cannot become confirmed through model authority in this increment.
- Confirmed edits supersede the previous source item; rejected, superseded, expired, and physically deleted items are excluded from recall.
- The bounded private source file is initialized by Jarvis and included in offline backup/restore with semantic validation.
- Automatic extraction, prompt-context retrieval, derived indexes, owner management UI, and proactive rules remain deferred.

## Modules

### `packages/memory`

Deliver:

- Versioned memory item schema.
- Owner, type, content, sensitivity, confidence, source, creation time, valid time, expiry, and status.
- States: proposed, confirmed, rejected, superseded, expired, deleted.
- Edit, confirm, reject, supersede, export, and delete operations.

Acceptance:

- Model-created candidates cannot enter confirmed state without deterministic policy or owner action.
- Deleting a source removes or invalidates its retrieval projections.

### Memory candidate pipeline

Deliver:

- Explicit user command to remember a fact.
- Optional post-turn candidate extraction behind a feature flag.
- Deterministic duplicate detection and contradiction presentation.
- Sensitivity classifier used for policy, not treated as infallible truth.

Acceptance:

- Contradictory facts are shown together; newest does not silently overwrite authoritative data.
- Sensitive candidates require confirmation.
- Extraction failure does not affect the conversation result.

### Retrieval service

Deliver:

- Structured filters by owner, class, source, sensitivity, validity, and time.
- Full-text baseline.
- Optional embedding index selected only after benchmark.
- Hybrid ranking using relevance, recency, confidence, and explicit pinning.
- Bounded context renderer with provenance.

Acceptance:

- Cross-owner results reject by construction.
- Every model-visible memory includes source identity.
- Rebuilding the derivative index yields equivalent searchable sources.

### Memory management UI

Deliver:

- Proposed, confirmed, conflicting, expired, and deleted views.
- Search, edit, confirm, reject, export, and delete.
- Explanation of why an item was recalled in a conversation.

Acceptance:

- Owner can remove a fact and verify it is absent from later retrieval.
- Bulk export and deletion produce parity reports.

### `packages/automation`

Deliver:

- Durable one-shot, calendar, and interval schedules.
- IANA time zones and explicit daylight-saving behavior.
- Trigger definitions separated from action definitions.
- Transactional claim, lease, retry, and terminal execution records.
- Missed-run policy: skip, latest-only, or bounded catch-up.

Acceptance:

- Process restart does not lose due work.
- Two scheduler workers cannot execute one occurrence concurrently.
- Clock jump and daylight-saving fixtures are deterministic.

### Trigger engine

Initial trigger types:

- Time reached.
- Device state changed.
- Computer node became unavailable.
- Reminder or task deadline approached.
- Conversation-derived candidate awaiting review.

Deliver:

- Normalized trigger event with source and deduplication key.
- Rule conditions evaluated without a model where possible.
- Optional model interpretation produces a proposal, not an action.

Acceptance:

- Replayed source events do not duplicate notifications or actions.
- Unknown conditions fail closed.

### Notification service

Deliver:

- In-app and push channels.
- Category preferences, quiet hours, aggregation, rate limits, and escalation.
- Delivery attempt, provider acknowledgement, and user-read state kept separate.

Acceptance:

- Provider acceptance is not reported as user read.
- Quiet-hours exceptions are explicit and testable.

### Proactive action policy

Deliver:

- Allowed autonomous outcome classes: read, summarize, notify, and propose.
- Side effects use the same command and approval lifecycle as reactive requests.
- Daily and per-rule action budgets.
- Global pause control.

Acceptance:

- High-risk or prohibited actions never gain authority from a schedule or model proposal.
- Budget exhaustion stops further actions and remains visible.

## Acceptance Journeys

| ID | Journey | Required observation |
|---|---|---|
| A-601 | Confirm fact | Confirmed fact is recalled with provenance |
| A-602 | Contradiction | Competing facts are presented, not silently overwritten |
| A-603 | Delete fact | Source and retrieval projection disappear |
| A-604 | Restart reminder | Due reminder survives full process restart |
| A-605 | Duplicate trigger | One occurrence and one notification |
| A-606 | Quiet hours | Notification defers according to explicit policy |
| A-607 | Proactive high-risk request | Proposal created; no side effect before approval |
| A-608 | Index rebuild | Searchable source parity before and after rebuild |

## Exit Gate

Stage 6 closes when A-601 through A-608 pass with real restart, phone notification, and deletion readback evidence.

## Explicit Non-Goals

- Storing all conversations as permanent personal facts.
- Treating embeddings as authoritative records.
- Autonomous high-risk actions.
- Relying on a live Harness session for reliable notifications.
- Claiming that notification delivery proves the owner read it.
