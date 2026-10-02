// Team Claude dashboard server: static files + a thin API over the proxy's
// control plane and Team Claude's own login/config modules, plus a poller that
// turns the proxy's cumulative counters into a request log.
import http from 'node:http';
import { readFile, stat, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { loadConfig, atomicConfigUpdate, getConfigPath } from '@karpeleslab/teamclaude/src/config.js';
import { parseAuthCode, profileForCredentials, tokenPairFromResponse } from '@karpeleslab/teamclaude/src/oauth.js';
import { buildCodexAuthUrl, exchangeCodexCode } from '@karpeleslab/teamclaude/src/codex-auth.js';
import { oauthIdentityFields, findUpsertTarget, updateAccountEntry, canUpsertOAuthAccount, sameIdentity } from '@karpeleslab/teamclaude/src/identity.js';
import { tick } from './lib/activity.js';

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
let latest = null, latestAt = 0, pollError = null;
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

async function poll() {
  try {
    const next = await fetchStatus();
    const t = tick(latest, next);
    latest = next; latestAt = Date.now(); pollError = null;
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

// ── http ────────────────────────────────────────────────────────────────────

function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const given = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(given), b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); } });
    req.on('error', reject);
  });
}

function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(payload);
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
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
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;
  if (!authorized(req)) return send(res, 401, { error: 'password required' }, { 'www-authenticate': 'Basic realm="Team Claude dashboard"' });
  // Same-origin only for anything that changes state: browsers always set
  // Origin on cross-site POSTs; curl sends none and stays allowed.
  if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin request refused' });

  try {
    if (req.method === 'GET' && pathname === '/api/status') return send(res, 200, await status());
    if (req.method === 'GET' && pathname === '/api/activity') {
      const since = Number(url.searchParams.get('since')) || 0;
      return send(res, 200, { ticks: ticks.filter(t => t.at >= since), pollMs: POLL_MS, retainMs: RETAIN_MS });
    }
    if (req.method === 'POST' && pathname === '/api/control') {
      const body = await readBody(req);
      const make = CONTROL[body.action];
      if (!make) return send(res, 400, { error: `unknown action "${body.action}"` });
      const [path, payload] = make(body);
      const r = await proxy('POST', path, payload);
      latestAt = 0;
      return send(res, r.status, r.json);
    }
    if (req.method === 'POST' && pathname === '/api/users') return send(res, 200, await userAction(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/login/start') {
      const { provider } = await readBody(req);
      if (!['anthropic', 'codex'].includes(provider)) return send(res, 400, { error: 'provider must be "anthropic" or "codex"' });
      return send(res, 200, startLogin(provider));
    }
    if (req.method === 'POST' && pathname === '/api/login/finish') {
      const { id, input } = await readBody(req);
      return send(res, 200, { ok: true, ...(await finishLogin(String(id || ''), input)) });
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(res, pathname);
  } catch (err) {
    const code = err.status || (err.name === 'TimeoutError' || err.cause?.code ? 502 : 500);
    const message = err.cause?.code === 'ECONNREFUSED' ? `cannot reach the proxy at ${PROXY_URL}` : err.message;
    if (code >= 500) console.error(`[dashboard] ${req.method} ${pathname}: ${message}`);
    return send(res, code, { ok: false, error: message });
  }
}

await loadTicks();
poll();
setInterval(poll, POLL_MS).unref();
http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`[dashboard] http://${HOST}:${PORT} → proxy ${PROXY_URL}, config ${getConfigPath()}, log ${ACTIVITY_FILE}${PASSWORD ? '' : ' (no DASHBOARD_PASSWORD set: anyone who can reach this port can control the proxy)'}`);
});
