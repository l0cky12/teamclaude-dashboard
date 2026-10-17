import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffEvents } from '../lib/events.js';

const snap = (accounts, current = {}) => ({ accounts, currentAccounts: current });
const acct = (name, extra = {}) => ({ name, provider: 'anthropic', status: 'active', auth: {}, ...extra });

test('first snapshot is a baseline, not a change', () => {
  assert.deepEqual(diffEvents(null, snap([acct('a')])), []);
});

test('nothing changed, nothing logged', () => {
  assert.deepEqual(diffEvents(snap([acct('a')]), snap([acct('a')]), 10, 5), []);
});

test('serving, pause, error, block and token changes become one line each', () => {
  const prev = snap([acct('a'), acct('b')], { anthropic: 'a' });
  const next = snap([acct('a', { disabled: true }), acct('b', { status: 'error', unavailable: 'error', auth: { expiresAt: 1, hasRefreshToken: true } })], { anthropic: 'b' });
  const kinds = diffEvents(prev, next, 100, 50).map(e => `${e.account}:${e.kind}`);
  assert.deepEqual(kinds, ['a:serving', 'a:paused', 'b:serving', 'b:error', 'b:token']);
});

test('a block clearing names what it was', () => {
  const prev = snap([acct('a', { unavailable: 'throttled' })]);
  const [e] = diffEvents(prev, snap([acct('a')]), 100, 50);
  assert.equal(e.kind, 'blocked');
  assert.match(e.text, /rate limited/);
});

test('a window whose reset time passed between polls is logged as a reset', () => {
  const prev = snap([acct('a', { quota: { unified5h: 0.9, unified5hReset: 75 } })]);
  const next = snap([acct('a', { quota: { unified5h: 0.0, unified5hReset: 500 } })]);
  const out = diffEvents(prev, next, 100, 50);
  assert.deepEqual(out.map(e => [e.kind, e.text]), [['reset', 'Session window reset']]);
  assert.deepEqual(diffEvents(prev, next, 70, 50), [], 'not yet when the reset is still ahead');
});

test('a Claude and a Codex account sharing a name are tracked apart', () => {
  const both = (claudeExtra, codexExtra) => snap([acct('me@x', claudeExtra), acct('me@x', { provider: 'codex', ...codexExtra })], { anthropic: 'me@x' });
  assert.deepEqual(diffEvents(both({}, { disabled: true }), both({}, { disabled: true }), 100, 50), [], 'unchanged snapshots log nothing');
  const out = diffEvents(both({}, { disabled: true }), both({}, {}), 100, 50);
  assert.deepEqual(out.map(e => [e.provider, e.kind, e.text]), [['codex', 'paused', 'Resumed']]);
  assert.deepEqual(diffEvents(both({}, {}), both({}, {}), 100, 50), [], 'the Claude one serving does not read as the Codex one serving');
});

test('accounts missing from the earlier snapshot are skipped', () => {
  assert.deepEqual(diffEvents(snap([]), snap([acct('new')], { anthropic: 'new' }), 10, 5), []);
});
