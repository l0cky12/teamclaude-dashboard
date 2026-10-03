// Team Claude dashboard server: static files + a thin API over the proxy's
// control plane and Team Claude's own login/config modules, plus a poller that
// turns the proxy's cumulative counters into a request log.
import http from 'node:http';
import { readFile, stat, appendFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { loadConfig, atomicConfigUpdate, getConfigPath } from '@karpeleslab/teamclaude/src/config.js';
import { parseAuthCode, profileForCredentials, tokenPairFromResponse } from '@karpeleslab/teamclaude/src/oauth.js';
import { buildCodexAuthUrl, exchangeCodexCode } from '@karpeleslab/teamclaude/src/codex-auth.js';
import { oauthIdentityFields, findUpsertTarget, updateAccountEntry, canUpsertOAuthAccount, sameIdentity } from '@karpeleslab/teamclaude/src/identity.js';
import { tick } from './lib/activity.js';
import { hashPassword, verifyPassword, signToken, verifyToken, allowed, throttle, ROLES, NAME } from './lib/auth.js';
import { resetsBetween } from './lib/attention.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const PROXY_URL = (process.env.TEAMCLAUDE_URL || 'http://127.0.0.1:3456').replace(/\/$/, '');
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DATA_DIR = process.env.DASHBOARD_DATA_DIR || join(ROOT, 'data');
const POLL_MS = Number(process.env.POLL_MS) || 5000;
const RETAIN_MS = 7 * 86400e3;

// Claude Code's OAuth client, as used by Team Claude's own `login` command
// (oauth.js keeps these private, so they are repeated here).
const CLAUDE = {
  authorize: 'https://claude.ai/oauth/authorize',
  token: 'https://platform.claude.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scopes: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  // Manual redirect: Anthropic shows the code on a page for the user to copy.
  redirect: 'https://console.anthropic.com/oauth/code/callback',
};
// OpenAI registered exactly one redirect for the Codex CLI client.
const CODEX_REDIRECT = 'http://localhost:1455/auth/callback';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

// ── proxy + config ──────────────────────────────────────────────────────────

async function proxyKey() {
  if (process.env.TEAMCLAUDE_API_KEY) return process.env.TEAMCLAUDE_API_KEY;
  const cfg = await loadConfig();
  return cfg?.proxy?.apiKey || '';
}

async function proxy(method, path, body) {
  const res = await fetch(PROXY_URL + path, {
    method,
    headers: { 'x-api-key': await proxyKey(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { ok: false, error: text.slice(0, 200) }; }
  return { status: res.status, json };
}

/** Status from the proxy plus what only the config file knows (never tokens or keys). */
async function fetchStatus() {
  const [{ status: code, json }, cfg] = await Promise.all([proxy('GET', '/teamclaude/status'), loadConfig()]);
  if (code !== 200) throw Object.assign(new Error(json?.error?.message || json?.error || `proxy answered ${code}`), { status: 502 });
  const byName = new Map((cfg?.accounts || []).map(a => [a.name, a]));
  json.accounts = (json.accounts || []).map(a => {
    const c = byName.get(a.name) || {};
    return { ...a, auth: { expiresAt: c.expiresAt ?? null, hasRefreshToken: !!c.refreshToken, source: c.source ?? null, planType: c.planType ?? a.quota?.planType ?? null, rateLimitTier: c.rateLimitTier ?? null, seatTier: c.seatTier ?? null } };
  });
  json.users = (cfg?.proxy?.clientKeys || []).filter(e => e?.name && e?.key).map(e => ({ name: String(e.name).trim(), keyHint: `${String(e.key).slice(0, 7)}…` }));
  json.dashboard = { proxyUrl: PROXY_URL, configPath: getConfigPath(), now: Date.now(), pollMs: POLL_MS };
  return json;
}

// ── request log (poller) ────────────────────────────────────────────────────

const ACTIVITY_FILE = join(DATA_DIR, 'activity.jsonl');
let latest = null, latestAt = 0, latestReadAt = 0, pollError = null, polling = null;
/** @type {ReturnType<typeof tick>[]} */
let ticks = [];

async function loadTicks() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const cutoff = Date.now() - RETAIN_MS;
    ticks = (await readFile(ACTIVITY_FILE, 'utf8')).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(t => t && t.at >= cutoff);
    await writeFile(ACTIVITY_FILE, ticks.map(t => JSON.stringify(t)).join('\n') + (ticks.length ? '\n' : ''));
  } catch (err) { if (err.code !== 'ENOENT') console.error(`[dashboard] could not read ${ACTIVITY_FILE}: ${err.message}`); }
}

// One poll at a time: two overlapping polls would both diff against the same
// snapshot and log the same requests twice.
const poll = () => (polling ??= pollOnce().finally(() => { polling = null; }));

async function pollOnce() {
  try {
    const readAt = Date.now();
    let next = await fetchStatus();
    // A window reset since the last read. The proxy drops the old figure but
    // only learns the new one from that account's next request, so ask it to
    // read every account's usage now (zero-spend) and show that instead.
    if (latest && resetsBetween(latest.accounts, latestReadAt, readAt)) {
      const probe = await proxy('POST', '/teamclaude/probe').catch(err => ({ status: 0, json: { error: err.message } }));
      if (probe.status === 200) next = await fetchStatus();
      else console.error(`[dashboard] quota probe after a reset failed: ${probe.json?.error || `proxy answered ${probe.status}`}`);
    }
    const t = tick(latest, next);
    latest = next; latestAt = Date.now(); latestReadAt = readAt; pollError = null;
    if (t) {
      ticks.push(t);
      // ponytail: the file only grows between restarts; loadTicks() compacts it on start.
      await appendFile(ACTIVITY_FILE, JSON.stringify(t) + '\n').catch(err => console.error(`[dashboard] could not write ${ACTIVITY_FILE}: ${err.message}`));
      const cutoff = Date.now() - RETAIN_MS;
      if (ticks.length && ticks[0].at < cutoff) ticks = ticks.filter(x => x.at >= cutoff);
    }
  } catch (err) {
    pollError = err;
  }
}

async function status() {
  if (latest && Date.now() - latestAt < POLL_MS * 1.5) return latest;
  await poll();
  if (!latest) throw pollError || new Error('no status yet');
  if (pollError && Date.now() - latestAt > POLL_MS * 3) throw pollError;
  return latest;
}

// ── users (proxy.clientKeys) ────────────────────────────────────────────────

const USER_NAME = /^[\w.@+-]{1,64}$/;

async function userAction({ action, name }) {
  name = String(name || '').trim();
  if (!USER_NAME.test(name)) throw Object.assign(new Error('Name may use letters, digits, . _ @ + - (max 64).'), { status: 400 });
  let key = null;
  await atomicConfigUpdate(config => {
    config.proxy ||= {};
    const keys = Array.isArray(config.proxy.clientKeys) ? config.proxy.clientKeys : [];
    const idx = keys.findIndex(e => String(e?.name || '').trim() === name);
    if (action === 'add') {
      if (idx >= 0) throw Object.assign(new Error(`There is already a user named ${name}.`), { status: 409 });
      key = `tc-${randomBytes(24).toString('base64url')}`;
      keys.push({ name, key });
    } else if (action === 'rotate') {
      if (idx < 0) throw Object.assign(new Error(`No user named ${name}.`), { status: 404 });
      key = `tc-${randomBytes(24).toString('base64url')}`;
      keys[idx] = { ...keys[idx], key };
    } else if (action === 'remove') {
      if (idx < 0) throw Object.assign(new Error(`No user named ${name}.`), { status: 404 });
      keys.splice(idx, 1);
    } else {
      throw Object.assign(new Error(`unknown action "${action}"`), { status: 400 });
    }
    config.proxy.clientKeys = keys;
  });
  const reload = await proxy('POST', '/teamclaude/reload').catch(err => ({ status: 0, json: { error: err.message } }));
  latestAt = 0; // force a fresh status on the next read
  return { ok: true, name, ...(key ? { key } : {}), reloaded: reload.status === 200, reloadError: reload.status === 200 ? null : (reload.json?.error || `proxy answered ${reload.status}`) };
}

// ── login flows ─────────────────────────────────────────────────────────────

const logins = new Map(); // id -> { provider, verifier, state, createdAt }
const LOGIN_TTL = 10 * 60_000;

function startLogin(provider) {
  for (const [id, l] of logins) if (Date.now() - l.createdAt > LOGIN_TTL) logins.delete(id);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  let url;
  if (provider === 'codex') {
    url = buildCodexAuthUrl({ state, codeChallenge: challenge });
  } else {
    const u = new URL(CLAUDE.authorize);
    u.searchParams.set('code', 'true');
    u.searchParams.set('client_id', CLAUDE.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', CLAUDE.redirect);
    u.searchParams.set('scope', CLAUDE.scopes);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    url = u.toString();
  }
  const id = randomBytes(12).toString('base64url');
  logins.set(id, { provider, verifier, state, createdAt: Date.now() });
  return { id, url, provider };
}

async function exchangeClaude(code, state, verifier) {
  const res = await fetch(CLAUDE.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, state, grant_type: 'authorization_code', client_id: CLAUDE.clientId, redirect_uri: CLAUDE.redirect, code_verifier: verifier }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return tokenPairFromResponse(await res.json());
}

async function finishLogin(id, input) {
  const login = logins.get(id);
  if (!login) throw Object.assign(new Error('This sign-in attempt expired. Start again.'), { status: 410 });
  const parsed = parseAuthCode(String(input || ''), login.state); // throws on state mismatch
  if (!parsed?.code) throw Object.assign(new Error('No authorization code found in what you pasted.'), { status: 400 });
  logins.delete(id);

  let outcome;
  if (login.provider === 'codex') {
    const creds = await exchangeCodexCode({ code: parsed.code, codeVerifier: login.verifier, redirectUri: CODEX_REDIRECT });
    outcome = await upsertCodex(creds);
  } else {
    const tokens = await exchangeClaude(parsed.code, parsed.state, login.verifier);
    outcome = await upsertClaude(tokens);
  }
  const reload = await proxy('POST', '/teamclaude/reload').catch(err => ({ status: 0, json: { error: err.message } }));
  latestAt = 0;
  return { ...outcome, reloaded: reload.status === 200, reloadError: reload.status === 200 ? null : (reload.json?.error || `proxy answered ${reload.status}`) };
}

// Mirrors the CLI's upsertOAuthAccount: identify by profile, then match on
// account+org identity so a re-login refreshes the existing row.
async function upsertClaude(tokens) {
  const { creds, profile } = await profileForCredentials(tokens);
  if (!canUpsertOAuthAccount(profile, false)) {
    throw new Error(`Could not identify the Claude account — ${profile?.error || 'profile unavailable'}`);
  }
  const account = {
    name: profile.email,
    type: 'oauth',
    source: 'login',
    ...oauthIdentityFields(profile),
    organizationType: profile.organizationType || null,
    rateLimitTier: profile.rateLimitTier || creds.rateLimitTier || null,
    seatTier: profile.seatTier || null,
    hasClaudeMax: profile.hasClaudeMax ?? null,
    hasClaudePro: profile.hasClaudePro ?? null,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };
  let outcome = { action: 'added', name: account.name };
  await atomicConfigUpdate(config => {
    const idx = findUpsertTarget(config.accounts, account);
    if (idx >= 0) {
      config.accounts[idx] = updateAccountEntry(config.accounts[idx], account);
      outcome = { action: 'updated', name: config.accounts[idx].name };
    } else {
      config.accounts.push(account);
    }
  });
  return outcome;
}

// Mirrors the CLI's upsertCodexAccount.
async function upsertCodex(creds) {
  let outcome = { action: 'added', name: creds.email || '' };
  await atomicConfigUpdate(config => {
    const name = creds.email || `codex-${config.accounts.filter(a => a.provider === 'codex').length + 1}`;
    const account = { name, type: 'oauth', provider: 'codex', source: 'login', accountId: creds.accountId, userId: creds.userId, accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
    const idx = config.accounts.findIndex(a => a.provider === 'codex' && (sameIdentity(a, account) || a.name === account.name));
    if (idx >= 0) {
      config.accounts[idx] = { ...config.accounts[idx], ...account, name: config.accounts[idx].name };
      outcome = { action: 'updated', name: config.accounts[idx].name };
    } else {
      config.accounts.push(account);
      outcome = { action: 'added', name };
    }
  });
  return outcome;
}

// ── control plane passthrough ───────────────────────────────────────────────

const CONTROL = {
  switch: b => ['/teamclaude/switch', { account: b.account }],
  disable: b => ['/teamclaude/disable', { account: b.account, disabled: !!b.disabled }],
  probe: () => ['/teamclaude/probe', null],
  reload: () => ['/teamclaude/reload', null],
};

// ── dashboard accounts + sessions ───────────────────────────────────────────

const USERS_FILE = join(DATA_DIR, 'users.json');
const SECRET_FILE = join(DATA_DIR, 'secret');
const SESSION_MS = { remember: 30 * 86400e3, once: 86400e3 };
const fail = (status, message) => Object.assign(new Error(message), { status });
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
let users = [];
let secret = '';
const failures = new Map(); // name -> timestamps of wrong passwords

async function loadUsers() {
  await mkdir(DATA_DIR, { recursive: true });
  try { users = JSON.parse(await readFile(USERS_FILE, 'utf8')).users || []; } catch (err) { if (err.code !== 'ENOENT') throw err; }
  try { secret = (await readFile(SECRET_FILE, 'utf8')).trim(); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (!secret) { secret = randomBytes(32).toString('base64url'); await writeFile(SECRET_FILE, secret, { mode: 0o600 }); }
}
let usersWrite = Promise.resolve();
function updateUsers(change) {
  const operation = usersWrite.then(async () => {
    const next = users.map(u => ({ ...u }));
    const result = change(next);
    await writeFile(USERS_FILE + '.tmp', JSON.stringify({ users: next }, null, 2) + '\n', { mode: 0o600 });
    await rename(USERS_FILE + '.tmp', USERS_FILE);
    users = next;
    return result;
  });
  usersWrite = operation.catch(() => {}); // a failed save must not block later attempts
  return operation;
}
const publicUser = u => ({ name: u.name, role: u.role, createdAt: u.createdAt ?? null, lastSignInAt: u.lastSignInAt ?? null });

function cookie(req, name) {
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith(name + '='));
  try { return c ? decodeURIComponent(c.slice(name.length + 1)) : ''; } catch { return ''; }
}
function sessionCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `tc_session=${value}; Path=/; HttpOnly; SameSite=Lax${maxAge != null ? `; Max-Age=${maxAge}` : ''}${secure}`;
}

/** The signed-in dashboard user, or null. DASHBOARD_PASSWORD over Basic auth still counts as an admin, for scripts and first setup. */
function requester(req) {
  const user = verifyToken(secret, users, cookie(req, 'tc_session'));
  if (user) return user;
  const h = req.headers.authorization || '';
  if (PASSWORD && h.startsWith('Basic ') && safeEqual(Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':'), PASSWORD)) return { name: 'password', role: 'admin' };
  return null;
}

async function signIn(req, res, body) {
  const name = String(body.name || '').trim();
  const user = await updateUsers(next => {
    const wait = throttle(failures, name);
    if (wait) throw fail(429, `Too many attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
    const user = next.find(u => u.name === name);
    if (!user || !verifyPassword(user, body.password)) {
      failures.get(name).push(Date.now());
      throw fail(401, "That name or password isn't right. Check them and try again.");
    }
    user.lastSignInAt = Date.now();
    return user;
  });
  const remember = !!body.remember;
  const ttl = remember ? SESSION_MS.remember : SESSION_MS.once;
  res.setHeader('set-cookie', sessionCookie(req, signToken(secret, user, Date.now() + ttl), remember ? ttl / 1000 : null));
  return { ok: true, user: publicUser(user) };
}

/** Admin-only, except `setup`, which creates the first admin while there are no accounts. */
async function accountAction(req, body) {
  return updateUsers(users => {
    const { action } = body;
    // Recheck after receiving the body and waiting for earlier saves. Only setup
    // may run without an admin, and it still validates the setup password below.
    if (action !== 'setup' && requester(req)?.role !== 'admin') throw fail(403, 'An admin sign-in is required.');
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!NAME.test(name)) throw fail(400, 'Name may use letters, digits, . _ @ + - (max 64).');
    if (['setup', 'add', 'reset'].includes(action) && password.length < 8) throw fail(400, 'Password needs at least 8 characters.');
    const idx = users.findIndex(u => u.name === name);
    if (action === 'setup') {
      if (users.length) throw fail(409, 'This dashboard already has accounts. Sign in as an admin to add more.');
      if (PASSWORD && !safeEqual(body.setupPassword || '', PASSWORD)) throw fail(403, "The setup password isn't right.");
      users.push({ name, role: 'admin', ...hashPassword(password), createdAt: Date.now() });
    } else if (action === 'add') {
      if (idx >= 0) throw fail(409, `There is already an account named ${name}.`);
      if (!ROLES.includes(body.role)) throw fail(400, `Role must be one of ${ROLES.join(', ')}.`);
      users.push({ name, role: body.role, ...hashPassword(password), createdAt: Date.now() });
    } else if (action === 'reset') {
      if (idx < 0) throw fail(404, `No account named ${name}.`);
      users[idx] = { ...users[idx], ...hashPassword(password) }; // new hash also signs them out everywhere
    } else if (action === 'remove') {
      if (idx < 0) throw fail(404, `No account named ${name}.`);
      if (users[idx].role === 'admin' && users.filter(u => u.role === 'admin').length === 1) throw fail(400, 'Keep at least one admin.');
      users.splice(idx, 1);
    } else {
      throw fail(400, `unknown action "${action}"`);
    }
    return { ok: true, users: users.map(publicUser) };
  });
}

// Reachable without signing in: the sign-in page and what it needs.
const OPEN = new Set(['/login', '/login.js', '/style.css', '/theme.js', '/api/session']);
const isOpen = pathname => OPEN.has(pathname) || pathname.startsWith('/lib/') || (pathname === '/api/accounts' && !users.length);

// ── http ────────────────────────────────────────────────────────────────────

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); } });
    req.on('error', reject);
  });
}

async function readAuthorizedBody(req, pathname) {
  const body = await readBody(req);
  const me = requester(req);
  if (!me) throw fail(401, 'sign in required');
  if (!allowed(me, req.method, pathname)) throw fail(403, 'Your role can only view the dashboard.');
  return body;
}

function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(payload);
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname === '/login' ? '/login.html' : pathname;
  const base = rel.startsWith('/lib/') ? ROOT : join(ROOT, 'public');
  const file = normalize(join(base, rel));
  if (!file.startsWith(base)) return send(res, 404, { error: 'not found' });
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    const body = await readFile(file);
    send(res, 200, body, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    });
  } catch { send(res, 404, { error: 'not found' }); }
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;
    // Same-origin only for anything that changes state: browsers always set
    // Origin on cross-site POSTs; curl sends none and stays allowed.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin request refused' });
    const me = requester(req);
    if (!me && !isOpen(pathname)) {
      if (req.method === 'GET' && !pathname.startsWith('/api/') && !extname(pathname)) { res.writeHead(302, { location: '/login' }); return res.end(); }
      return send(res, 401, { error: 'sign in required' });
    }
    if (me && pathname.startsWith('/api/') && pathname !== '/api/session' && !allowed(me, req.method, pathname)) return send(res, 403, { error: `Your role (${me.role}) can only view the dashboard.` });

    if (pathname === '/api/session') {
      if (req.method === 'GET') return send(res, 200, { user: me ? publicUser(me) : null, setup: !users.length, setupPassword: !!PASSWORD });
      if (req.method === 'POST') return send(res, 200, await signIn(req, res, await readBody(req)));
      if (req.method === 'DELETE') { res.setHeader('set-cookie', sessionCookie(req, '', 0)); return send(res, 200, { ok: true }); }
    }
    if (pathname === '/api/accounts') {
      if (req.method === 'GET') return send(res, 200, { users: users.map(publicUser) });
      if (req.method === 'POST') return send(res, 200, await accountAction(req, await readBody(req)));
    }
    if (req.method === 'GET' && pathname === '/api/status') return send(res, 200, await status());
    if (req.method === 'GET' && pathname === '/api/activity') {
      const since = Number(url.searchParams.get('since')) || 0;
      return send(res, 200, { ticks: ticks.filter(t => t.at >= since), pollMs: POLL_MS, retainMs: RETAIN_MS });
    }
    if (req.method === 'POST' && pathname === '/api/control') {
      const body = await readAuthorizedBody(req, pathname);
      const make = CONTROL[body.action];
      if (!make) return send(res, 400, { error: `unknown action "${body.action}"` });
      const [path, payload] = make(body);
      const r = await proxy('POST', path, payload);
      latestAt = 0;
      return send(res, r.status, r.json);
    }
    if (req.method === 'POST' && pathname === '/api/users') return send(res, 200, await userAction(await readAuthorizedBody(req, pathname)));
    if (req.method === 'POST' && pathname === '/api/login/start') {
      const { provider } = await readAuthorizedBody(req, pathname);
      if (!['anthropic', 'codex'].includes(provider)) return send(res, 400, { error: 'provider must be "anthropic" or "codex"' });
      return send(res, 200, startLogin(provider));
    }
    if (req.method === 'POST' && pathname === '/api/login/finish') {
      const { id, input } = await readAuthorizedBody(req, pathname);
      return send(res, 200, { ok: true, ...(await finishLogin(String(id || ''), input)) });
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(res, pathname);
  } catch (err) {
    const code = err.status || (err.name === 'TimeoutError' || err.cause?.code ? 502 : 500);
    const message = err.cause?.code === 'ECONNREFUSED' ? `cannot reach the proxy at ${PROXY_URL}` : err.message;
    if (code >= 500) console.error(`[dashboard] ${req.method} ${req.url}: ${message}`);
    return send(res, code, { ok: false, error: message });
  }
}

await loadTicks();
await loadUsers();
poll();
setInterval(poll, POLL_MS).unref();
http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`[dashboard] http://${HOST}:${PORT} → proxy ${PROXY_URL}, config ${getConfigPath()}, log ${ACTIVITY_FILE}, accounts ${USERS_FILE}`);
  if (!users.length) console.log(`[dashboard] no dashboard accounts yet: open /login to create the admin${PASSWORD ? ' (needs DASHBOARD_PASSWORD as the setup password)' : ' (set DASHBOARD_PASSWORD first if anyone else can reach this port)'}`);
});
