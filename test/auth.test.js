import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, signToken, verifyToken, allowed, throttle, authenticate } from '../lib/auth.js';

const secret = 'test-secret';
const liam = { name: 'liam', role: 'admin', ...hashPassword('correct horse') };
const sam = { name: 'sam.patel@example.com', role: 'viewer', ...hashPassword('hunter2') };
const users = [liam, sam];

test('passwords verify only against their own hash', () => {
  assert.equal(verifyPassword(liam, 'correct horse'), true);
  assert.equal(verifyPassword(liam, 'Correct horse'), false);
  assert.equal(verifyPassword(sam, 'correct horse'), false);
  assert.equal(verifyPassword({ name: 'nobody' }, ''), false);
  assert.notEqual(hashPassword('x').hash, hashPassword('x').hash, 'salted');
});

test('a token signs in its user until it expires', () => {
  const now = 1_000_000;
  const token = signToken(secret, sam, now + 60_000);
  assert.equal(verifyToken(secret, users, token, now), sam);
  assert.equal(verifyToken(secret, users, token, now + 60_000), null, 'expired');
});

test('tampered, foreign, or stale tokens are rejected', () => {
  const now = 1_000_000;
  const token = signToken(secret, liam, now + 60_000);
  const [n, e, sig] = token.split('.');
  assert.equal(verifyToken(secret, users, `${n}.${now + 999_999}.${sig}`, now), null, 'expiry changed');
  assert.equal(verifyToken(secret, users, `${Buffer.from('sam.patel@example.com').toString('base64url')}.${e}.${sig}`, now), null, 'name changed');
  assert.equal(verifyToken('other-secret', users, token, now), null, 'wrong secret');
  assert.equal(verifyToken(secret, [sam], token, now), null, 'user removed');
  const reset = { ...liam, ...hashPassword('new password') };
  assert.equal(verifyToken(secret, [reset, sam], token, now), null, 'password reset');
  assert.equal(verifyToken(secret, users, 'garbage', now), null);
  assert.equal(verifyToken(secret, users, '', now), null);
});

test('roles gate writes, not reads', () => {
  const op = { name: 'o', role: 'operator' };
  assert.equal(allowed(null, 'GET', '/api/status'), false);
  assert.equal(allowed(sam, 'GET', '/api/status'), true);
  assert.equal(allowed(sam, 'POST', '/api/control'), false);
  assert.equal(allowed(op, 'POST', '/api/control'), true);
  assert.equal(allowed(op, 'POST', '/api/accounts'), false);
  assert.equal(allowed(sam, 'GET', '/api/accounts'), false, 'the sign-in list is admin-only even to read');
  assert.equal(allowed(liam, 'GET', '/api/accounts'), true);
  assert.equal(allowed(liam, 'POST', '/api/accounts'), true);
});

test('throttle locks a name after five recent failures and forgets old ones', () => {
  const f = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) { assert.equal(throttle(f, 'liam', t0 + i), 0); f.get('liam').push(t0 + i); }
  assert.ok(throttle(f, 'liam', t0 + 10) >= 1, 'locked, minutes left');
  assert.equal(throttle(f, 'sam', t0 + 10), 0, 'other names unaffected');
  assert.equal(throttle(f, 'liam', t0 + 16 * 60_000), 0, 'window passed');
});

test('unknown-name spray retains no state and cannot evict an account lockout', () => {
  const failures = new Map();
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) assert.deepEqual(authenticate(users, failures, liam.name, 'wrong', now), { user: null, wait: 0 });
  for (let i = 0; i < 1000; i++) {
    assert.deepEqual(authenticate(users, failures, `unknown-${i}`, 'wrong', now), { user: null, wait: 0 });
  }
  for (const name of ['', 'x'.repeat(60_000), 'invalid/name', '__proto__', 'constructor']) {
    assert.deepEqual(authenticate(users, failures, name, 'wrong', now), { user: null, wait: 0 });
  }
  assert.deepEqual([...failures.keys()], [liam.name]);
  assert.equal(failures.get(liam.name).length, 5);
  assert.ok(authenticate(users, failures, liam.name, 'correct horse', now).wait > 0);
  assert.equal(authenticate(users, failures, sam.name, 'hunter2', now).user, sam);
  assert.equal(failures.size, 1);
});

test('abandoned failures expire without retrying the same name', () => {
  const failures = new Map();
  const now = 1_000_000;
  authenticate(users, failures, liam.name, 'wrong', now);
  assert.equal(failures.size, 1);
  authenticate(users, failures, 'unknown', 'wrong', now + 15 * 60_000);
  assert.equal(failures.size, 0);
  assert.equal(authenticate(users, failures, liam.name, 'correct horse', now + 15 * 60_000).user, liam);
  assert.equal(failures.size, 0, 'successful sign-in leaves no failure state');
});

test('removed accounts do not leave failure keys and recreated accounts can sign in', () => {
  const failures = new Map();
  const now = 1_000_000;
  authenticate(users, failures, liam.name, 'wrong', now);
  authenticate([sam], failures, 'unknown', 'wrong', now);
  assert.equal(failures.size, 0);
  const replacement = { ...liam, ...hashPassword('replacement-password') };
  assert.equal(authenticate([replacement, sam], failures, liam.name, 'replacement-password', now).user, replacement);
});
