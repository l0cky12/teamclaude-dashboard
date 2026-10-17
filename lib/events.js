// Per-account event history. The proxy keeps no log of what happened to an
// account, only its current state, so the dashboard compares consecutive
// status snapshots and records each change it sees: who is serving, pauses,
// errors, blocks, tokens falling due, and quota windows resetting. Sign-ins
// finished from the dashboard are recorded by the server directly.
import { meters } from './attention.js';

const BLOCKED_TEXT = {
  throttled: 'rate limited by the provider',
  exhausted: 'marked exhausted',
  'upstream-rejected': 'provider reports the quota is spent',
  quota: 'at the switch threshold',
  capped: 'usage cap reached',
  'spend-capped': 'spend cap reached',
  'advisor-capped': 'advisor usage cap reached',
  entitlement: 'refused for the organization',
  routing: 'routing proxy unreachable',
  route: 'no route allows this account',
  'advisor-quota': 'advisor weekly bucket spent',
};

const providerOf = a => a.provider || 'anthropic';
// A Claude and a Codex account may share an email, so identity is provider + name.
const idOf = a => `${providerOf(a)}:${a.name}`;

/** The parts of an account's state worth a line in its history. */
export function stateOf(account, serving, now) {
  const auth = account.auth || {};
  const error = account.status === 'error' || account.unavailable === 'error' || account.unavailable === 'credential';
  const blocked = !error && account.unavailable && account.unavailable !== 'disabled' ? account.unavailable : null;
  return {
    serving: !!serving,
    paused: !!account.disabled,
    error,
    blocked,
    tokenDue: !!(auth.expiresAt && auth.expiresAt < now && auth.hasRefreshToken),
  };
}

/**
 * Events between two status snapshots, in account order. `prev` null yields
 * nothing: the first snapshot is a baseline, not a change. `at` and `prevAt`
 * are when each snapshot was received; a window whose reset time falls
 * between them is logged as a reset.
 * @returns {{ at: number, account: string, provider: string, kind: string, text: string }[]}
 */
export function diffEvents(prev, next, at = Date.now(), prevAt = at) {
  if (!prev || !next) return [];
  const out = [];
  const servingIn = s => (snap => a => snap[providerOf(a)] === a.name)(s.currentAccounts || {});
  const servingBefore = servingIn(prev), servingNow = servingIn(next);
  const before = new Map((prev.accounts || []).map(a => [idOf(a), a]));
  for (const a of next.accounts || []) {
    const p = before.get(idOf(a));
    if (!p) continue; // new accounts arrive through a sign-in, which is logged separately
    const provider = providerOf(a);
    const add = (kind, text) => out.push({ at, account: a.name, provider, kind, text });
    const was = stateOf(p, servingBefore(p), prevAt);
    const is = stateOf(a, servingNow(a), at);
    if (is.serving !== was.serving) add('serving', is.serving ? 'Started serving requests' : 'Stopped serving requests');
    if (is.paused !== was.paused) add('paused', is.paused ? 'Paused' : 'Resumed');
    if (is.error !== was.error) add('error', is.error ? `Error: ${a.unavailable === 'credential' ? 'provider rejected the credentials' : 'the proxy cannot use this account'}` : 'Error cleared');
    if (is.blocked !== was.blocked) add('blocked', is.blocked ? `Blocked: ${BLOCKED_TEXT[is.blocked] || is.blocked}` : `No longer blocked (was ${BLOCKED_TEXT[was.blocked] || was.blocked})`);
    if (is.tokenDue && !was.tokenDue) add('token', 'Access token expired, refresh due');
    for (const m of meters(p)) {
      if (m.resetAt > prevAt && m.resetAt <= at) add('reset', `${m.label} window reset`);
    }
  }
  return out;
}
