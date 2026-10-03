import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeResets, resetId, resetWindow, resetRows } from '../lib/capacity.js';

const DAY = 86400e3;
const now = 100 * DAY;
const account = (utilization, resetAt, extra = {}) => ({ name: 'a@x', quota: { unified7d: utilization, unified7dReset: resetAt }, ...extra });

test('history preserves last pre-reset usage, deduplicates polls and survives reload', () => {
  const history = new Map();
  const a = account(0.2, now + DAY);
  assert.equal(observeResets(history, [a], now).length, 1);
  assert.equal(observeResets(history, [a], now + 1).length, 0);
  observeResets(history, [account(0.8, now + DAY)], now + 2);
  assert.equal(history.size, 1);
  // A stale reset reported AFTER it passed must not erase its final usage.
  assert.equal(observeResets(history, [account(0, now + DAY)], now + 2 * DAY).length, 0);
  const records = JSON.parse(JSON.stringify([...history.values()]));
  const restored = new Map(records.map(e => [resetId(e), e]));
  observeResets(restored, [account(0.1, now + 8 * DAY)], now + 2 * DAY);
  assert.equal(restored.size, 2);
  assert.deepEqual(resetRows([...restored.values()], resetWindow('604800000', records, now + 2 * DAY))[0].marks.map(m => m.utilization), [0.8]);
});

test('past ranges filter by reset time, include boundaries, and exclude future events', () => {
  const events = [0, 1, 7, 30, 31].map(days => ({ name: 'a@x', provider: 'anthropic', resetAt: now - days * DAY, at: now - 40 * DAY }));
  events.push({ name: 'a@x', provider: 'anthropic', resetAt: now + 1 });
  for (const [range, count] of [[DAY, 2], [7 * DAY, 3], [30 * DAY, 4], ['all', 5]]) {
    const window = resetWindow(String(range), events, now);
    assert.equal(window.until, now);
    assert.equal(resetRows(events, window)[0].marks.length, count);
    assert.ok((window.until - window.since) / window.binMs <= 7);
  }
  const upcoming = resetWindow('upcoming', events, now);
  assert.deepEqual(upcoming, { since: now, until: now + 7 * DAY, binMs: DAY });
  assert.equal(resetRows(events, upcoming)[0].marks.length, 2);
  assert.deepEqual(resetRows([], resetWindow('all', [], now)), []);
});

test('records all windows, separates providers sharing a name, and skips paused or invalid quotas', () => {
  const history = new Map();
  observeResets(history, [
    account(0.2, now + DAY, { name: '__proto__' }),
    account(0.3, now + DAY, { name: '__proto__', provider: 'codex' }),
    account(0.4, now + DAY, { disabled: true }),
    account(0.5, NaN), account(0.5, Infinity), account(0.5, now - 1),
    { name: 'models', quota: { unified7dFable: 0.6, unified7dFableReset: now + DAY, scopedWeekly: { sonnet: { utilization: 0.7, resetAt: now + DAY } } } },
  ], now);
  const rows = resetRows([...history.values()], resetWindow('upcoming', [], now));
  assert.equal(history.size, 4);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(r => r.name === 'models').marks.map(m => m.label), ['Fable', 'Sonnet']);
});
