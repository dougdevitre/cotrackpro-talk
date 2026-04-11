# Service Level Objectives

This document defines the SLIs, SLOs, and log metric filters CoTrackPro
Voice Center measures in production. It's deliberately short — the
point is to commit to specific numbers so we can alert on regressions
and know when to push back on feature work.

**Status:** initial draft. Numbers in this document are targets, not
empirical measurements — validate against real traffic and tighten
them over time.

## Audience

- **On-call engineer:** find the alert target, find the log metric
  filter that measures it, and know what "burning the budget" means.
- **Product / engineering planning:** know when a quarter's SLO
  budget is burning down and feature work needs to yield to
  reliability.

## Ground rules

1. Every SLO has exactly one SLI (the measured signal) and one
   target (the promise). No "informational" metrics here — if we
   measure it, we alert on it.
2. Every SLO has a concrete CloudWatch / Vercel log metric filter
   next to it. "How do I measure this" is answered in-line; an
   on-caller should never have to guess.
3. SLOs are set per-environment. Production is the binding target;
   preview and dev environments track the same metrics but don't
   have alerting thresholds.
4. We track a rolling 28-day error budget. When more than 50% of
   the budget is burned, feature work pauses and reliability work
   takes priority for the remainder of the window.

## SLOs

### Call availability

**What:** the fraction of inbound calls that successfully reach the
Claude <-> ElevenLabs <-> Twilio audio loop. "Success" means:

- TwiML webhook returned 200 and pointed `<Stream url>` at the WS host
- WebSocket handshake completed within 10s
- First TTS audio frame reached Twilio within 5s of the first STT
  transcript event

**SLI:** `1 - (calls with status ∈ {failed, force-reaped}) / (total calls)`

**Target:** **99.5%** rolling 28-day.
- Budget: 0.5% of calls can fail. At 500 calls/day that's ~70 failed
  calls per month.

**Log metric filter:**
```
msg="cost.call.summary" | stats count() by status
```
Ratio of `status != "completed"` over total.

### Inbound webhook latency

**What:** wall time from Twilio delivering a webhook to `/call/incoming`
until the TwiML response ends. This bounds how fast the caller
connects to the AI.

**SLI:** p95 latency of `POST /call/incoming`, measured from Vercel
function duration logs (hybrid) or Fastify access logs (single-host).

**Target:** **p95 < 200ms**, **p99 < 500ms**.

**Log metric filter (Vercel):**
```
path="/call/incoming" method="POST" | stats percentile(duration, 95), percentile(duration, 99)
```

Note: this does NOT include the WebSocket handshake latency or the
first-audio-out latency — those are measured under "Call availability"
above.

### Outbound rate-limit false-positive rate

**What:** the fraction of `POST /call/outbound` requests that return
429 because of the rate limiter. Too high means the limits are too
tight; sustained > 1% means operations is being blocked and the
caller should investigate (either raise the limit or fix a client
that's hammering the endpoint).

**SLI:** `count(429) / count(all outbound requests)`

**Target:** **< 1%** rolling 7-day. Alert at > 5% for 15 minutes.

**Log metric filter:**
```
msg="Outbound call rate-limited" | stats count() as limited,
  sum(if(msg="Outbound call initiated", 1, 0)) as initiated
```

### Per-call cost

**What:** the 95th-percentile per-call estimated USD cost. Bounds
the worst-case billing impact of a single caller session. A runaway
call that costs $2 is an incident; the 2-hour max-duration reaper
bounds it but we want to catch it earlier.

**SLI:** `p95(cost.call.summary.estimatedCostUsd)` over rolling 24h.

**Target:** **p95 < $0.10 per call**. Alert at p95 > $0.25 for 1h.

**Log metric filter:**
```
msg="cost.call.summary" | stats percentile(estimatedCostUsd, 95)
```

### Daily cost-rollup freshness

**What:** the daily `cost.rollup.daily` log line must appear every
24 hours within a 30-minute window of the scheduled time. Missing
rollups are how you notice the cron is broken.

**SLI:** time since last `cost.rollup.daily` log line.

**Target:** **< 25 hours** at all times (allows for Vercel cron
jitter + an hour of grace).

**Log metric filter:**
```
msg="cost.rollup.daily" | stats max(@timestamp) as last
```

Alert when `now - last > 25h`.

### DynamoDB write success

**What:** `createCallRecord` throws after exhausting the retry
budget. Measured from the `dynamo.createCallRecord.failed` structured
error line added in audit E-4.

**SLI:** `count(dynamo.createCallRecord.failed) / count(cost.call.summary)`

**Target:** **< 0.1%** rolling 7-day. Alert at > 1% for 15 minutes.

**Log metric filter:**
```
msg="dynamo.createCallRecord.failed" | stats count()
```

### Session capacity headroom

**What:** the ratio of `peakActiveCalls / maxConcurrentSessions` from
`/health`. When this trends toward 1 over days, the WS host is
getting close to capacity and ops needs to scale out or raise the
cap (audit E-2).

**SLI:** peak concurrent sessions reported by `/health` endpoint.

**Target:** **< 70%** sustained. Alert at > 90% for 15 minutes.

**Metric source:** poll `GET /health` every 60s from a scraper.

## What this document is NOT

- A performance optimization plan. SLOs are about contractual
  promises, not how we make things faster.
- A complete list of every metric worth logging. We log plenty more
  (`cost.call.summary` carries 10+ fields); only signals with an
  explicit target live here.
- Static. When the first quarter of real data comes back, tighten or
  loosen each target to reflect reality. A 99.5% target that we hit
  99.95% every month is too loose; one we hit 98% every month is
  too tight.

## Review cadence

Review this document quarterly. For each SLO:

1. Did we hit it last quarter?
2. If yes, should we tighten it?
3. If no, what pushed us over budget? Was it feature work or
   operational issues?
4. Is the log metric filter still correct for the current log format?

## Deferred (future work)

- **Per-region SLO targets** — currently single-region deployment
  (see `docs/adr/adr-007-single-region-for-now.md`). When we go
  multi-region, each region needs its own availability target.
- **Claude stream latency histogram** — we don't currently export
  token-to-first-byte as a measured SLI. Add when call availability
  starts to be bounded by Anthropic latency rather than our own
  pipeline.
- **End-user experience SLO** — STT-to-TTS round-trip latency as
  observed by the caller. Harder to measure without an end-to-end
  synthetic probe; deferred with the integration-test work.
