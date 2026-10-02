// Pure helpers shared by the server tests and the browser (served as an ES module).
// Everything here closes over nothing and touches no DOM.

export const WINDOWS = [
  { key: 'unified5h', label: 'Session', hint: '5-hour window' },
  { key: 'unified7d', label: 'Weekly', hint: '7-day window, all models' },
  { key: 'unified7dFable', label: 'Fable', hint: '7-day window, Fable only' },
  { key: 'unified7dSonnet', label: 'Sonnet', hint: '7-day window, Sonnet only' },
];

const BLOCKED_TEXT = {
  throttled: 'Rate limited by the provider',
  exhausted: 'Marked exhausted',
  error: 'Account error',
  'upstream-rejected': 'Provider reports the quota is spent',
  quota: 'At the switch threshold',
  capped: 'Usage cap reached',
  'spend-capped': 'Spend cap reached',
  'advisor-capped': 'Advisor usage cap reached',
  entitlement: 'Provider refused this account for the organization',
  routing: 'Routing proxy unreachable',
  credential: 'Provider rejected the credentials',
  route: 'No route allows this account',
  'advisor-quota': 'Advisor weekly bucket spent',
};

/** Quota windows an account actually reports, oldest-known first. */
export function meters(account) {
  const q = account?.quota || {};
  const rows = [];
  for (const w of WINDOWS) {
    if (q[w.key] == null) continue;
    rows.push({ key: w.key, label: w.label, hint: w.hint, utilization: q[w.key], resetAt: q[`${w.key}Reset`] ?? null, seenAt: q[`${w.key}SeenAt`] ?? null });
  }
  for (const [family, b] of Object.entries(q.scopedWeekly || {})) {
    if (!b || b.utilization == null || rows.some(r => r.key.toLowerCase().endsWith(family))) continue;
    rows.push({ key: `scoped:${family}`, label: family[0].toUpperCase() + family.slice(1), hint: `7-day window, ${family} only`, utilization: b.utilization, resetAt: b.resetAt ?? null, seenAt: null });
  }
  return rows;
}

/** 'ok' | 'warning' | 'critical' for a utilization ratio against the switch threshold. */
export function severity(utilization, threshold = 0.98) {
  if (utilization == null) return 'ok';
  if (utilization >= Math.min(threshold, 0.9)) return 'critical';
  if (utilization >= 0.7) return 'warning';
  return 'ok';
}

/** Earliest future reset among the account's windows, or null. */
export function nextReset(account, now = Date.now()) {
  const future = meters(account).map(m => m.resetAt).filter(t => t && t > now);
  return future.length ? Math.min(...future) : null;
}

export function formatDuration(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

const future = (ts, now) => (ts && new Date(ts).getTime() > now ? new Date(ts).getTime() : null);

/**
 * Why an account needs a human, most severe first. Empty when it is fine.
 * `account.auth` is the dashboard's own enrichment from the config file.
 * @returns {{ level: 'critical'|'warning', text: string, action: 'signin'|null }[]}
 */
export function attention(account, { now = Date.now(), threshold = 0.98 } = {}) {
  const out = [];
  if (!account || account.disabled) return out;
  const auth = account.auth || {};

  if (account.status === 'error' || account.unavailable === 'error') {
    out.push({ level: 'critical', text: 'Account error: the proxy cannot use this account. Signing in again usually fixes it.', action: 'signin' });
  }
  const cred = future(account.credentialRejectedUntil, now);
  if (cred || account.unavailable === 'credential') {
    out.push({ level: 'critical', text: `Provider rejected the credentials${cred ? `, retrying in ${formatDuration(cred - now)}` : ''}. Sign in again to replace them.`, action: 'signin' });
  }
  if (auth.expiresAt && auth.expiresAt < now && !auth.hasRefreshToken) {
    out.push({ level: 'critical', text: 'Sign-in expired and there is no refresh token. Sign in again.', action: 'signin' });
  }

  const blocked = account.unavailable;
  if (blocked && !['error', 'credential', 'disabled'].includes(blocked)) {
    const reset = nextReset(account, now);
    const until = blocked === 'throttled' ? future(account.rateLimitedUntil, now)
      : blocked === 'entitlement' ? future(account.entitlementDeniedUntil, now)
        : blocked === 'routing' ? future(account.routingFailedUntil, now)
          : reset;
    out.push({ level: 'warning', text: `${BLOCKED_TEXT[blocked] || blocked}${until ? `, back in ${formatDuration(until - now)}` : ''}.`, action: null });
  } else if (!out.length) {
    for (const m of meters(account)) {
      if (severity(m.utilization, threshold) !== 'critical') continue;
      const reset = future(m.resetAt, now);
      out.push({ level: 'warning', text: `${m.label} window at ${Math.round(m.utilization * 100)}%${reset ? `, resets in ${formatDuration(reset - now)}` : ''}.`, action: null });
    }
  }
  return out;
}

/** Accounts sorted: needs attention first (critical, then warning), then by name. */
export function sortForAttention(accounts, opts) {
  const rank = a => {
    const items = attention(a, opts);
    if (items.some(i => i.level === 'critical')) return 0;
    if (items.length) return 1;
    return 2;
  };
  return [...accounts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
