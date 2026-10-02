import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attention, meters, severity, nextReset, sortForAttention, formatDuration } from '../lib/attention.js';

const now = 1_800_000_000_000;
const base = { name: 'a@x', status: 'active', unavailable: null, quota: { unified7d: 0.72, unified7dReset: now + 3 * 86400e3, unified7dFable: 0.67, unified7dFableReset: now + 3 * 86400e3 }, auth: { hasRefreshToken: true } };

test('meters lists only reported windows, in order', () => {
  assert.deepEqual(meters(base).map(m => m.key), ['unified7d', 'unified7dFable']);
  assert.deepEqual(meters({ quota: { unified5h: 0.1, scopedWeekly: { opus: { utilization: 0.4, resetAt: 1 } } } }).map(m => m.label), ['Session', 'Opus']);
});

test('severity thresholds', () => {
  assert.equal(severity(0.5), 'ok');
  assert.equal(severity(0.7), 'warning');
  assert.equal(severity(0.9), 'critical');
  assert.equal(severity(0.85, 0.8), 'critical');
  assert.equal(severity(null), 'ok');
});

test('healthy account needs no attention', () => {
  assert.deepEqual(attention(base, { now }), []);
});

test('error account asks for sign-in first', () => {
  const items = attention({ ...base, status: 'error', unavailable: 'error' }, { now });
  assert.equal(items[0].level, 'critical');
  assert.equal(items[0].action, 'signin');
});

test('expired token without refresh is critical; with refresh is not', () => {
  assert.equal(attention({ ...base, auth: { expiresAt: now - 1, hasRefreshToken: false } }, { now })[0].level, 'critical');
  assert.deepEqual(attention({ ...base, auth: { expiresAt: now - 1, hasRefreshToken: true } }, { now }), []);
});

test('near-limit window is a warning with countdown', () => {
  const items = attention({ ...base, quota: { ...base.quota, unified7d: 0.95 } }, { now });
  assert.equal(items.length, 1);
  assert.equal(items[0].level, 'warning');
  assert.match(items[0].text, /Weekly window at 95%, resets in 3d 0h/);
});

test('blocked account reports when it is back', () => {
  const items = attention({ ...base, unavailable: 'throttled', rateLimitedUntil: new Date(now + 90e3).toISOString() }, { now });
  assert.match(items[0].text, /Rate limited.*back in 1m/);
});

test('disabled accounts are never flagged', () => {
  assert.deepEqual(attention({ ...base, disabled: true, status: 'error' }, { now }), []);
});

test('nextReset and sort', () => {
  assert.equal(nextReset(base, now), now + 3 * 86400e3);
  const sorted = sortForAttention([{ ...base, name: 'z' }, { ...base, name: 'b', status: 'error' }, { ...base, name: 'a' }], { now });
  assert.deepEqual(sorted.map(a => a.name), ['b', 'a', 'z']);
});

test('formatDuration', () => {
  assert.equal(formatDuration(30e3), 'under a minute');
  assert.equal(formatDuration(5 * 60e3), '5m');
  assert.equal(formatDuration(3.5 * 3600e3), '3h 30m');
  assert.equal(formatDuration(49 * 3600e3), '2d 1h');
});
