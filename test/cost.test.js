import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byModel, costOf, priceOf, usageReport } from '../lib/cost.js';

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
  assert.equal(r.models.codex.unpriced, 10);
  assert.deepEqual(r.bins.map(b => b.cost), [0.4, 0]);
  assert.deepEqual({ ...r.bins[0].accounts }, { 'a@x': { cost: 0.4, costHigh: 0.4 } });
});

test('usageReport keeps accounts whose names match object prototype properties', () => {
  const names = ['constructor', 'toString', '__proto__'];
  const accounts = Object.fromEntries(names.map(name => [name, { requests: 1, input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }]));
  const r = usageReport([{ at: 1, accounts }], { since: 0, until: 2, binMs: 2 });
  assert.deepEqual(Object.keys(r.accounts), names);
  for (const name of names) {
    assert.equal(r.accounts[name].cost, 4);
    assert.equal(r.accounts[name].requests, 1);
    assert.equal(r.bins[0].accounts[name].cost, 4);
  }
  assert.equal(r.total.cost, 12);
  assert.equal(Object.hasOwn(Object.prototype, 'cost'), false);
});

test('priceOf strips context and date suffixes and ignores prototype names', () => {
  assert.equal(priceOf('claude-opus-5-5[1m]'), priceOf('claude-opus-5-5'));
  assert.equal(priceOf('claude-haiku-4-5-20251001').input, 1);
  assert.equal(priceOf('__proto__'), null);
  assert.equal(priceOf('toString'), null);
});

test('a per-model split from the proxy is priced exactly, per account too', () => {
  const models = { 'gpt-6-luna': { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, 'gpt-6-astra': { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, mystery: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const r = usageReport([{ at: 1, accounts: { 'c@x': { requests: 1, provider: 'codex', input: 2e6, output: 0, cacheRead: 0, cacheWrite: 0, models } } }], { since: 0, until: 2 });
  assert.equal(r.total.cost, 10.1);
  assert.equal(r.total.costHigh, 10.1);
  assert.equal(r.total.unpriced, 5);
  assert.equal(r.accounts['c@x'].models['gpt-6-astra'].cost, 10);
  assert.equal(r.accounts['c@x'].models.mystery.unpriced, 5);
});

test('Codex without a per-model split is a range over the models it served', () => {
  const d = { requests: 1, provider: 'codex', input: 1e6, output: 0, cacheRead: 1e6, cacheWrite: 0, seen: ['gpt-6-luna', 'gpt-6-astra', 'gpt-future'] };
  const r = usageReport([{ at: 1, accounts: { 'c@x': d } }], { since: 0, until: 2, binMs: 2 });
  assert.equal(r.total.cost, 0.1 + 0.01);
  assert.equal(r.total.costHigh, 10 + 1);
  assert.equal(r.total.unpriced, 0);
  assert.equal(r.total.savings, 0.1 - 0.01);
  assert.deepEqual(r.models.codex.candidates, ['gpt-6-luna', 'gpt-6-astra', 'gpt-future']);
  assert.deepEqual({ ...r.bins[0].accounts }, { 'c@x': { cost: 0.11, costHigh: 11 } });
  const { seen: _, ...old } = d;
  assert.equal(usageReport([{ at: 1, accounts: { 'c@x': old } }], { seen: { 'c@x': ['gpt-6-luna'] } }).total.cost, 0.11);
});
