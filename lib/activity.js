// Request log derived from proxy status snapshots. Team Claude exposes
// cumulative counters (per account, per client key) but no per-request event
// stream, so the dashboard polls and records what changed between two polls:
// one "tick" per interval with activity. Nothing about prompt content is kept.

export const accountTokens = u => (u?.totalInputTokens || 0) + (u?.totalOutputTokens || 0) + (u?.totalCacheReadTokens || 0) + (u?.totalCacheCreationTokens || 0);

/**
 * What changed from `prev` to `next`, or null when nothing did.
 * Counters that went down (proxy restart, state reset) count as no change.
 * @returns {{ at: number, accounts: Record<string,{requests:number,tokens:number}>, clients: Record<string,{requests:number,inputTokens:number,outputTokens:number}> } | null}
 */
export function tick(prev, next, at = Date.now()) {
  if (!prev || !next) return null;
  const up = (a, b) => Math.max(0, (b || 0) - (a || 0));
  const accounts = {};
  const prevAccounts = new Map((prev.accounts || []).map(a => [a.name, a.usage || {}]));
  for (const a of next.accounts || []) {
    const p = prevAccounts.get(a.name);
    if (!p) continue;
    const requests = up(p.totalRequests, a.usage?.totalRequests);
    const tokens = up(accountTokens(p), accountTokens(a.usage));
    if (requests || tokens) accounts[a.name] = { requests, tokens };
  }
  const clients = {};
  for (const [name, c] of Object.entries(next.clients || {})) {
    const p = (prev.clients || {})[name] || {};
    const requests = up(p.requests, c.requests);
    const inputTokens = up(p.inputTokens, c.inputTokens);
    const outputTokens = up(p.outputTokens, c.outputTokens);
    if (requests || inputTokens || outputTokens) clients[name] = { requests, inputTokens, outputTokens };
  }
  if (!Object.keys(accounts).length && !Object.keys(clients).length) return null;
  return { at, accounts, clients };
}

/** Sum a set of ticks by name for one side ('accounts' or 'clients'). */
export function totals(ticks, side = 'clients') {
  const out = {};
  for (const t of ticks) {
    for (const [name, d] of Object.entries(t[side] || {})) {
      const o = out[name] ||= { requests: 0, tokens: 0, lastAt: 0 };
      o.requests += d.requests || 0;
      o.tokens += side === 'clients' ? (d.inputTokens || 0) + (d.outputTokens || 0) : (d.tokens || 0);
      o.lastAt = Math.max(o.lastAt, t.at);
    }
  }
  return out;
}

/** Ticks newer than `since`, optionally only those naming `who` (a user or account). */
export function select(ticks, { since = 0, who = null } = {}) {
  return ticks.filter(t => t.at >= since && (!who || who in (t.clients || {}) || who in (t.accounts || {})));
}
