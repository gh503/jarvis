# Jarvis Development Journey

Status: accepted phased baseline; later stage gates preserve unresolved choices

## Planning Unit

Effort is expressed in focused engineering days, where one day is approximately six productive implementation hours. Calendar duration depends on availability, review time, hardware access, and third-party approval. Ranges include implementation, tests, documentation, and one correction pass.

## Milestone Chain

| Milestone | Outcome | Focused days | Depends on |
|---|---|---:|---|
| M0 | Qualified Harness foundation | 5-8 | None |
| M1 | Local text Jarvis | 10-15 | M0 |
| M2 | Safe computer node | 10-15 | M1 |
| M3 | Mobile companion and remote access | 8-12 | M1, identity baseline |
| M4 | Home Assistant and MQTT devices | 8-12 | M2 command protocol, M3 approvals |
| M5 | Duplex voice interaction | 15-25 | M1 cancellation, M3 client transport |
| M6 | Curated memory and proactive service | 12-18 | M1 audit, M4/M5 events |
| M7 | Recovery, hardening, and v1.0 release | 10-15 | M1-M6 |

Expected total: 78-120 focused engineering days. This is roughly four to six full-time months or eight to twelve part-time months for one developer. The estimate excludes building custom smart hardware and training speech models.

## Milestone Rules

1. A milestone cannot close while a listed exit criterion lacks direct evidence.
2. Passing compilation proves build compatibility only.
3. Unit tests prove package behavior only.
4. Cross-process or cross-device behavior requires a runnable scenario and captured result.
5. Hardware behavior requires observation on the named hardware and firmware version.
6. Security-sensitive paths require both allowed and denied evidence.
7. Every persistent schema change includes migration, backup, and restore evidence.
8. Every externally consumed protocol has a version and compatibility test.

## Stage Gates

### Gate A: Architecture qualified

Allows M1 product work only after the Harness adapter, plugin lifecycle, session bridge, and persistence restart paths are proven against the pinned upstream revision.

### Gate B: Action safety qualified

Allows general computer actions only after actor identity, target identity, risk classification, idempotency, approval binding, audit, timeout, and reconnect are implemented.

### Gate C: Remote access qualified

Allows phone access only after private-network ingress, device pairing, revocation, session expiry, and rate limits pass.

### Gate D: Physical control qualified

Allows smart-home writes only after Home Assistant entity mapping, command acknowledgement, resulting-state observation, and high-risk approval policies pass.

### Gate E: Voice qualified

Allows wake-word operation only after push-to-talk, turn cancellation, playback interruption, transcript review, and audio-retention controls pass.

### Gate F: Proactivity qualified

Allows autonomous triggers only after deterministic rule ownership, quiet hours, notification rate limits, explainability, and approval policy pass.

## Cross-Stage Definition of Done

- Code is formatted, typechecked, and covered by focused tests.
- Public behavior has a runnable acceptance scenario.
- Configuration has schema validation and safe defaults.
- Failure behavior is visible and actionable.
- Logs carry correlation identifiers and exclude secrets.
- Relevant threat-model entries are reviewed.
- User-facing data can be exported or deleted where applicable.
- Upgrade and rollback impact is documented.
- The stage runbook works from a clean checkout.

## Release Trains

### Prototype releases

`0.0.x`: M0-M1. Breaking changes allowed; local development only.

### Private alpha

`0.1.x`: M2-M3. One owner, paired devices, private network only.

### Home alpha

`0.2.x`: M4-M5. Smart-home and voice available behind feature flags.

### Personal beta

`0.3.x`: M6. Daily use, memory controls, proactive notifications.

### Stable personal release

`1.0.0`: M7. Backup/restore, migration, recovery, documented supported platforms, and pinned Harness compatibility.

## Critical Path

```text
Harness adapter
  -> versioned Jarvis protocol
  -> identity and policy
  -> command lifecycle
  -> desktop node
  -> remote approvals
  -> physical device control
  -> voice interruption
  -> proactive automation
  -> recovery and release
```

Mobile UI and Home Assistant read-only discovery can proceed in parallel after M1. Voice provider experiments can proceed before M3, but integration cannot close before cancellation and remote client transport are stable.

## Risk Register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Harness pre-release API changes | High | High | Exact pin, adapter boundary, contract suite |
| macOS permission and background restrictions | Medium | High | Native node agent, capability probes, signed helper later |
| Mobile background audio restrictions | High | Medium | Push-to-talk first, native app only when justified |
| Unsafe model-generated actions | Medium | Critical | Deterministic policy, exact approvals, local node policy |
| Smart-home state ambiguity | Medium | High | Separate acknowledgement from observed resulting state |
| Memory stores sensitive or false facts | Medium | High | Provenance, confirmation, retention, edit/delete UI |
| Single-host outage | Medium | Medium | Backups, supervised processes, dedicated host at maturity |
| Excessive architecture scope | High | High | Stage gates, modular monolith, five initial workflows |

## Decisions Required Before Later Stages

1. Development host versus permanent host.
2. First supported phone platform.
3. Home Assistant availability.
4. Voice privacy posture.
5. Permanent never-autonomous action list.
