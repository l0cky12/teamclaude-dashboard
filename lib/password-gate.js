import { timingSafeEqual } from 'node:crypto';

/** One bounded failure budget for every entry point using the shared password. */
export function passwordGate(password, { now = Date.now, max = 5, windowMs = 15 * 60_000 } = {}) {
  const expected = Buffer.from(String(password));
  let failures = [];
  return input => {
    const at = now();
    failures = failures.filter(t => at - t < windowMs);
    if (failures.length >= max) {
      const wait = Math.ceil((failures[0] + windowMs - at) / 60_000);
      throw Object.assign(new Error(`Too many attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`), { status: 429 });
    }
    const supplied = Buffer.from(String(input));
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
    failures.push(at);
    return false;
  };
}
