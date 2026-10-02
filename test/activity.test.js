import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, totals, select } from '../lib/activity.js';

const snap = (req, cacheRead, clients = {}) => ({
  accounts: [{ name: 'a@x', usage: { totalRequests: req, totalInputTokens: 10, totalOutputTokens: 5, totalCacheReadTokens: cacheRead, totalCacheCreationTokens: 0 } }],
  clients,
});

test('tick records positive deltas per account and client', () => {
  const t = tick(snap(10, 1000, { liam: { requests: 2, inputTokens: 100, outputTokens: 10 } }), snap(13, 1500, { liam: { requests: 5, inputTokens: 160, outputTokens: 30 } }), 42);
  assert.deepEqual(t, { at: 42, accounts: { 'a@x': { requests: 3, tokens: 500 } }, clients: { liam: { requests: 3, inputTokens: 60, outputTokens: 20 } } });
});

test('tick is null when nothing changed or on first poll', () => {
  assert.equal(tick(null, snap(1, 1)), null);
  assert.equal(tick(snap(1, 1), snap(1, 1)), null);
});

test('counters going down (restart) are not negative activity', () => {
  assert.equal(tick(snap(10, 1000), snap(2, 50)), null);
});

test('new client appears with its full count', () => {
  const t = tick(snap(1, 1), snap(1, 1, { bob: { requests: 4, inputTokens: 1, outputTokens: 1 } }), 1);
  assert.deepEqual(t.clients, { bob: { requests: 4, inputTokens: 1, outputTokens: 1 } });
});

test('totals and select', () => {
  const ticks = [
    { at: 1, accounts: { 'a@x': { requests: 1, tokens: 10 } }, clients: { liam: { requests: 1, inputTokens: 5, outputTokens: 5 } } },
    { at: 2, accounts: { 'b@x': { requests: 2, tokens: 20 } }, clients: { liam: { requests: 2, inputTokens: 10, outputTokens: 10 } } },
    { at: 3, accounts: { 'a@x': { requests: 1, tokens: 10 } }, clients: {} },
  ];
  assert.deepEqual(totals(ticks, 'clients'), { liam: { requests: 3, tokens: 30, lastAt: 2 } });
  assert.deepEqual(totals(ticks, 'accounts')['a@x'], { requests: 2, tokens: 20, lastAt: 3 });
  assert.equal(select(ticks, { since: 2 }).length, 2);
  assert.deepEqual(select(ticks, { who: 'liam' }).map(t => t.at), [1, 2]);
  assert.deepEqual(select(ticks, { who: 'b@x' }).map(t => t.at), [2]);
});
