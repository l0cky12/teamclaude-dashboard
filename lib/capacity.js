import { meters } from './attention.js';

const DAY = 86400e3;
export const resetId = e => JSON.stringify([e.provider, e.name, e.key, e.resetAt]);

/** Keep the latest utilization observed BEFORE each reported reset. */
export function observeResets(history, accounts, now = Date.now()) {
  const changed = [];
  for (const a of accounts || []) {
    if (a.disabled) continue;
    for (const m of meters(a)) {
      if (!Number.isFinite(m.resetAt) || m.resetAt <= now) continue;
      const e = { name: a.name, provider: a.provider || 'anthropic', key: m.key, label: m.label, utilization: m.utilization, resetAt: m.resetAt, at: now };
      const id = resetId(e), prev = history.get(id);
      if (prev && prev.utilization === e.utilization && prev.label === e.label) continue;
      history.set(id, e);
      changed.push(e);
    }
  }
  return changed;
}

/** The same since/until/binMs windowing used by the cost report. */
export function resetWindow(range, events, now = Date.now()) {
  const upcoming = range === 'upcoming';
  const since = upcoming ? now : range === 'all'
    ? events.reduce((start, e) => e.resetAt <= now ? Math.min(start, e.resetAt) : start, now - DAY)
    : now - Number(range);
  const until = upcoming ? now + 7 * DAY : now;
  const span = until - since;
  const binMs = span <= DAY ? 4 * 3600e3 : Math.ceil(span / (7 * DAY)) * DAY;
  return { since, until, binMs };
}

export function resetRows(events, { since, until }) {
  const rows = new Map();
  for (const e of events) {
    if (e.resetAt < since || e.resetAt > until) continue;
    const id = JSON.stringify([e.provider, e.name]);
    if (!rows.has(id)) rows.set(id, { name: e.name, provider: e.provider, marks: [] });
    rows.get(id).marks.push(e);
  }
  return [...rows.values()].sort((a, b) => Math.min(...a.marks.map(m => m.resetAt)) - Math.min(...b.marks.map(m => m.resetAt)));
}
