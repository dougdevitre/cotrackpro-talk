/**
 * api/dashboard.ts — Vercel serverless function that serves the
 * admin dashboard HTML.
 *
 * Intentionally minimal: one HTML document with inline CSS + vanilla
 * JS that fetches the existing /records + /health endpoints and
 * renders a table. No React, no bundler, no build step.
 *
 * Auth model: the dashboard does NOT have server-side auth of its
 * own. The HTML is served to anyone who asks. The client-side code
 * asks the user for an API key, stores it in localStorage, and sends
 * it as `Authorization: Bearer <key>` on every /records call. The
 * real auth gate is the /records endpoint itself, which already
 * checks Bearer tokens in timing-safe fashion.
 *
 * This means an unauthenticated visitor sees the dashboard shell but
 * no data. That's an acceptable information-disclosure model for an
 * internal tool — the shell reveals nothing sensitive (not even
 * endpoint URLs that weren't already visible in TwiML/Twilio). If
 * you want server-side gating in the future, add a basic-auth
 * middleware or move the dashboard behind Vercel's protection.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { requireMethod } from "../src/core/httpAdapter.js";

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CoTrackPro Voice Center — Admin</title>
  <style>
    :root {
      --bg: #0f172a;
      --bg-2: #1e293b;
      --fg: #e2e8f0;
      --fg-dim: #94a3b8;
      --accent: #38bdf8;
      --good: #4ade80;
      --bad: #f87171;
      --warn: #fbbf24;
      --border: #334155;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      margin: 0;
      padding: 24px;
      line-height: 1.4;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      gap: 16px;
      flex-wrap: wrap;
    }
    h1 { font-size: 18px; margin: 0; letter-spacing: 0.02em; }
    .status-row {
      display: flex;
      gap: 12px;
      align-items: center;
      font-size: 13px;
      color: var(--fg-dim);
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
      background: var(--fg-dim);
    }
    .dot.ok  { background: var(--good); }
    .dot.bad { background: var(--bad); }
    .controls {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    input[type=password], input[type=text], select {
      background: var(--bg-2);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 13px;
      font-family: inherit;
    }
    button {
      background: var(--accent);
      color: var(--bg);
      border: 0;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    button.secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      background: var(--bg-2);
      border-radius: 6px;
      overflow: hidden;
    }
    th, td {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: var(--bg);
      color: var(--fg-dim);
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    tr:last-child td { border-bottom: 0; }
    tr:hover td { background: rgba(56, 189, 248, 0.05); }
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-badge.completed { background: rgba(74, 222, 128, 0.15); color: var(--good); }
    .status-badge.active    { background: rgba(56, 189, 248, 0.15); color: var(--accent); }
    .status-badge.failed,
    .status-badge.force-reaped { background: rgba(248, 113, 113, 0.15); color: var(--bad); }
    .empty, .error {
      background: var(--bg-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px;
      text-align: center;
      color: var(--fg-dim);
      font-size: 13px;
    }
    .error { color: var(--bad); border-color: var(--bad); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .cost { color: var(--warn); font-weight: 600; }
    footer {
      margin-top: 24px;
      font-size: 11px;
      color: var(--fg-dim);
      text-align: center;
    }
  </style>
</head>
<body>
  <header>
    <h1>CoTrackPro Voice Center — Admin</h1>
    <div class="status-row">
      <span id="health-status"><span class="dot"></span>health: —</span>
      <span id="last-refresh">—</span>
    </div>
  </header>

  <div class="controls">
    <input type="password" id="api-key" placeholder="OUTBOUND_API_KEY" autocomplete="off" />
    <select id="filter-role">
      <option value="">all roles</option>
      <option value="parent">parent</option>
      <option value="attorney">attorney</option>
      <option value="gal">gal</option>
      <option value="judge">judge</option>
      <option value="therapist">therapist</option>
      <option value="school_counselor">school_counselor</option>
      <option value="law_enforcement">law_enforcement</option>
      <option value="mediator">mediator</option>
      <option value="advocate">advocate</option>
      <option value="kid_teen">kid_teen</option>
      <option value="social_worker">social_worker</option>
      <option value="cps">cps</option>
      <option value="evaluator">evaluator</option>
    </select>
    <select id="filter-status">
      <option value="">all statuses</option>
      <option value="active">active</option>
      <option value="completed">completed</option>
      <option value="failed">failed</option>
      <option value="force-reaped">force-reaped</option>
    </select>
    <button id="refresh-btn">Refresh</button>
    <button id="clear-btn" class="secondary">Clear key</button>
  </div>

  <div id="table-container"></div>

  <footer>
    Reads /records + /health on this domain. Auth token is stored in localStorage under 'cotrackpro_api_key' and sent as Bearer on every request.
  </footer>

  <script>
    const KEY_STORAGE = 'cotrackpro_api_key';
    const apiKeyInput = document.getElementById('api-key');
    const filterRole  = document.getElementById('filter-role');
    const filterStatus = document.getElementById('filter-status');
    const refreshBtn  = document.getElementById('refresh-btn');
    const clearBtn    = document.getElementById('clear-btn');
    const container   = document.getElementById('table-container');
    const healthEl    = document.getElementById('health-status');
    const lastRefresh = document.getElementById('last-refresh');

    // Restore token from localStorage on load.
    apiKeyInput.value = localStorage.getItem(KEY_STORAGE) || '';
    apiKeyInput.addEventListener('input', () => {
      localStorage.setItem(KEY_STORAGE, apiKeyInput.value);
    });
    clearBtn.addEventListener('click', () => {
      apiKeyInput.value = '';
      localStorage.removeItem(KEY_STORAGE);
      container.innerHTML = '';
    });

    function authHeaders() {
      const v = apiKeyInput.value.trim();
      return v ? { 'Authorization': 'Bearer ' + v } : {};
    }

    async function fetchHealth() {
      try {
        const r = await fetch('/health');
        if (!r.ok) throw new Error(r.statusText);
        const j = await r.json();
        const ok = j && j.status === 'ok';
        healthEl.innerHTML =
          '<span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>' +
          'health: ' + (ok ? (j.tier || 'api') : 'down');
      } catch (e) {
        healthEl.innerHTML = '<span class="dot bad"></span>health: unreachable';
      }
    }

    async function fetchRecords() {
      const role = filterRole.value;
      const status = filterStatus.value;
      let path = '/records';
      if (role)   path = '/records/by-role/'   + encodeURIComponent(role);
      if (status) path = '/records/by-status/' + encodeURIComponent(status);
      const resp = await fetch(path + '?limit=100', { headers: authHeaders() });
      if (resp.status === 401) throw new Error('unauthorized — check your API key');
      if (resp.status === 400) {
        const j = await resp.json().catch(() => ({}));
        throw new Error('bad request: ' + (j.error || resp.statusText));
      }
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      return data.records || [];
    }

    function formatUsd(n) {
      if (typeof n !== 'number') return '—';
      if (n < 0.01) return '$' + n.toFixed(4);
      return '$' + n.toFixed(2);
    }

    function formatSecs(n) {
      if (typeof n !== 'number') return '—';
      const m = Math.floor(n / 60);
      const s = Math.round(n % 60);
      return m + ':' + String(s).padStart(2, '0');
    }

    function renderTable(records) {
      if (!records.length) {
        container.innerHTML = '<div class="empty">No records.</div>';
        return;
      }
      const rows = records.map(r => {
        const cost = r.costSummary && r.costSummary.estimatedCostUsd;
        return '<tr>' +
          '<td>' + escapeHtml(r.callSid) + '</td>' +
          '<td>' + escapeHtml(r.role || '—') + '</td>' +
          '<td>' + escapeHtml(r.direction || '—') + '</td>' +
          '<td><span class="status-badge ' + escapeHtml(r.status || '') + '">' + escapeHtml(r.status || '—') + '</span></td>' +
          '<td>' + escapeHtml(r.startedAt || '—') + '</td>' +
          '<td class="num">' + formatSecs(r.durationSecs) + '</td>' +
          '<td class="num">' + (r.turnCount || 0) + '</td>' +
          '<td class="num cost">' + formatUsd(cost) + '</td>' +
        '</tr>';
      }).join('');

      container.innerHTML =
        '<table>' +
          '<thead><tr>' +
            '<th>Call SID</th>' +
            '<th>Role</th>' +
            '<th>Direction</th>' +
            '<th>Status</th>' +
            '<th>Started</th>' +
            '<th class="num">Duration</th>' +
            '<th class="num">Turns</th>' +
            '<th class="num">Cost</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>';
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    async function refresh() {
      refreshBtn.disabled = true;
      try {
        const [records] = await Promise.all([fetchRecords(), fetchHealth()]);
        renderTable(records);
        lastRefresh.textContent = 'refreshed ' + new Date().toLocaleTimeString();
      } catch (e) {
        container.innerHTML = '<div class="error">' + escapeHtml(e.message) + '</div>';
      } finally {
        refreshBtn.disabled = false;
      }
    }

    refreshBtn.addEventListener('click', refresh);
    filterRole.addEventListener('change', refresh);
    filterStatus.addEventListener('change', refresh);

    // Initial load.
    fetchHealth();
    if (apiKeyInput.value) refresh();
  </script>
</body>
</html>`;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!requireMethod(req, res, "GET")) return;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Light cache so Vercel's edge serves a cached HTML doc; the
  // dynamic data is fetched client-side so this is safe.
  res.setHeader("Cache-Control", "public, max-age=60");
  res.end(HTML);
}
