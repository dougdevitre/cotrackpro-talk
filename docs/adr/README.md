# Architecture Decision Records

These documents capture the **why** behind the non-obvious decisions
in CoTrackPro Voice Center. Each ADR is short — a page at most —
and frozen once accepted. When a decision is superseded, write a
new ADR that points back to the old one and explains what changed.

## Format

Michael Nygard's lightweight template:

1. **Context** — what's the problem?
2. **Decision** — what did we pick?
3. **Consequences** — what trade-offs did we accept?
4. **Alternatives considered** — what did we explicitly reject and why?

## Index

| ID | Title | Status |
|---|---|---|
| [001](./adr-001-hybrid-vercel-ws-split.md) | Hybrid Vercel HTTP + long-running WebSocket split | Accepted |
| [002](./adr-002-in-memory-session-store.md) | In-memory session store on the audio hot path | Accepted |
| [003](./adr-003-client-side-idempotency.md) | Client-side idempotency via `Idempotency-Key` header | Accepted |
| [004](./adr-004-kv-abstraction.md) | KV abstraction with in-memory default + Upstash REST | Accepted |
| [005](./adr-005-fixed-window-rate-limit.md) | Fixed-window rate limiter over sliding-window | Accepted |
| [006](./adr-006-single-tenancy-boundary.md) | Single-tenancy boundary and multi-tenant migration path | Accepted |
| [007](./adr-007-single-region-for-now.md) | Single-region deployment and multi-region tradeoffs | Accepted |
| [008](./adr-008-circuit-breakers-deferred.md) | Circuit breakers on external services — deferred | Accepted |
| [009](./adr-009-secret-rotation.md) | Secret rotation story and the multi-key gap | Accepted |
