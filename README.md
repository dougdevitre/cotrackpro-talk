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
├── .env.example
├── .gitignore
├── README.md
└── src/
    ├── index.ts                    # Fastify server entrypoint
    ├── config/
    │   ├── env.ts                  # Validated env config (fail-fast)
    │   └── voices.ts               # Role → ElevenLabs voice ID mapping
    ├── types/
    │   └── index.ts                # Shared TypeScript types
    ├── utils/
    │   ├── logger.ts               # Pino structured logging
    │   └── sessions.ts             # In-memory call session store
    ├── handlers/
    │   ├── twiml.ts                # POST /call/incoming — TwiML response
    │   ├── outbound.ts             # POST /call/outbound — dial out
    │   └── callHandler.ts          # WebSocket handler — full pipeline
    └── services/
        ├── anthropic.ts            # Claude streaming + CoTrackPro tools
        ├── elevenlabs.ts           # TTS WebSocket (ulaw_8000)
        ├── stt.ts                  # STT WebSocket (Scribe realtime)
        └── mcp.ts                  # CoTrackPro MCP tool client
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
| POST | `/call/outbound` | Initiate outbound call: `{ "to": "+15551234567", "role": "attorney" }` |
| POST | `/call/status` | Call status callbacks from Twilio |
| GET | `/health` | Health check — returns active call count and uptime |

### Role selection

Pass `?role=attorney` (or any CoTrackPro role) as a query parameter on the incoming webhook URL to select the voice persona. Supported roles: `parent`, `attorney`, `gal`, `judge`, `therapist`, `school_counselor`, `law_enforcement`, `mediator`, `advocate`, `kid_teen`, `social_worker`, `cps`, `evaluator`.

## Production Deployment

### Security checklist

- [ ] Validate `X-Twilio-Signature` header on all Twilio webhooks
- [ ] Store all secrets in AWS SSM Parameter Store (SecureString)
- [ ] Enable HTTPS/TLS (required for Twilio WebSocket connections)
- [ ] Set `NODE_ENV=production` (disables pretty logging)
- [ ] Add rate limiting to `/call/outbound`
- [ ] Add authentication to `/call/outbound` (API key or JWT)
- [ ] Review CoTrackPro MCP server auth (OAuth 2.0 recommended)
- [ ] Enable ElevenLabs zero-retention mode for HIPAA if applicable

### AWS deployment (recommended)

```
ECS Fargate / EC2
  └── ALB (HTTPS, wss://)
        ├── /call/incoming  → Target Group (HTTP)
        ├── /call/stream    → Target Group (WebSocket)
        └── /health         → Target Group (HTTP)
```

- Use ECS Fargate with at least 1 vCPU / 2GB RAM per instance
- ALB must have WebSocket idle timeout ≥ 3600s (max call duration)
- Sticky sessions NOT required (each WS is self-contained)
- For multi-instance: use Redis for session store (swap `sessions.ts`)

### Latency optimization

- ElevenLabs Flash v2.5 delivers ~75ms TTFB
- `chunk_length_schedule: [50]` starts TTS generation after 50 chars
- Sentence-boundary splitting keeps voice natural without waiting for full response
- Barge-in detection clears Twilio buffer immediately
- ulaw_8000 output from ElevenLabs = zero transcoding overhead

## License

Proprietary — CoTrackPro © 2025
