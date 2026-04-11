# CoTrackPro Voice Center

AI-powered contact center that lets callers speak naturally with CoTrackPro personas over the phone. Integrates Twilio Voice (telephony), ElevenLabs (text-to-speech + speech-to-text), Anthropic Claude (conversation intelligence), and the CoTrackPro MCP server (documentation tools).

## Architecture

```
┌──────────┐     ┌─────────────────────────────────────────────────────────┐
│          │     │              CoTrackPro Voice Center                    │
│  Caller  │────▶│                                                         │
│  (PSTN)  │◀────│  Twilio ──WebSocket──▶ Call Handler                     │
│          │     │                           │                             │
└──────────┘     │                    ┌──────┴──────┐                      │
                 │                    ▼             ▼                      │
                 │              STT Stream    Claude Stream                │
                 │            (ElevenLabs     (Anthropic)                  │
                 │             Scribe)            │                        │
                 │                    │      ┌────┴─────┐                  │
                 │                    │      ▼          ▼                  │
                 │                    │  Text Deltas  MCP Tool Calls       │
                 │                    │      │       (CoTrackPro)          │
                 │                    │      ▼                             │
                 │                    │  TTS Stream                        │
                 │                    │  (ElevenLabs, ulaw_8000)           │
                 │                    │      │                             │
                 │                    │      ▼                             │
                 │                    └──▶ Twilio (audio playback)         │
                 └─────────────────────────────────────────────────────────┘
```

### Data Flow (per utterance)

1. **Caller speaks** → Twilio streams mulaw 8kHz audio over WebSocket
2. **STT** → ElevenLabs Scribe transcribes audio in real-time (VAD auto-commit)
3. **Claude** → Transcribed text sent to Anthropic (streaming); CoTrackPro system prompt + MCP tools
4. **TTS** → Claude's text deltas piped sentence-by-sentence to ElevenLabs TTS WebSocket
5. **Playback** → ElevenLabs returns ulaw_8000 audio → sent directly to Twilio (zero transcoding)
6. **Barge-in** → If caller speaks during assistant playback, Twilio buffer is cleared and new utterance is processed

## File Tree

```
cotrackpro-voice-center/
├── package.json
├── tsconfig.json
├── vercel.json                     # Vercel runtime + rewrites (hybrid deploy)
├── .env.example
├── .gitignore
├── README.md
├── api/                            # Vercel serverless HTTP tier
│   ├── health.ts
│   ├── dashboard.ts                # GET /dashboard (vanilla HTML UI)
│   ├── call/
│   │   ├── incoming.ts             # POST /call/incoming  (TwiML)
│   │   ├── status.ts               # POST /call/status    (callback)
│   │   └── outbound.ts             # POST /call/outbound  (initiate call)
│   ├── cron/
│   │   └── cost-rollup.ts          # Vercel Cron target (daily 06:00 UTC)
│   └── records/
│       ├── index.ts                # GET  /records
│       ├── [callSid].ts            # GET / DELETE /records/:callSid
│       ├── by-role/[role].ts
│       └── by-status/[status].ts
├── docs/
│   └── CODE_REVIEW-vercel-hosting-optimization.md
├── tests/                          # node:test unit suite (169 tests)
│   ├── helpers/setupEnv.ts
│   ├── auth.test.ts
│   ├── costRollup.test.ts
│   ├── enumValidation.test.ts
│   ├── httpAdapter.test.ts
│   ├── kv.test.ts
│   ├── outbound.test.ts
│   ├── phoneValidation.test.ts
│   ├── rateLimit.test.ts
│   ├── records.test.ts
│   ├── sessions.test.ts
│   └── twiml.test.ts
└── src/
    ├── index.ts                    # Fastify server (long-running WS host)
    ├── config/
    │   ├── env.ts                  # Validated env config (fail-fast)
    │   └── voices.ts               # Role → ElevenLabs voice ID mapping
    ├── core/                       # Framework-agnostic handler logic
    │   ├── auth.ts                 # Timing-safe Bearer token matcher
    │   ├── costRollup.ts           # Daily cost aggregation
    │   ├── enumValidation.ts       # Role / status enum guards
    │   ├── httpAdapter.ts          # Node HTTP helpers for Vercel
    │   ├── outbound.ts             # Outbound call initiation
    │   ├── phoneValidation.ts     # E.164 + country allow-list
    │   ├── rateLimit.ts            # Fixed-window rate limiter
    │   ├── records.ts              # DynamoDB record CRUD
    │   └── twiml.ts                # TwiML + Twilio signature validation
    ├── types/
    │   └── index.ts                # Shared TypeScript types
    ├── utils/
    │   ├── logger.ts               # Pino structured logging
    │   └── sessions.ts             # In-memory call session store
    ├── handlers/                   # Fastify adapters around src/core/*
    │   ├── twiml.ts                # POST /call/incoming
    │   ├── outbound.ts             # POST /call/outbound
    │   ├── records.ts              # /records REST API
    │   └── callHandler.ts          # WebSocket handler — full pipeline
    └── services/
        ├── anthropic.ts            # Claude streaming + CoTrackPro tools
        ├── dynamo.ts               # DynamoDB call records
        ├── elevenlabs.ts           # TTS WebSocket (ulaw_8000)
        ├── kv.ts                   # KV abstraction (memory + Upstash)
        ├── mcp.ts                  # CoTrackPro MCP tool client
        └── stt.ts                  # STT WebSocket (Scribe realtime)
```

## Setup

### Prerequisites

- Node.js ≥ 20
- Twilio account with a voice-enabled phone number
- ElevenLabs account with API key and voice IDs configured
- Anthropic API key
- CoTrackPro MCP server running (or mock endpoint)
- ngrok (for local development)

### 1. Clone and install

```bash
git clone https://github.com/dougdevitre/cotrackpro-voice-center.git
cd cotrackpro-voice-center
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your API keys and voice IDs
```

### 3. Configure your ElevenLabs voices

Update `src/config/voices.ts` with your actual ElevenLabs voice IDs, or set the `VOICE_MAP` env var:

```bash
VOICE_MAP='{"parent":"your_voice_id","attorney":"another_voice_id"}'
```

To list your available voices:
```bash
curl -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/voices
```

### 4. Start the server (development)

```bash
# Terminal 1: start ngrok
ngrok http 8080

# Terminal 2: update .env with ngrok domain, then start
#   SERVER_DOMAIN=abc123.ngrok-free.app
npm run dev
```

### 5. Configure Twilio

In the Twilio Console:
1. Go to **Phone Numbers** → select your number
2. Under **Voice Configuration**:
   - **A Call Comes In**: Webhook
   - **URL**: `https://your-domain.ngrok-free.app/call/incoming`
   - **HTTP Method**: POST
3. Optionally set **Status Callback URL**: `https://your-domain.ngrok-free.app/call/status`

### 6. Test

Call your Twilio number. You should hear the CoTrackPro greeting in the assigned ElevenLabs voice.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/call/incoming` | Twilio webhook — returns TwiML to start media stream |
| WS | `/call/stream` | Bidirectional media stream (Twilio ↔ server) |
| POST | `/call/outbound` | Initiate outbound call: `{ "to": "+15551234567", "role": "attorney" }`. E.164 format + country allow-list enforced. Send `Idempotency-Key: <uuid>` to make retries safe — the same key replays the cached response for 24 hours. |
| POST | `/call/status` | Call status callbacks from Twilio |
| GET | `/records` | List recent call records (paginated, Bearer-auth) |
| GET | `/records/:callSid` | Get a single call record |
| GET | `/records/by-role/:role` | List calls for a persona |
| GET | `/records/by-status/:status` | List calls by status |
| DELETE | `/records/:callSid` | Delete a call record |
| GET | `/health` | Health check — returns tier + uptime |
| GET | `/dashboard` | Minimal read-only admin UI (vanilla HTML/JS, Bearer-auth client-side) |
| GET | `/api/cron/cost-rollup` | Daily cost rollup (Vercel Cron target; `CRON_SECRET` Bearer-auth) |

### Role selection

Pass `?role=attorney` (or any CoTrackPro role) as a query parameter on the incoming webhook URL to select the voice persona. Supported roles: `parent`, `attorney`, `gal`, `judge`, `therapist`, `school_counselor`, `law_enforcement`, `mediator`, `advocate`, `kid_teen`, `social_worker`, `cps`, `evaluator`.

## Production Deployment

### Security checklist

- [ ] Validate `X-Twilio-Signature` header on all Twilio webhooks (set `VALIDATE_TWILIO_SIGNATURE=true`)
- [ ] Store all secrets in AWS SSM Parameter Store (SecureString) or Vercel env vars
- [ ] Enable HTTPS/TLS (required for Twilio WebSocket connections)
- [ ] Set `NODE_ENV=production` (disables pretty logging)
- [x] **Rate limiting on `/call/outbound`** — sliding-window per API key, defaults 30/min and 500/hr. Override via `OUTBOUND_RATE_LIMIT_PER_MIN` / `OUTBOUND_RATE_LIMIT_PER_HOUR`. Shared across the Vercel + WS tiers when Upstash Redis / Vercel KV is configured via `KV_URL` / `KV_TOKEN`.
- [x] **Authentication on `/call/outbound`** (and `/records`) — Bearer token via `OUTBOUND_API_KEY`, compared with `crypto.timingSafeEqual` to avoid side-channel leaks.
- [x] **Phone-number validation on `/call/outbound`** — strict E.164 + country allow-list via `OUTBOUND_ALLOWED_COUNTRY_CODES` (default `"US,CA"`, `"*"` to disable). Closes the premium-rate international dial fraud surface if a Bearer token leaks.
- [ ] Review CoTrackPro MCP server auth (OAuth 2.0 recommended)
- [ ] Enable ElevenLabs zero-retention mode for HIPAA if applicable
- [ ] Set `CRON_SECRET` on Vercel (required to gate `/api/cron/cost-rollup`)

### Deployment options

This repo supports two deployment shapes. Pick based on ops preference — both use the same core handler code in `src/core/`.

#### Option A: Single host (simple)

One long-running container serves both HTTP and WebSocket on `SERVER_DOMAIN`.

```
ECS Fargate / Fly / Render / Railway
  └── ALB (HTTPS, wss://)
        ├── /call/incoming  → Fastify HTTP
        ├── /call/stream    → Fastify WebSocket
        └── /health         → Fastify HTTP
```

Env: set `SERVER_DOMAIN=voice.example.com`. Done. Point Twilio at `https://voice.example.com/call/incoming`.

- ECS Fargate: ≥ 1 vCPU / 2 GB RAM per instance (see Fargate rightsizing below for more aggressive options)
- ALB WebSocket idle timeout ≥ 3600s (max call duration)
- Sticky sessions NOT required (each WS is self-contained)
- For multi-instance: use Redis for session store (swap `sessions.ts`)

#### Option B: Hybrid (Vercel HTTP + long-running WS host)

HTTP tier on Vercel (stateless serverless, scales to zero, global edge), WebSocket tier on a long-running host (Fargate/Fly/Render). Twilio hits Vercel for webhooks; the TwiML response points `<Stream url>` at the WS host.

```
                  Vercel                            Long-running host
                  (HTTP tier)                       (WebSocket tier)
┌──────────────────────────────────┐        ┌───────────────────────────────┐
│ POST /call/incoming  (TwiML)     │        │ WS /call/stream               │
│ POST /call/status                │        │   Twilio Media Stream ↔       │
│ POST /call/outbound              │        │   Claude ↔ ElevenLabs ↔ MCP   │
│ GET  /records/*                  │        │ GET /health                   │
│ GET  /health                     │        │                               │
└──────────────────────────────────┘        └───────────────────────────────┘
          ▲                                             ▲
          │ HTTPS webhooks                              │ wss:// media stream
          │                                             │
          └─────────────────── Twilio ──────────────────┘
```

**Why hybrid?** Vercel can't host Twilio Media Streams (long-lived bidirectional WebSockets don't fit the serverless model), but it's the best host for the stateless HTTP surface: scale-to-zero, preview deployments per PR, global edge, zero cert management. The long-running host only has to serve the WebSocket, which makes it much easier to right-size.

**Setup:**

1. **Deploy the WebSocket host** (Fargate/Fly/Render/Railway). Run `npm run build && npm start`. Set env:
   ```
   SERVER_DOMAIN=ws.example.com     # or set WS_DOMAIN directly
   # …all other env vars (TWILIO_*, ELEVENLABS_*, ANTHROPIC_*, etc.)
   ```
   The Fastify server exposes `wss://ws.example.com/call/stream` and `https://ws.example.com/health`.

2. **Deploy the Vercel project** from the same repo. The `api/` directory and `vercel.json` at the root are detected automatically. Set env on the Vercel project:
   ```
   API_DOMAIN=api.example.com       # your Vercel custom domain
   WS_DOMAIN=ws.example.com         # long-running host from step 1
   TWILIO_ACCOUNT_SID=…
   TWILIO_AUTH_TOKEN=…
   TWILIO_PHONE_NUMBER=…
   VALIDATE_TWILIO_SIGNATURE=true
   OUTBOUND_API_KEY=…               # required to call /call/outbound and /records
   # DynamoDB (if used for /records)
   DYNAMO_ENABLED=true
   DYNAMO_TABLE_NAME=cotrackpro-calls
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=…
   AWS_SECRET_ACCESS_KEY=…
   # Note: ELEVENLABS_API_KEY / ANTHROPIC_API_KEY / COTRACKPRO_MCP_URL are
   # NOT needed on the Vercel tier — they're only used by the WS host.
   ```
   Vercel builds `api/**/*.ts` on each push using the Node 20 runtime (pinned in `vercel.json`).

3. **Point Twilio webhooks at the Vercel domain:**
   - A Call Comes In: `https://api.example.com/call/incoming`
   - Status Callback: `https://api.example.com/call/status`

   Do NOT point Twilio at the WS host for webhooks — use it only for the Media Stream, which the TwiML returned by Vercel automatically directs to `wss://ws.example.com/call/stream`.

**What you gain:**

| Area | Improvement |
|---|---|
| HTTP tier cost | Scales to zero — you only pay for actual webhook invocations |
| Webhook latency | Vercel's global edge serves TwiML from the region closest to Twilio |
| TLS / cert management | Vercel handles HTTPS + cert rotation automatically |
| Preview environments | Every branch/PR gets a URL you can point a Twilio subaccount at |
| Secret management | Per-environment env vars (dev / preview / prod) on Vercel |
| WS host sizing | Only the WS workload matters — right-size without worrying about HTTP RPS |

**What doesn't change:**

- Anthropic prompt caching (unchanged)
- Pre-recorded audio cache (unchanged)
- DynamoDB call records (read from either tier; writes come from the WS host)
- Per-call dollar cost (Anthropic/ElevenLabs/Twilio still dominate — hosting is rounding error)

**Local development:** set `SERVER_DOMAIN=<ngrok-domain>` in `.env` and run `npm run dev`. This runs the full Fastify server (HTTP + WS) on one host — single-host mode. You don't need Vercel locally; `src/handlers/*` and `api/*` share the same `src/core/*` logic, so whatever works in dev will work on Vercel.

### Latency optimization

- ElevenLabs Flash v2.5 delivers ~75ms TTFB
- `chunk_length_schedule: [50]` starts TTS generation after 50 chars
- Sentence-boundary splitting keeps voice natural without waiting for full response
- Barge-in detection clears Twilio buffer immediately
- ulaw_8000 output from ElevenLabs = zero transcoding overhead

## Cost Optimization

This service is tuned for cost efficiency. All optimizations are measurable via the per-call cost summary log line `cost.call.summary`.

### Anthropic prompt caching

The system prompt, tools, and conversation history each have a `cache_control: { type: "ephemeral" }` breakpoint. After the first turn of a call, subsequent turns read from the cache at ~10% of normal input token cost. The first-turn creation cost is ~25% above normal but pays back after 2 turns.

Verify cache hits by checking logs for `cacheReadTokens > 0` in the `Claude usage` log line emitted by `streamResponse` and `sendToolResult`.

### Pre-recorded audio cache

Fixed phrases (role greetings, tool hold, error messages) are pre-generated once and stored as ulaw_8000 base64 chunks in `src/audio/prerecorded.ts`. Playback is instant (no TTS handshake + TTFB) and costs zero per call.

**Generate the audio cache** (run once; re-run when voice IDs or phrase text changes):

```bash
ELEVENLABS_API_KEY=... npm run generate-audio
```

This calls ElevenLabs REST TTS for every `(phrase, voiceId)` combination and writes the result to `src/audio/prerecorded.ts`. If the file is empty or missing an entry, the call handler falls back to live TTS automatically — so the app always works, but greetings will be slower and paid for until you run the script.

### DynamoDB TTL

Call records auto-delete after `RECORDS_TTL_DAYS` (default `365`) via DynamoDB TTL. Enable it on your table once:

```bash
aws dynamodb update-time-to-live \
  --table-name cotrackpro-calls \
  --time-to-live-specification "Enabled=true, AttributeName=ttl"
```

The `ttl` field is set automatically by `createCallRecord()` on each new call. Change retention via the `RECORDS_TTL_DAYS` env var (accepts fractional days for testing).

### Cost observability

Each completed call emits a structured log entry with raw metrics and an estimated USD cost:

```json
{
  "msg": "cost.call.summary",
  "callSid": "CAxxx...",
  "durationSecs": 180,
  "turnCount": 12,
  "claudeInputTokens": 1250,
  "claudeOutputTokens": 850,
  "claudeCacheCreationTokens": 1875,
  "claudeCacheReadTokens": 18500,
  "ttsChars": 2200,
  "ttsCharsCached": 195,
  "sttSecs": 142.4,
  "estimatedCostUsd": 0.0342
}
```

Also persisted to the DynamoDB call record as `costSummary`. Create a CloudWatch log metric filter on `cost.call.summary` to plot cost per call over time.

**Daily rollup via Vercel Cron** — `api/cron/cost-rollup.ts` runs at 06:00 UTC daily (scheduled in `vercel.json`), aggregates yesterday's `costSummary` fields into a single `cost.rollup.daily` log line with per-role breakdown, and returns the same totals as JSON if you curl it manually. The endpoint is Bearer-authed via `CRON_SECRET` — Vercel Cron sets this header automatically. Without `CRON_SECRET`, auth is skipped (local-dev escape hatch) and a warning is logged; production must set it.

**Pricing is env-overridable** so you can update as provider pricing changes without redeploying:

| Env var | Default (USD) |
|---|---|
| `CLAUDE_INPUT_PRICE_PER_MTOK` | `3.00` |
| `CLAUDE_OUTPUT_PRICE_PER_MTOK` | `15.00` |
| `CLAUDE_CACHE_WRITE_PRICE_PER_MTOK` | `3.75` |
| `CLAUDE_CACHE_READ_PRICE_PER_MTOK` | `0.30` |
| `ELEVENLABS_TTS_PRICE_PER_1K_CHARS` | `0.10` |
| `ELEVENLABS_STT_PRICE_PER_MIN` | `0.008` |

### Rate limiting on `/call/outbound`

A fixed-window rate limiter (per-minute + per-hour buckets) protects against runaway outbound-call bills if the Bearer token is ever leaked. Limits default to **30/min** and **500/hr** per API key; override via `OUTBOUND_RATE_LIMIT_PER_MIN` / `OUTBOUND_RATE_LIMIT_PER_HOUR`.

The counter lives in the KV store abstraction (`src/services/kv.ts`). In single-host deployments the default in-memory backend is fine. In hybrid deployments set `KV_URL` + `KV_TOKEN` to an Upstash Redis REST endpoint (or Vercel KV, which is API-compatible) so the counter is shared across Vercel serverless functions and the WS host. When the KV is unreachable the limiter **fails open** — a rate-limiter outage shouldn't take down the product.

Rate-limited requests return **429 Too Many Requests** with a `Retry-After` header and a JSON body including `retryAfterSeconds`.

Along with rate limiting, `/call/outbound` now **validates the `to` number** against a strict E.164 regex and a country allow-list (`OUTBOUND_ALLOWED_COUNTRY_CODES`, default `"US,CA"`). This closes the premium-rate international dial fraud surface — even if an attacker drains the full per-hour budget, they can only dial numbers in your allow-list.

### Idempotent `/call/outbound` retries

Clients that retry a POST `/call/outbound` after a network blip would previously dial the call twice. To make retries safe, send an **`Idempotency-Key`** header with a stable unique ID (UUID recommended). The first request runs the work and caches the response under that key for 24 hours; every subsequent request with the same key replays the cached response with `X-Idempotent-Replay: true` and never touches Twilio.

```bash
curl -X POST https://api.example.com/call/outbound \
  -H "Authorization: Bearer $OUTBOUND_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"to":"+15551234567","role":"attorney"}'
```

Keys must be 1-256 printable ASCII characters. Malformed keys return 400. Deterministic 400 responses (e.g. bad phone number) are cached too, so retries of a broken request don't burn rate-limit budget. Transient 500s are **not** cached — retries need to be able to get past a transient Twilio failure.

The cache uses the same KV abstraction as rate limiting, so Upstash Redis / Vercel KV gives you shared replay across the Vercel and WS tiers.

### Admin dashboard

A minimal read-only admin UI lives at `/dashboard` (served by `api/dashboard.ts`). Vanilla HTML/JS, zero new dependencies, no framework. Paste your `OUTBOUND_API_KEY` into the key field and it stores it in `localStorage`, then fetches `/records` + `/health` and renders a filterable table of recent calls with per-call cost. Filter by role or status using the dropdowns.

This is deliberately a thin client — there's no server-side session. The real auth gate is the `/records` endpoint, which checks the Bearer token in constant time. The dashboard shell is served to anyone but shows no data without a valid key.

For a richer dashboard (authored sign-in, charts, multi-tenant), replace `api/dashboard.ts` with a Next.js app in the same Vercel project.

### Fargate rightsizing

The per-session memory footprint is ~15-20 KB (essentially nothing). The current recommendation of 1 vCPU / 2 GB is conservative. For I/O-bound WebSocket workloads you can usually right-size to:

- **0.5 vCPU / 1 GB** — ~50% cost reduction at moderate concurrency (~25-50 concurrent calls)
- **0.25 vCPU / 0.5 GB** — ~75% cost reduction at low concurrency (~10-25 concurrent calls)

Load-test before committing: run 50 synthetic concurrent calls and confirm CPU < 60% and memory < 50%. Roll back via task definition revision if CPU saturates.

## License

Proprietary — CoTrackPro © 2025
