import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function dashboard(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-auth-'));
  const proxy = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accounts: [], clients: {}, ok: true }));
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyPort = proxy.address().port;
  const reservation = http.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ accounts: [], proxy: {} }));
  let child;
  let log = '';
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill();
      await done;
    }
  };
  t.after(async () => { await stop(); await new Promise(resolve => proxy.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DASHBOARD_DATA_DIR: dir,
        DASHBOARD_PASSWORD: 'setup-password', TEAMCLAUDE_CONFIG: join(dir, 'config.json'),
        TEAMCLAUDE_API_KEY: 'test', TEAMCLAUDE_URL: `http://127.0.0.1:${proxyPort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', b => { log += b; });
    child.stderr.on('data', b => { log += b; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(log);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/session`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Server did not start: ${log}`);
  };
  const request = async (path, body, cookie, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json().catch(() => null) };
  };
  await start();
  return { dir, port, request, restart: async () => { await stop(); await start(); } };
}

const admin = { name: 'admin', password: 'admin-password' };
async function setup(d) {
  assert.equal((await d.request('/api/accounts', { action: 'setup', ...admin, setupPassword: 'setup-password' })).status, 200);
  return (await d.request('/api/session', admin)).cookie;
}

test('first-admin setup cannot be bypassed with another account action or delayed body', async t => {
  const d = await dashboard(t);
  assert.equal((await d.request('/api/accounts', { action: 'add', ...admin, role: 'admin' })).status, 403);
  assert.equal((await d.request('/api/accounts', { action: 'setup', ...admin })).status, 403);
  assert.equal((await d.request('/api/session')).body.setup, true);
  const delayed = http.request(`http://127.0.0.1:${d.port}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  const response = new Promise((resolve, reject) => { delayed.on('response', r => { r.resume(); resolve(r.statusCode); }); delayed.on('error', reject); });
  delayed.flushHeaders();
  await setup(d);
  delayed.end(JSON.stringify({ action: 'add', name: 'intruder', password: 'password123', role: 'admin' }));
  assert.ok([401, 403].includes(await response));
  const stored = JSON.parse(await readFile(join(d.dir, 'users.json')));
  assert.deepEqual(stored.users.map(u => u.name), ['admin']);
});

test('malformed cookies do not terminate the server', async t => {
  const d = await dashboard(t);
  assert.equal((await d.request('/api/status', null, 'tc_session=%')).status, 401);
  assert.equal((await d.request('/api/capacity')).status, 401);
  assert.equal((await d.request('/api/session')).status, 200);
});

test('parallel sign-ins and account additions persist across restart', async t => {
  const d = await dashboard(t);
  const cookie = await setup(d);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.all([
    d.request('/api/session', admin),
    d.request('/api/accounts', { action: 'add', name: `viewer${i}`, password: 'viewer-password', role: 'viewer' }, cookie),
  ])));
  for (const r of results.flat()) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(JSON.parse(await readFile(join(d.dir, 'users.json'))).users.length, 11);
  await d.restart();
  const persisted = await d.request('/api/accounts', null, cookie);
  assert.equal(persisted.status, 200);
  assert.equal(persisted.body.users.length, 11);
});

test('roles, password resets, removals and session expiry options are enforced', async t => {
  const d = await dashboard(t);
  const cookie = await setup(d);
  assert.ok(!cookie.includes('Max-Age='));
  for (const role of ['operator', 'viewer']) {
    assert.equal((await d.request('/api/accounts', { action: 'add', name: role, password: 'role-password', role }, cookie)).status, 200);
    const signed = await d.request('/api/session', { name: role, password: 'role-password', remember: true });
    assert.match(signed.cookie, /Max-Age=2592000/);
    assert.equal((await d.request('/api/status', null, signed.cookie)).status, 200);
    assert.equal((await d.request('/api/capacity', null, signed.cookie)).status, 200);
    assert.equal((await d.request('/api/accounts', null, signed.cookie)).status, 403);
    assert.equal((await d.request('/api/control', { action: 'probe' }, signed.cookie)).status, role === 'viewer' ? 403 : 200);
    assert.equal((await d.request('/api/accounts', { action: 'reset', name: role, password: 'new-password' }, cookie)).status, 200);
    assert.equal((await d.request('/api/status', null, signed.cookie)).status, 401);
    const fresh = await d.request('/api/session', { name: role, password: 'new-password' });
    assert.equal(fresh.status, 200);
    assert.equal((await d.request('/api/accounts', { action: 'remove', name: role }, cookie)).status, 200);
    assert.equal((await d.request('/api/status', null, fresh.cookie)).status, 401);
  }
  assert.equal((await d.request('/api/accounts', { action: 'remove', name: admin.name }, cookie)).status, 400);
  const logout = await d.request('/api/session', null, cookie, 'DELETE');
  assert.equal(logout.status, 200);
  assert.match(logout.cookie, /Max-Age=0/);
});

test('a failed credential save leaves existing credentials valid and later saves recover', async t => {
  const d = await dashboard(t);
  const cookie = await setup(d);
  await mkdir(join(d.dir, 'users.json.tmp'));
  assert.equal((await d.request('/api/accounts', { action: 'reset', name: admin.name, password: 'replacement' }, cookie)).status, 500);
  assert.equal((await d.request('/api/status', null, cookie)).status, 200);
  await rm(join(d.dir, 'users.json.tmp'), { recursive: true });
  assert.equal((await d.request('/api/session', admin)).status, 200);
});

test('revoking an operator rejects mutations with bodies still in flight', async t => {
  const d = await dashboard(t);
  const cookie = await setup(d);
  await d.request('/api/accounts', { action: 'add', name: 'operator', password: 'operator-password', role: 'operator' }, cookie);
  const operator = await d.request('/api/session', { name: 'operator', password: 'operator-password' });
  const pending = ['/api/control', '/api/users', '/api/login/start', '/api/login/finish'].map(path => {
    const req = http.request(`http://127.0.0.1:${d.port}${path}`, { method: 'POST', headers: { cookie: operator.cookie, 'content-type': 'application/json' } });
    const response = new Promise((resolve, reject) => { req.on('response', r => { r.resume(); resolve(r.statusCode); }); req.on('error', reject); });
    req.flushHeaders();
    return { req, response };
  });
  assert.equal((await d.request('/api/accounts', { action: 'remove', name: 'operator' }, cookie)).status, 200);
  for (const { req, response } of pending) {
    req.end(JSON.stringify({ action: 'probe', provider: 'anthropic' }));
    assert.equal(await response, 401);
  }
});
