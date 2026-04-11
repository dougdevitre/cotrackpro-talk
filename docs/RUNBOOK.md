# Runbook

Incident playbook for CoTrackPro Voice Center. Reach for this when
something is on fire. Each section has the same shape: **symptom →
likely cause → verification → fix**.

## Audience

The on-call engineer at 2am. Assume they know the codebase casually
but don't remember specifics. Keep every runbook entry actionable
within 5 minutes or escalate.

## Architecture at a glance

See `docs/adr/` for the full story. The 60-second version:

```
          Twilio
            │
            ├──(HTTP)── /call/incoming  → TwiML → <Stream url>
            │                                       │
            │                                       ▼
            └──(WS)───── wss://ws.example.com/call/stream
                                 │
                                 ▼
                        src/handlers/callHandler.ts
                          │       │         │
                          ▼       ▼         ▼
                        STT     Claude    TTS
                      (11labs) (anthropic) (11labs)
```

In hybrid mode, the HTTP routes live on Vercel (edge/global) and the
WS route lives on a long-running host (Fargate/Fly/Render). DynamoDB
stores call records and cost summaries. KV (Upstash or Vercel KV)
stores rate-limit counters and the idempotency cache.

## Quick triage checklist

Before diving into any section below:

1. **Check `/health` on both tiers.** `https://$API_DOMAIN/health`
   (Vercel) and `https://$WS_DOMAIN/health` (WS host). Both should
   return `status: "ok"`.
2. **Look for the last `cost.call.summary` log line.** If calls are
   completing, this is the authoritative "are we serving traffic?"
   signal.
3. **Check Vercel Logs + Fargate / WS host logs side by side.** Most
   real incidents cross both.
4. **Grep for `err` fields in structured logs.** The core pipeline
   emits `*.error` and `*.failed` log lines with `{ err, callSid }`.
5. **Correlate by `x-request-id` header or `callSid`.** Every HTTP
   response has an `x-request-id`; every WS session has a `callSid`.
   Use them to trace one request through all tiers.

---

## Symptom: "Twilio webhook returns 403"

**Likely causes (in order):**

1. `VALIDATE_TWILIO_SIGNATURE=true` is set but `TWILIO_AUTH_TOKEN`
   is wrong (e.g. after a rotation).
2. The public URL Twilio signed differs from the URL the handler
   reconstructs — a Vercel rewrite regression (audit M-2).
3. Someone is hitting the webhook without a Twilio signature (e.g.
   a misconfigured load balancer health check).

**Verification:**

```bash
# Confirm Twilio auth token matches what's in env
echo $TWILIO_AUTH_TOKEN | md5sum  # compare with Twilio console
```

```
# Grep logs for the 403 line — it includes the signed URL we're
# comparing against.
msg="Invalid Twilio signature"
```

**Fix:**

- **Token mismatch:** redeploy with the correct `TWILIO_AUTH_TOKEN`.
- **URL mismatch:** check `src/core/twiml.ts:buildSignedWebhookUrl`
  — the `publicPath` argument must match what Twilio actually sees
  (not the internal `/api/...` path). Audit M-2 guards this with
  unit tests; a regression would fail them.
- **Health check noise:** add an unauthenticated health endpoint
  OR configure the LB probe to include the Twilio signature header.

## Symptom: "Call connects but no audio plays"

**Likely causes:**

1. ElevenLabs WS handshake failed (env wrong, voice ID wrong,
   account over quota).
2. Anthropic stream timed out (audit E-5).
3. MCP server hung a tool call for 30+ seconds.

**Verification:**

```
# Did the ElevenLabs WS open?
msg="ElevenLabs WS open"  # should appear within ~500ms of call start

# Did it time out?
msg="elevenlabs.connect.timeout"

# Did Anthropic stream time out?
msg="anthropic.stream.timeout"
msg="anthropic.sendToolResult.timeout"
```

**Fix:**

- **ElevenLabs timeout:** check ElevenLabs status page + your
  account quota. Temporary mitigation: increase
  `ELEVENLABS_CONNECT_TIMEOUT_MS` to give it more slack during a
  regional outage.
- **Anthropic timeout:** check status.anthropic.com. Temporary
  mitigation: increase `ANTHROPIC_STREAM_TIMEOUT_MS`. A persistent
  timeout at the default 45s means Claude is the bottleneck, not us.
- **MCP hang:** `src/services/mcp.ts` already has a 30s timeout.
  If it's firing, the MCP server is the problem — check its logs
  or disable the MCP flow temporarily by unsetting
  `COTRACKPRO_MCP_URL` and redeploying.

## Symptom: "`/call/outbound` returns 429"

**Likely causes:**

1. A legitimate client is hammering the endpoint faster than the
   rate limit allows.
2. A leaked API key is being abused.
3. The limit is set too tight for normal operations.

**Verification:**

```
# Which API key (hashed) is getting limited?
msg="Outbound call rate-limited" | stats count() by clientKey
```

Compare `clientKey` values over the last hour. If one hashed key
dominates, that's the offender.

**Fix:**

- **Legit client hammering:** raise `OUTBOUND_RATE_LIMIT_PER_MIN` /
  `PER_HOUR` and have a conversation with the client about why.
- **Leaked key:** rotate `OUTBOUND_API_KEY` immediately. See
  `docs/adr/adr-009-secret-rotation.md` for the procedure.
- **Limit too tight for ops:** raise the limits. Normal Twilio voice
  deployments at this size run at 5-20 outbound calls/min.

## Symptom: "`/records/*` returns 429"

New in audit E-1 (this PR). Same playbook as the outbound 429 above,
but the env vars are `RECORDS_RATE_LIMIT_PER_MIN` / `PER_HOUR` and
the log line is `"msg":"/records rate-limited"`.

## Symptom: "WebSocket host is OOMing / rejecting new calls with WS code 1013"

**Likely causes:**

1. Legitimate traffic is saturating the concurrent-session cap
   (audit E-2).
2. A WS-flood attack is opening connections faster than sessions
   are closing.

**Verification:**

```bash
# What's the peak session count vs the cap?
curl -s https://$WS_DOMAIN/health | jq '{peakActiveCalls, maxConcurrentSessions}'
```

```
# Are we rejecting new streams?
msg="WS session cap reached — rejecting new Twilio stream"
```

**Fix:**

- **Legit traffic:** scale the WS host horizontally (each instance
  has its own session cap, so 2× instances = 2× headroom). Run N
  instances behind the LB; no sticky sessions needed because each
  WebSocket is self-contained.
- **Flood attack:** check Twilio Stream Logs for the caller SIDs.
  If one phone number is opening lots of calls, block it at the
  Twilio level.
- **Short-term firefight:** raise `MAX_CONCURRENT_SESSIONS` while
  you investigate. Each session holds ~20KB plus its Anthropic and
  ElevenLabs streams; budget ~5MB per session conservatively.

## Symptom: "DynamoDB writes are failing"

**Likely causes:**

1. Write throttling (provisioned capacity too low).
2. Table doesn't exist / wrong name in env.
3. IAM role lost write permission.

**Verification:**

```
msg="dynamo.createCallRecord.failed"
```

The error log line (audit E-4) includes `err`, `callSid`, and
`dynamoMaxRetries`. Look at `err.name`:

- `ProvisionedThroughputExceededException` → throttling
- `ResourceNotFoundException` → table name wrong
- `AccessDeniedException` → IAM problem

**Fix:**

- **Throttling:** switch the table to on-demand billing or increase
  provisioned write capacity. Also consider raising
  `DYNAMO_MAX_RETRIES` temporarily.
- **Wrong table:** fix `DYNAMO_TABLE_NAME`. Double-check against
  the AWS console.
- **IAM:** restore `dynamodb:PutItem` / `UpdateItem` permission on
  the role the workload is running under.

**Tolerance:** calls continue when DynamoDB writes fail — the record
drops but the call itself is unaffected. This is deliberate (see
audit E-4). Don't page for a single failure; page if the rate
exceeds the SLO in `docs/SLOs.md#dynamodb-write-success`.

## Symptom: "Daily cost rollup didn't appear"

**Likely causes:**

1. Vercel Cron is broken (check Vercel dashboard).
2. `CRON_SECRET` mismatch.
3. `CRON_SECRET` unset in production — now fails closed with a 500
   (audit E-3).

**Verification:**

```
msg="cost.rollup.starting"  # should appear once/day
msg="cost.rollup.daily"     # should appear once/day right after
msg="CRON_SECRET is unset in production"  # fail-closed log
```

If `cost.rollup.starting` doesn't appear at all, Vercel Cron isn't
hitting the endpoint. If it appears but `cost.rollup.daily` doesn't,
the rollup itself failed — check for `cost.rollup.failed`.

**Fix:**

- **Vercel Cron broken:** check the Crons tab in Vercel project
  settings. Re-enable if disabled.
- **Secret mismatch:** update `CRON_SECRET` to match what Vercel is
  sending. Vercel sets this automatically when you define a cron in
  `vercel.json` — if it's mismatched something is manually set
  wrong.
- **Unset in production:** set `CRON_SECRET`. This is a
  misconfiguration, not a runtime failure.

## Symptom: "KV / Upstash is down"

**Likely causes:**

1. Upstash regional outage.
2. `KV_TOKEN` expired.
3. Network path from Vercel / WS host to Upstash broken.

**Verification:**

```
msg="Rate limiter error — failing open"
msg="Idempotency lookup failed — failing open"
msg="Upstash pipeline failed"
```

**Tolerance:** both the rate limiter and the idempotency cache
**fail open**. Requests continue to succeed; the only operational
impact is:

1. The rate limiter stops rate-limiting until KV recovers.
2. Idempotency replays stop working — retries of the same request
   will dial twice.

Neither is a call-dropping event. Monitor via the SLO in
`docs/SLOs.md` but don't page on a single fail-open.

**Fix:**

- **Upstash regional outage:** wait it out. Nothing to do.
- **Token expired:** generate a new REST token in the Upstash
  console, update `KV_TOKEN`, redeploy.
- **Network path:** check egress firewall rules from the WS host
  (Vercel's egress is managed).

## Symptom: "I need to rotate a secret"

See `docs/adr/adr-009-secret-rotation.md` for the full procedure.
Summary: each secret has its own rotation path; the only one that
can be rotated zero-downtime is `OUTBOUND_API_KEY` via a
multi-value token list (not yet implemented — noted in the ADR).

## Escalation

If none of the above sections cover the symptom:

1. **Capture a snapshot.** Grab the last 5 minutes of logs from
   Vercel + WS host, export `curl -s /health` from both, and save
   the output of `npm audit` if dependencies are suspect.
2. **File an incident.** Include the snapshot, the symptom, and
   what you've already tried.
3. **Default to conservative actions.** Scale out rather than scale
   up. Roll back rather than hotfix. Raise limits rather than
   lower them.

## What this runbook is NOT

- A debugging guide for unknown bugs. It covers known failure modes.
  Anything new goes through normal triage → incident → fix → add a
  new section here so the next on-caller has it.
- Complete. This is the minimum set of symptoms I could see from
  the architecture. Add as you learn.
