# Failure Modes

This document enumerates the concrete failure modes for the audio
pipeline and how the system handles each one today. Audit A-7 in
`docs/CODE_REVIEW-vercel-hosting-optimization.md` flagged that
`docs/RUNBOOK.md` covers "what to do when something breaks"
*reactively*, but there was no companion document covering "which
things are explicitly designed to break gracefully."

This file is the design-time companion to the runbook. For each
failure mode: **what breaks, what the current behavior is, whether
that behavior is intentional, and what the remediation path looks
like**.

## Format

Each entry has:

- **Failure:** one-line description of the scenario.
- **Current behavior:** exactly what happens, referenced to the code
  that enforces it.
- **Acceptable?** yes / no / partial — is this the desired behavior.
- **Remediation:** what a user-visible improvement would look like if
  we decided this isn't acceptable.

## Twilio ↔ Our infrastructure

### Twilio webhook HTTP POST times out

- **Failure:** Twilio POSTs `/call/incoming` and we don't respond
  within ~15s.
- **Current behavior:** Twilio hangs up the caller and plays its
  fallback message. Our `api/call/incoming.ts` function runs to
  completion in well under 200ms normally; a timeout at this layer
  would indicate either a cold-start storm or a Vercel regional
  outage.
- **Acceptable?** Partial. Caller hears "application error" rather
  than a friendly message. We accept this because the alternative
  (pre-warmed functions, dedicated voice-response fallback) is
  expensive for the rarely-hit failure mode.
- **Remediation:** monitor via SLO `inbound-webhook-latency` in
  `docs/SLOs.md`. If p99 regresses, investigate Vercel cold starts
  and consider `maxDuration: 30` → `fluid: true` on the function
  config.

### Twilio Media Stream WebSocket drops mid-call

- **Failure:** network path from Twilio to the WS host breaks
  mid-call.
- **Current behavior:** the `ws` library emits `close`, the call
  handler cleans up the STT / Claude / TTS subscriptions, and
  `destroySession` is invoked. Twilio also detects the drop and
  hangs up the caller. No reconnection — the session is gone.
- **Acceptable?** Yes. The per-call session state lives in memory
  on the WS instance (ADR-002) and cannot be meaningfully
  re-hydrated onto another instance mid-call. The caller has
  already been disconnected on Twilio's side anyway.
- **Remediation:** none planned. See ADR-002.

### Twilio signature validation fails

- **Failure:** `X-Twilio-Signature` header doesn't match the
  expected HMAC.
- **Current behavior:** `api/call/incoming.ts` + Fastify twiml
  handler return 403. Logged as `"Invalid Twilio signature"`.
- **Acceptable?** Yes. This is the intended behavior when
  `VALIDATE_TWILIO_SIGNATURE=true`.
- **Remediation:** see `docs/RUNBOOK.md#symptom-twilio-webhook-returns-403`.

## External services (Anthropic, ElevenLabs, MCP)

### Anthropic Claude stream times out

- **Failure:** the `client.messages.stream()` call doesn't emit
  tokens within `ANTHROPIC_STREAM_TIMEOUT_MS` (default 45s).
- **Current behavior:** `AbortSignal.timeout` aborts the HTTP
  request, the SDK throws, `streamResponse` catches and emits
  `anthropic.stream.timeout` structured log. The `onError`
  callback is invoked and the call handler propagates the error
  to tear down the turn (but NOT the whole call — the session
  continues, the caller gets silence from the model).
- **Acceptable?** Partial. No graceful fallback today — the caller
  hears silence rather than "I'm having trouble, please hold."
- **Remediation:** add a fallback utterance played when
  `onError` fires during a turn. Small change in
  `src/handlers/callHandler.ts`. Noted as a future improvement,
  not built.

### Anthropic Claude returns 429

- **Failure:** Anthropic rate-limits the API key mid-call.
- **Current behavior:** the SDK surfaces the 429 as an error
  through `onError`. Same handling as the timeout case above.
- **Acceptable?** Partial. Same remediation as the timeout case.
- **Remediation:** add retry with backoff in the SDK layer OR
  fall back to a pre-recorded "please hold" utterance from
  `src/audio/prerecorded.ts`.

### ElevenLabs TTS WebSocket fails to connect

- **Failure:** the WS handshake doesn't complete within
  `ELEVENLABS_CONNECT_TIMEOUT_MS` (default 10s).
- **Current behavior:** the timeout guard in
  `src/services/elevenlabs.ts:connect` terminates the half-open
  socket, rejects the `connect()` promise with a
  `TimeoutError`, and emits `elevenlabs.connect.timeout`. The
  call handler propagates and tears down the turn.
- **Acceptable?** Yes — the timeout closes the worst failure mode
  (wedged connect blocking the whole call). The user-visible
  impact is caller hears silence for ~10s, then hears hangup.
- **Remediation:** pre-recorded fallback ("please hold while I
  reconnect") if the first connect fails. Same class of
  improvement as the Anthropic cases above.

### ElevenLabs TTS WebSocket drops mid-utterance

- **Failure:** WS closes with an error after BOS but before the
  audio is fully streamed.
- **Current behavior:** `onError` callback fires, call handler
  tears down the current TTS stream but NOT the whole session —
  the next turn can try again.
- **Acceptable?** Yes. Per-utterance isolation is correct.

### MCP tool call hangs

- **Failure:** the CoTrackPro MCP server doesn't respond to a tool
  call within 30s.
- **Current behavior:** `src/services/mcp.ts` uses
  `AbortSignal.timeout(30_000)` — the fetch aborts and throws.
  The tool-call path in the call handler surfaces the error back
  to Claude as a tool_result error, which Claude handles by
  either re-trying (wasting more time) or giving up and saying
  it couldn't look up the information.
- **Acceptable?** Partial. Same fallback-utterance question as
  Anthropic.
- **Remediation:** (a) shorten the MCP timeout to 10s since voice
  calls can't afford to wait 30s, or (b) add a fast-fail
  pre-recorded "I couldn't look that up" utterance. Judgment call.

## DynamoDB

### `createCallRecord` times out / throttled

- **Failure:** DynamoDB returns `ProvisionedThroughputExceededException`
  or the write fails after `DYNAMO_MAX_RETRIES` retries.
- **Current behavior:** `src/services/dynamo.ts` emits the
  structured `dynamo.createCallRecord.failed` log line (audit E-4)
  and re-throws. The caller in `callHandler.ts` catches the throw
  and — this is important — **continues the call without
  persistence**. The audio pipeline is unaffected; the only loss
  is a missing row in the DynamoDB table for this call.
- **Acceptable?** Yes. Voice call > cost record. The SLO in
  `docs/SLOs.md#dynamodb-write-success` bounds how often we can
  miss records before it becomes an alerting incident.
- **Remediation:** switch to DynamoDB on-demand billing to
  eliminate throttling as a failure mode. Operational fix, not a
  code change.

### DynamoDB is entirely unavailable (regional outage)

- **Failure:** all DynamoDB calls throw for minutes.
- **Current behavior:** every `createCallRecord` call fails. Calls
  continue to work (as above). `listRecentCalls` and similar
  query endpoints return 500 — no fallback to a cached response.
- **Acceptable?** Yes for write path, partial for read path. The
  dashboard temporarily shows errors until DynamoDB recovers.
- **Remediation:** in-memory cache of the last N records for
  dashboard reads. Not planned; DynamoDB regional outages are
  infrequent enough to not justify the complexity.

## KV (Upstash / Vercel KV)

### KV unavailable, rate limiter can't increment counters

- **Failure:** Upstash REST endpoint times out / errors.
- **Current behavior:** `checkRateLimit` catches the error and
  returns `allowed: true` — **fail open**. Logged as
  `"Rate limiter error — failing open"`.
- **Acceptable?** Yes. A rate-limiter outage that blocks
  legitimate traffic is strictly worse than a brief window of
  unrate-limited traffic. See ADR-005.
- **Remediation:** none. This is the intended behavior.

### KV unavailable, idempotency cache can't look up replays

- **Failure:** same as above, but for the idempotency cache.
- **Current behavior:** `lookupIdempotent` catches, returns
  `{ hit: false }` — the request proceeds as if there were no
  cached replay. This means a retry of the same request during a
  KV outage will dial twice.
- **Acceptable?** Yes, with caveat. The rate limiter still bounds
  the blast radius, and the alternative (failing the request
  outright because we can't check the cache) is worse.
- **Remediation:** none. See ADR-003.

## Vercel / WS host

### Vercel function cold start

- **Failure:** first request after a cold period takes 800ms-2s
  to respond.
- **Current behavior:** Twilio waits up to ~15s, so a cold start
  is usually within budget. The SLO in
  `docs/SLOs.md#inbound-webhook-latency` (p95 < 200ms) will burn
  budget during cold-start bursts.
- **Acceptable?** Partial. Cold starts are infrequent enough to
  not be a daily problem, but do chew through error budget.
- **Remediation:** Vercel Fluid Compute keeps functions warm.
  Consider enabling if SLO burndown shows cold-start dominance.

### WS host process crash

- **Failure:** the Fastify server OOMs, segfaults, or is killed by
  the orchestrator.
- **Current behavior:** all active WebSocket sessions drop. Twilio
  detects the WS drop and hangs up each call. The orchestrator
  (ECS, Fly, etc.) restarts the process; new calls land on the
  new instance. Graceful-shutdown code in `src/index.ts` only
  fires on SIGTERM — a hard crash bypasses it.
- **Acceptable?** Yes for crashes; we can't save in-flight calls
  without instance-to-instance session replication, which
  ADR-002 explicitly rejects.
- **Remediation:** run N > 1 instances behind a load balancer so
  a single crash only affects that instance's calls.

### WS host hits `MAX_CONCURRENT_SESSIONS` cap

- **Failure:** the WS instance is already at its configured cap
  when a new Twilio Media Stream connects.
- **Current behavior:** `handleCallStream` checks `isAtCapacity()`
  first, logs `"WS session cap reached — rejecting new Twilio
  stream"`, and closes the WS with code 1013 (Try Again Later).
  Twilio hangs up the caller. No resources allocated downstream.
- **Acceptable?** Yes. This is the intended E-2 behavior.
- **Remediation:** scale out horizontally (more WS instances) or
  raise `MAX_CONCURRENT_SESSIONS` if the host has headroom. See
  `docs/RUNBOOK.md#symptom-websocket-host-is-ooming--rejecting-new-calls-with-ws-code-1013`.

## Failure modes NOT currently covered

The following are known gaps — the code doesn't handle them
explicitly, and they're flagged here so the next person who sees
one in production knows it's a known-unknown, not a mystery.

- **Graceful fallback utterances.** See the Anthropic / ElevenLabs
  / MCP sections above. Nothing plays a friendly "please hold"
  today; errors result in silence-then-hangup.
- **Per-turn timeouts inside a long call.** Today we have per-call
  timeouts on individual service calls (E-5) but no budget on
  total turn duration. A runaway Claude response that streams
  slowly for 45s hits the timeout; a runaway that streams at
  exactly the legal rate for 120s just keeps going.
- **Tool-call retry.** If an MCP tool call times out, Claude's
  retry logic determines what happens next. We don't intercept
  or shape that behavior.
- **Cost runaway detection mid-call.** Today we log cost at
  call-end. A call that somehow accumulates $5 in Claude tokens
  mid-turn won't trip any alert until the final
  `cost.call.summary` lands. A mid-call cost watchdog would catch
  this. Not built.

## Remaining deferred items from prior audits

Tracked here so follow-up sessions know where to look:

- **P-2 (end-to-end integration tests)** — substantially closed. The
  `tests/callHandler.test.ts` characterization suite now covers the
  inbound happy path, barge-in, Claude tool-use round-trip, Anthropic
  stream error fallback, and session-cap reject. The DI seam in
  `src/handlers/callHandler.ts` plus `tests/fakes/` make additional
  scenarios trivial to add. What's NOT covered: tests that
  exercise the real Anthropic + ElevenLabs + Twilio stack end-to-end
  (those need a staged deploy + real call, not a unit test).

- **E-6 / A-6 (`callHandler.ts` refactor)** — still open. The 660-line
  handler is now protected by five characterization tests, so the
  refactor has a safety net. The recommended next move: extract pure
  functions for audio buffer management, barge-in state machine, and
  sentence-piped callbacks into `src/core/`, leaving the WS event
  glue in `callHandler.ts`. Along the way, fix the latent eager-parallel
  TTS orphan pattern documented in the scenario-1 golden record.
  Explicitly deferred from the current PR because it wants a dedicated
  session with careful staging.

- **Graceful fallback utterances (from the Anthropic/MCP failure
  sections above).** The Anthropic error characterization test
  locks in that the handler DOES play `ERROR_GENERIC_TEXT` through
  live TTS on Claude failure, so technically this "remaining item"
  is half-done — the fallback exists, it's just a bit blunt (same
  text for every kind of error). A richer error-recovery story
  (Claude 429 vs timeout vs 500 each get different copy) is a
  future enhancement.

## Reviewing this document

Add a new entry every time a new failure mode is encountered in
production. Update an existing entry when the remediation changes.
Keep the format consistent so the runbook can cross-reference
specific failures.
