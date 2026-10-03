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

/** Whether a window of an account in rotation resets in (from, to]. */
export function resetsBetween(accounts, from, to) {
  return (accounts || []).some(a => !a.disabled && meters(a).some(m => m.resetAt > from && m.resetAt <= to));
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
 * @returns {{ level: 'critical'|'warning', kind: 'signin'|'blocked'|'near-limit', text: string, action: 'signin'|null }[]}
 */
export function attention(account, { now = Date.now(), threshold = 0.98 } = {}) {
  const out = [];
  if (!account || account.disabled) return out;
  const auth = account.auth || {};

  if (account.status === 'error' || account.unavailable === 'error') {
    out.push({ level: 'critical', kind: 'signin', text: 'Account error: the proxy cannot use this account. Signing in again usually fixes it.', action: 'signin' });
  }
  const cred = future(account.credentialRejectedUntil, now);
  if (cred || account.unavailable === 'credential') {
    out.push({ level: 'critical', kind: 'signin', text: `Provider rejected the credentials${cred ? `, retrying in ${formatDuration(cred - now)}` : ''}. Sign in again to replace them.`, action: 'signin' });
  }
  if (auth.expiresAt && auth.expiresAt < now && !auth.hasRefreshToken) {
    out.push({ level: 'critical', kind: 'signin', text: 'Sign-in expired and there is no refresh token. Sign in again.', action: 'signin' });
  }

  const blocked = account.unavailable;
  if (blocked && !['error', 'credential', 'disabled'].includes(blocked)) {
    const reset = nextReset(account, now);
    const until = blocked === 'throttled' ? future(account.rateLimitedUntil, now)
      : blocked === 'entitlement' ? future(account.entitlementDeniedUntil, now)
        : blocked === 'routing' ? future(account.routingFailedUntil, now)
          : reset;
    out.push({ level: 'warning', kind: 'blocked', text: `${BLOCKED_TEXT[blocked] || blocked}${until ? `, back in ${formatDuration(until - now)}` : ''}.`, action: null });
  } else if (!out.length) {
    for (const m of meters(account)) {
      if (severity(m.utilization, threshold) !== 'critical') continue;
      const reset = future(m.resetAt, now);
      out.push({ level: 'warning', kind: 'near-limit', text: `${m.label} window at ${Math.round(m.utilization * 100)}%${reset ? `, resets in ${formatDuration(reset - now)}` : ''}.`, action: null });
    }
  }
  return out;
}

/**
 * Accounts with a real problem (needs sign-in, or blocked), one entry each,
 * signin problems first. Near-limit windows don't count: the ledger shows those.
 */
export function issues(accounts, opts) {
  const out = [];
  for (const account of accounts || []) {
    const items = attention(account, opts).filter(i => i.kind !== 'near-limit');
    if (items.length) out.push({ account, items });
  }
  const rank = e => (e.items.some(i => i.kind === 'signin') ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.account.name.localeCompare(b.account.name));
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

/**
 * Subscription capacity left per quota window across a provider's active
 * accounts: `left` is in account-equivalents (2.5 = two and a half accounts'
 * worth of that window still unused), `count` how many accounts report it.
 */
export function remaining(accounts, provider = 'anthropic', now = Date.now()) {
  const out = new Map();
  for (const a of accounts || []) {
    if (a.disabled || (a.provider || 'anthropic') !== provider) continue;
    for (const m of meters(a)) {
      const w = out.get(m.label) || { key: m.key, label: m.label, hint: m.hint, left: 0, count: 0, nextResetAt: null, nextResetAccount: null, accounts: [] };
      const left = Math.max(0, 1 - m.utilization);
      w.left += left; w.count += 1;
      w.accounts.push({ name: a.name, left, resetAt: m.resetAt });
      // the reset that matters is the soonest one on an account that has used something
      if (m.resetAt > now && left < 1 && (!w.nextResetAt || m.resetAt < w.nextResetAt)) { w.nextResetAt = m.resetAt; w.nextResetAccount = a.name; }
      out.set(m.label, w);
    }
  }
  return [...out.values()];
}
