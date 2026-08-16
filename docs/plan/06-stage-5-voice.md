# Stage 5: Voice Interaction

Status: planned
Effort: 15-25 focused engineering days

## Objective

Add privacy-controlled push-to-talk, streaming transcription, speech playback, and interruption on desktop and phone, then qualify optional wake-word satellites without treating voice as identity proof.

## Delivery Order

1. Recorded-utterance provider benchmark.
2. Desktop push-to-talk.
3. Phone push-to-talk.
4. Streaming partial transcription.
5. TTS streaming and playback state.
6. Barge-in and Harness turn cancellation.
7. Optional local wake word on desktop or home satellite.

## Architectural Rule

Raw audio and partial transcripts stay in the Jarvis voice plane. Only the accepted final transcript enters the Harness session as a user message. Harness assistant text events feed TTS through Jarvis; audio bytes do not become Harness session events.

## Modules

### `packages/voice-protocol`

Deliver:

- Versioned voice-session state machine.
- Audio frame, partial transcript, final transcript, playback, interruption, and error messages.
- Codec, sample rate, channel count, sequence, timestamp, and utterance identifiers.

State model:

```text
idle -> listening -> transcribing -> thinking -> speaking -> idle
  |         |             |            |          |
  +---------+-------------+------------+----------+-> cancelled/error
```

Acceptance:

- Out-of-order and duplicate audio frames reject or deduplicate deterministically.
- One utterance produces at most one Harness user message.

### Voice gateway

Deliver:

- Authenticated WebSocket audio endpoint.
- Bounded buffers, backpressure, time limits, and disconnect cleanup.
- Provider selection and per-session orchestration.
- No raw-audio persistence by default.

Acceptance:

- Slow clients cannot create unbounded memory growth.
- Disconnect stops provider work and releases buffers.

### `SpeechToTextProvider`

Deliver:

- Streaming partial and final transcript interface.
- Language hints, punctuation, confidence, cancellation, and provider diagnostics.
- Local and cloud provider benchmark harness.

Benchmark corpus:

- Quiet Mandarin commands.
- Household noise.
- English technical terms inside Mandarin.
- Device and person names.
- Corrections, pauses, and interrupted utterances.

Provider selection evidence includes accuracy, first-partial latency, final latency, CPU/memory, network dependency, cost, and data retention.

### `TextToSpeechProvider`

Deliver:

- Streaming audio interface with voice, language, speed, and cancellation.
- Sentence-aware chunking from committed assistant text.
- Local and cloud provider benchmark harness.

Acceptance:

- Cancellation stops provider generation and client playback.
- Failed TTS preserves the readable text response.

### `VoiceActivityProvider`

Deliver:

- Speech start/end detection.
- Configurable silence windows and maximum utterance length.
- Noise calibration profile per device where needed.

Acceptance:

- Household-noise fixtures do not create unbounded empty utterances.

### `WakeWordProvider`

Deliver after push-to-talk qualifies:

- Local wake inference; raw ambient audio is not sent to the gateway before activation.
- Per-device sensitivity and cooldown.
- Visual/audible activation indicator.

Acceptance:

- Measured false accepts and false rejects on the named device and room.
- Wake word starts listening only; it grants no action authorization.

### Turn and playback coordinator

Deliver:

- Final transcript admission to the selected Jarvis conversation.
- Assistant text collection and TTS scheduling.
- Barge-in: stop playback, cancel active synthesis, request Harness turn cancellation, then open a new utterance.
- Suppression of stale audio from cancelled responses.

Acceptance:

- A late TTS chunk from a cancelled turn never plays.
- A queued later user message remains intact after cancellation.

### Voice privacy controls

Deliver:

- Per-device microphone enable state.
- Clear listening and recording indicators.
- Audio retention off by default.
- Transcript review/edit before sending where configured.
- Voice-history deletion independent from conversation deletion if audio retention is enabled later.

Acceptance:

- Disabling the microphone closes active streams.
- Diagnostic exports contain no audio unless explicitly requested.

## Initial Performance Targets

Targets are qualification thresholds, not claims before measurement:

- Push-to-talk start acknowledgement: p95 under 250 ms on the private network.
- First partial transcript: p95 under 1 second after speech starts.
- Final transcript: p95 under 1.5 seconds after speech ends.
- First TTS audio: p95 under 1.5 seconds after the first committed speakable text.
- Barge-in playback stop: p95 under 300 ms.
- No more than one duplicate Harness message in 10,000 replayed protocol trials; target is zero.

Accuracy thresholds are set after the owner records a consented benchmark corpus. Generic public benchmark scores do not substitute for names, accent, language mix, and room noise.

## Acceptance Journeys

| ID | Journey | Required observation |
|---|---|---|
| A-501 | Desktop push-to-talk | Final transcript creates one user message |
| A-502 | Phone push-to-talk | Same conversation updates across clients |
| A-503 | Provider failure | Text interaction remains usable |
| A-504 | Barge-in | Playback stops and old turn cannot speak later |
| A-505 | Network drop | Buffers and provider work are released |
| A-506 | Privacy disable | Microphone stream closes and cannot restart silently |
| A-507 | Wake word | Named physical device meets measured error thresholds |
| A-508 | High-risk spoken request | Phone approval still required; voice is not identity proof |

## Exit Gate

Core voice closes when A-501 through A-506 and A-508 pass on named desktop and phone hardware. Wake-word support is a separately reportable completion requiring A-507; it must not delay push-to-talk release.

## Explicit Non-Goals

- Training a speech model.
- Always-listening mobile background operation.
- Speaker identification as authorization.
- Raw-audio retention by default.
- Claiming wake-word completion from desktop simulation alone.
