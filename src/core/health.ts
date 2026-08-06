/**
 * src/core/health.ts — the KV half of /health, shared by both tiers.
 *
 * Why this exists: the durable-KV work is only as good as an operator's
 * ability to confirm it landed, and until now nothing could. `/health`
 * on both tiers reported liveness and uptime; `npm run check:line`
 * reported the KV backend of *the machine running the script*, not the
 * deployed one. So the failure this whole subsystem guards against — a
 * deploy quietly running on in-memory KV — was invisible from outside.
 *
 * Two depths, because they answer different questions:
 *
 *   shallow — "what is this instance configured for?" Unauthenticated,
 *             always 200. An uptime monitor wants `durable` in its
 *             payload, but a config mistake is not a reason to page
 *             someone as though the host were down.
 *
 *   deep    — "does it actually work?" Authenticated, and 503 when the
 *             answer is no, so `curl -f` and a shell exit code are
 *             enough to gate a go-live script on it. Runs a real
 *             round-trip (probeKv), which writes — hence the bearer.
 *
 * Both tiers build their response from here so the two can't drift; the
 * Fly route layers its session counters on top.
 */

import { describeKvBackend, probeKv } from "../services/kv.js";
import type { KvBackendInfo, KvProbeResult } from "../services/kv.js";

/** The `kv` block of a shallow /health response. Never contains a URL. */
export interface ShallowKvHealth {
  backend: KvBackendInfo["backend"];
  reason: KvBackendInfo["reason"];
  durable: boolean;
}

/** The `kv` block of a deep /health response. */
export interface DeepKvHealth extends ShallowKvHealth {
  /** Operator-facing detail — a redacted URL or table name. */
  detail: string;
  probe:
    | { ok: true; roundTripMs: number }
    | { ok: false; error: string };
}

export interface KvHealthResult {
  kv: ShallowKvHealth | DeepKvHealth;
  /**
   * What the HTTP layer should return. Shallow is always 200 — see the
   * header comment. Deep is 503 when the backend isn't durable or the
   * round-trip failed, because a script's whole verification step
   * should be able to be `curl -f`.
   */
  status: 200 | 503;
}

/** Narrow a probe result to the shape the wire format uses. */
function wireProbe(probe: KvProbeResult): DeepKvHealth["probe"] {
  return probe.ok
    ? { ok: true, roundTripMs: probe.roundTripMs }
    : { ok: false, error: probe.error };
}

/**
 * Build the `kv` block and the status code that goes with it.
 *
 * @param deep  Run a live round-trip and include `detail`. Callers MUST
 *              authorize before passing true: this writes a canary key,
 *              and `detail` carries the backend's host.
 */
export async function kvHealth(deep: boolean): Promise<KvHealthResult> {
  const info = describeKvBackend();
  const shallow: ShallowKvHealth = {
    backend: info.backend,
    reason: info.reason,
    durable: info.durable,
  };

  if (!deep) return { kv: shallow, status: 200 };

  // Don't probe a backend we already know is in-process: MemoryKv would
  // round-trip perfectly and report a healthy 0ms probe, which is a
  // worse answer than none. The 503 comes from `durable`, not the probe.
  if (!info.durable) {
    return {
      kv: {
        ...shallow,
        detail: info.detail,
        probe: {
          ok: false,
          error: "not probed — backend is not durable",
        },
      },
      status: 503,
    };
  }

  const probe = await probeKv();
  return {
    kv: { ...shallow, detail: info.detail, probe: wireProbe(probe) },
    status: probe.ok ? 200 : 503,
  };
}

/**
 * Whether a request asked for the deep check.
 *
 * Accepts `?deep=1` and bare `?deep`, and rejects `?deep=0`/`?deep=false`
 * so a script can pass a variable through without the empty-ish values
 * silently meaning "yes".
 *
 * @param url  The raw request URL (path + query), as Node gives it.
 */
export function wantsDeep(url: string | undefined): boolean {
  if (!url) return false;
  const q = url.indexOf("?");
  if (q === -1) return false;
  const params = new URLSearchParams(url.slice(q + 1));
  if (!params.has("deep")) return false;
  const v = (params.get("deep") ?? "").toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}
