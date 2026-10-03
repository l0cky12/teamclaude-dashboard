import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, signToken, verifyToken, allowed, throttle } from '../lib/auth.js';

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
