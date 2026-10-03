// Dashboard sign-in primitives: scrypt password hashes and stateless signed
// session tokens. Pure functions over a users list; the server owns the file.
import { randomBytes, scryptSync, timingSafeEqual, createHmac, createHash } from 'node:crypto';

export const ROLES = ['admin', 'operator', 'viewer'];
export const NAME = /^[\w.@+-]{1,64}$/;

const safeEqual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function hashPassword(password, salt = randomBytes(16).toString('base64url')) {
  return { salt, hash: scryptSync(String(password), salt, 32).toString('base64url') };
}

export function verifyPassword(user, password) {
  if (!user?.hash || !user?.salt) return false;
  return safeEqual(hashPassword(password, user.salt).hash, user.hash);
}

// The fingerprint ties a token to the password it was issued under, so a
// reset or removal signs the person out everywhere without a session store.
const fingerprint = user => createHash('sha256').update(user.hash).digest('base64url').slice(0, 16);
const sign = (secret, name, exp, fp) => createHmac('sha256', secret).update(`${name}|${exp}|${fp}`).digest('base64url');

export function signToken(secret, user, exp) {
  const name = Buffer.from(user.name).toString('base64url');
  return `${name}.${exp}.${sign(secret, user.name, exp, fingerprint(user))}`;
}

/** @returns the user the token belongs to, or null if it is invalid, expired, or stale. */
export function verifyToken(secret, users, token, now = Date.now()) {
  const [n, e, sig] = String(token || '').split('.');
  if (!n || !e || !sig) return null;
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp <= now) return null;
  const name = Buffer.from(n, 'base64url').toString('utf8');
  const user = users.find(u => u.name === name);
  if (!user) return null;
  return safeEqual(sign(secret, name, exp, fingerprint(user)), sig) ? user : null;
}

/** Dashboard sign-ins are admin-only, reads are open to everyone signed in, other writes need admin or operator. */
export function allowed(user, method, pathname) {
  if (!user) return false;
  if (pathname === '/api/accounts') return user.role === 'admin';
  if (method === 'GET' || method === 'HEAD') return true;
  return user.role === 'admin' || user.role === 'operator';
}

/** Five wrong passwords for one name inside fifteen minutes locks that name briefly. */
export function throttle(failures, name, now = Date.now(), { max = 5, windowMs = 15 * 60_000 } = {}) {
  const recent = (failures.get(name) || []).filter(t => now - t < windowMs);
  failures.set(name, recent);
  return recent.length >= max ? Math.ceil((recent[0] + windowMs - now) / 60_000) : 0;
}
