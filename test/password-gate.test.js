import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordGate } from '../lib/password-gate.js';

test('shared-password failures are bounded and expire at the window boundary', () => {
  let at = 1_000_000;
  const check = passwordGate('correct:password', { now: () => at });
  for (let i = 0; i < 20; i++) assert.equal(check('correct:password'), true);
  for (let i = 0; i < 5; i++) assert.equal(check(`wrong-${i}`), false);
  const locked = err => err.status === 429;
  for (let i = 0; i < 1000; i++) assert.throws(() => check(`different-${i}`), locked);
  assert.throws(() => check('correct:password'), locked);
  at += 15 * 60_000 - 1;
  assert.throws(() => check('correct:password'), locked);
  at++;
  assert.equal(check('correct:password'), true);
  assert.equal(check('wrong'), false);
});

test('successful comparisons do not erase recent failed guesses', () => {
  const check = passwordGate('password');
  for (let i = 0; i < 5; i++) {
    assert.equal(check('password'), true);
    assert.equal(check('wrong'), false);
  }
  assert.throws(() => check('password'), err => err.status === 429);
});
