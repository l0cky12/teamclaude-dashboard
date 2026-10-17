import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, totals, select, forAccount } from '../lib/activity.js';

const snap = (req, cacheRead, clients = {}) => ({
  accounts: [{ name: 'a@x', usage: { totalRequests: req, totalInputTokens: 10, totalOutputTokens: 5, totalCacheReadTokens: cacheRead, totalCacheCreationTokens: 0 } }],
  clients,
});

test('tick records positive deltas per account and client', () => {
  const t = tick(snap(10, 1000, { liam: { requests: 2, inputTokens: 100, outputTokens: 10 } }), snap(13, 1500, { liam: { requests: 5, inputTokens: 160, outputTokens: 30 } }), 42);
  assert.deepEqual(t, { at: 42, accounts: { 'a@x': { requests: 3, tokens: 500, input: 0, output: 0, cacheRead: 500, cacheWrite: 0 } }, clients: { liam: { requests: 3, inputTokens: 60, outputTokens: 20 } } });
});

test('tick keeps the per-bucket cache split and marks Codex accounts', () => {
  const at = (cr, fable) => ({ accounts: [{ name: 'c@x', provider: 'codex', usage: { totalRequests: cr, totalCacheReadTokens: cr, byBucket: { unified7dFable: { cacheReadTokens: fable, cacheCreationTokens: 0 } } } }] });
  const t = tick(at(10, 4), at(30, 9), 1);
  assert.deepEqual(t.accounts['c@x'].buckets, { unified7dFable: { cacheRead: 5, cacheWrite: 0 } });
  assert.equal(t.accounts['c@x'].provider, 'codex');
});

test('tick takes per-model deltas when the proxy reports them, else the Codex models seen', () => {
  const at = (n, byModel) => ({ accounts: [{ name: 'c@x', provider: 'codex', quota: { codexModelLimits: { 'gpt-6-luna': 'premium' } }, usage: { totalRequests: n, totalInputTokens: n, byModel } }] });
  const t = tick(at(1, { 'gpt-6-luna': { inputTokens: 1 } }), at(4, { 'gpt-6-luna': { inputTokens: 3 }, __proto__x: { inputTokens: 0 }, 'gpt-6-astra': { inputTokens: 1, outputTokens: 2 } }), 1);
  assert.deepEqual(t.accounts['c@x'].models, { 'gpt-6-luna': { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }, 'gpt-6-astra': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(t.accounts['c@x'].seen, undefined);
  assert.deepEqual(tick(at(1), at(2), 1).accounts['c@x'].seen, ['gpt-6-luna']);
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

test('names matching object prototype properties are kept and matched exactly', () => {
  const names = ['constructor', 'toString', '__proto__'];
  const snapAll = n => ({ accounts: names.map(name => ({ name, usage: { totalRequests: n } })), clients: Object.fromEntries(names.map(name => [name, { requests: n }])) });
  const t = tick(snapAll(0), snapAll(1), 1);
  assert.deepEqual(Object.keys(t.accounts), names);
  assert.deepEqual(Object.keys(t.clients), names);
  assert.deepEqual(Object.keys(totals([t], 'accounts')), names);
  assert.equal(totals([t], 'clients').__proto__.requests, 1);
  assert.equal(Object.hasOwn(Object, 'requests'), false);
  assert.equal(select([{ at: 1, accounts: { 'a@x': {} }, clients: {} }], { who: 'toString' }).length, 0);
});

test('forAccount keeps only the intervals and shares of that account', () => {
  const ticks = [
    { at: 1, accounts: { a: { requests: 1, tokens: 10 }, b: { requests: 2, tokens: 20 } }, clients: { a: { requests: 3 } } },
    { at: 2, accounts: { b: { requests: 1, tokens: 5 } }, clients: {} },
    { at: 3, accounts: { a: { requests: 1, tokens: 7 } }, clients: {} },
  ];
  const out = forAccount(ticks, 'a', 2);
  assert.deepEqual(out, [{ at: 3, accounts: { a: { requests: 1, tokens: 7 } }, clients: {} }]);
  const all = forAccount(ticks, 'a');
  assert.deepEqual(Object.keys(all[0].accounts), ['a'], "b's share is dropped from a shared interval");
  assert.deepEqual(totals(all, 'accounts'), { a: { requests: 2, tokens: 17, lastAt: 3 } });
  assert.deepEqual(forAccount(ticks, 'nobody'), []);
});

test('forAccount tells a Codex account from a Claude one sharing its name', () => {
  const ticks = [
    { at: 1, accounts: { 'me@x': { requests: 1, tokens: 10, provider: 'codex' } }, clients: {} },
    { at: 2, accounts: { 'me@x': { requests: 1, tokens: 20 } }, clients: {} },
  ];
  assert.deepEqual(forAccount(ticks, 'me@x', 0, 'anthropic').map(t => t.at), [2], 'Claude skips the Codex-marked interval');
  assert.deepEqual(forAccount(ticks, 'me@x', 0, 'codex').map(t => t.at), [1, 2], 'Codex also keeps legacy rows that carry no mark');
});
