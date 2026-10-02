import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byModel, costOf, usageReport } from '../lib/cost.js';

test('byModel splits cache by bucket and apportions input/output by cache share', () => {
  const m = byModel({ input: 100, output: 40, cacheRead: 1000, cacheWrite: 0, buckets: { unified7d: { cacheRead: 750, cacheWrite: 0 }, unified7dFable: { cacheRead: 250, cacheWrite: 0 } } });
  assert.deepEqual(m['claude-opus-5-5'], { input: 75, output: 30, cacheRead: 750, cacheWrite: 0 });
  assert.deepEqual(m['claude-fable-5-1'], { input: 25, output: 10, cacheRead: 250, cacheWrite: 0 });
});

test('no cache tokens: everything is the default model', () => {
  assert.deepEqual(byModel({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }), { 'claude-opus-5-5': { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
});

test('costOf uses $/1M prices; unknown models are unpriced', () => {
  assert.equal(costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, 'claude-opus-5-5'), 4 + 20 + 0.2 + 5);
  assert.equal(costOf({ input: 1e6 }, 'codex'), null);
});

test('usageReport totals, per account, unpriced share, savings and bins', () => {
  const ticks = [
    { at: 0, accounts: { 'a@x': { requests: 1, tokens: 2e6, input: 0, output: 0, cacheRead: 2e6, cacheWrite: 0 } } },
    { at: 3600e3 + 1, accounts: { 'c@x': { requests: 2, tokens: 10, input: 10, output: 0, cacheRead: 0, cacheWrite: 0, provider: 'codex' } }, clients: {} },
    { at: 3600e3 + 2, accounts: { 'old@x': { requests: 1, tokens: 7 } } },
  ];
  const r = usageReport(ticks, { since: 0, until: 7200e3, binMs: 3600e3 });
  assert.equal(r.total.cost, 0.4);
  assert.equal(r.total.requests, 4);
  assert.equal(r.total.unpriced, 17);
  assert.equal(r.total.savings, 2 * (4 - 0.2));
  assert.equal(r.accounts['c@x'].provider, 'codex');
  assert.equal(r.accounts['c@x'].cost, 0);
  assert.equal(r.models.codex.priced, false);
  assert.deepEqual(r.bins.map(b => b.cost), [0.4, 0]);
  assert.deepEqual(r.bins[0].accounts, { 'a@x': 0.4 });
});
