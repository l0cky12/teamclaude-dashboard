import { meters, severity, issues, sortForAttention, formatDuration, nextReset, remaining } from '/lib/attention.js';
import { tick, totals, select } from '/lib/activity.js';
import { usageReport } from '/lib/cost.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
};
const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : String(c));
  return el;
};

const pct = u => `${Math.round(u * 100)}%`;
const compact = n => n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const when = (ts, now) => {
  const d = new Date(ts);
  const far = ts - now > 6 * 86400e3;
  return d.toLocaleString(undefined, far ? { month: 'short', day: 'numeric', hour: 'numeric' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
const ago = (ts, now) => ts ? `${formatDuration(now - new Date(ts).getTime())} ago` : 'never';
const providerName = p => p === 'codex' ? 'Codex' : 'Claude';

let last = null;
let lastGoodAt = 0;

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) location.replace('/login'); // session ended: back to sign-in
  if (!res.ok) throw new Error(json.error?.message || json.error || `${res.status} ${res.statusText}`);
  return json;
}

// ── who is signed in ────────────────────────────────────────────────────────
const ROLE = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };
const initials = name => { const p = String(name).split('@')[0].split(/[._\-\s]+/).filter(Boolean); return ((p[0]?.[0] || '') + (p[1]?.[0] || p[0]?.[1] || '')).toUpperCase() || '?'; };
const remembered = () => { try { return JSON.parse(localStorage.getItem('tc-accounts')) || []; } catch { return []; } };
let me = null;

async function loadSession() {
  const s = await api('/api/session');
  if (!s.user) { location.replace('/login'); return; }
  me = s.user;
  document.body.classList.toggle('viewer', me.role === 'viewer');
  renderMe();
  if (me.role === 'admin') { await renderSignins(); } else {
    $('#signins-table').replaceChildren(h('p', { class: 'muted' }, 'Only admins can see and manage dashboard sign-ins.'));
  }
}

// Switching signs this account out first: one session per browser.
async function switchTo(hash) {
  await fetch('/api/session', { method: 'DELETE' });
  location.href = `/login${hash}`;
}

function renderMe() {
  $('#me').hidden = false;
  $('#me-av').textContent = initials(me.name);
  $('#me-name').textContent = me.name;
  const others = remembered().filter(a => a.name !== me.name);
  $('#me-list').replaceChildren(
    h('div', { class: 'hd' }, h('span', { class: 'av av-sm' }, initials(me.name)), h('div', {}, h('b', {}, me.name), h('span', { class: 'muted' }, `${ROLE[me.role] || me.role}${me.lastSignInAt ? `, signed in ${ago(me.lastSignInAt, Date.now())}` : ''}`))),
    h('p', { class: 'lbl' }, 'Switch to'),
    ...others.map(a => h('button', { type: 'button', class: 'acc', onclick: () => switchTo(`#account=${encodeURIComponent(a.name)}`) }, h('span', { class: 'av' }, initials(a.name)), h('b', {}, a.name), h('span', { class: 'muted role' }, ROLE[a.role] || a.role || ''))),
    h('button', { type: 'button', class: 'acc add', onclick: () => switchTo('#other') }, h('span', { class: 'av plus' }, '+'), h('b', {}, 'Use another account')),
    h('button', { type: 'button', class: 'out', onclick: () => switchTo('') }, 'Sign out'),
  );
}

// ── dashboard sign-ins (admins) ─────────────────────────────────────────────
async function renderSignins() {
  const { users } = await api('/api/accounts');
  $('#signin-add').hidden = false;
  const now = Date.now();
  $('#signins-table').replaceChildren(h('div', { class: 'ledger' },
    h('div', { class: 'srow head' }, h('div'), h('div', {}, 'Name'), h('div', { class: 'role' }, 'Role'), h('div', { class: 'when' }, 'Last sign-in'), h('div')),
    ...users.map(u => h('div', { class: 'srow' },
      h('span', { class: 'av' }, initials(u.name)),
      h('div', { class: 'name' }, u.name, u.name === me.name ? h('span', { class: 'muted' }, ' (you)') : null),
      h('div', { class: 'role' }, ROLE[u.role] || u.role),
      h('div', { class: 'when muted' }, u.lastSignInAt ? ago(u.lastSignInAt, now) : 'never'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { const p = prompt(`New password for ${u.name} (8+ characters). They will be signed out everywhere.`); if (p) signinAction({ action: 'reset', name: u.name, password: p }); } }, 'Reset password'),
        u.name === me.name ? null : h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm(`Remove ${u.name}'s sign-in? They are signed out immediately.`)) signinAction({ action: 'remove', name: u.name }); } }, 'Remove'),
      ),
    )),
  ));
}
async function signinAction(body) {
  const note = $('#signin-note');
  try {
    await api('/api/accounts', body);
    note.className = 'result good';
    note.textContent = body.action === 'add' ? `Added ${body.name}. Tell them their temporary password and ask them to have it reset once they are in.` : body.action === 'reset' ? `Password for ${body.name} reset.` : `Removed ${body.name}.`;
    await renderSignins();
  } catch (err) { note.className = 'result err'; note.textContent = err.message; }
}
$('#signin-add').addEventListener('submit', async e => {
  e.preventDefault();
  await signinAction({ action: 'add', name: $('#signin-name').value.trim(), role: $('#signin-role').value, password: $('#signin-pass').value });
  $('#signin-name').value = ''; $('#signin-pass').value = '';
});

async function refresh() {
  try {
    last = await api('/api/status');
    lastGoodAt = Date.now();
    $('#banner').hidden = true;
    render(last);
  } catch (err) {
    const b = $('#banner');
    b.hidden = false;
    b.textContent = `Cannot read the proxy: ${err.message}.${last ? ` Showing data from ${ago(lastGoodAt, Date.now())}.` : ''}`;
    if (last) render(last);
  }
}

function render(s) {
  const now = Date.now();
  const threshold = s.switchThreshold ?? 0.98;
  const accounts = s.accounts || [];
  const current = new Set(Object.values(s.currentAccounts || {}));

  const up = s.server?.uptimeSeconds != null ? formatDuration(s.server.uptimeSeconds * 1000) : null;
  $('#proxy-line').textContent = `Proxy ${s.server?.version || ''}, up ${up || '—'}. ${accounts.length} accounts, switching at ${pct(threshold)}.` + (s.server?.updateAvailable ? ' An update is available.' : '');

  renderBell(accounts, { now, threshold });
  renderLeft(accounts, now, threshold);
  renderTide(accounts, now, threshold);
  renderUsers(s, now);
  renderLog(s);
  renderCost(s);

  const ledger = $('#ledger');
  ledger.replaceChildren();
  for (const provider of ['anthropic', 'codex']) {
    const list = sortForAttention(accounts.filter(a => (a.provider || 'anthropic') === provider), { now, threshold });
    if (!list.length) continue;
    const cols = provider === 'codex' ? 2 : 3;
    const head = provider === 'codex' ? ['Session', 'Weekly'] : ['Session', 'Weekly', 'Per model'];
    ledger.append(h('section', { class: 'group' },
      h('h2', {}, `${providerName(provider)} accounts (${list.length})`),
      h('div', { class: 'ledger', style: `--cols:${cols}` },
        h('div', { class: 'lrow head' }, h('div', {}, 'Account'), ...head.map(t => h('div', {}, t)), h('div', {}, 'Usage'), h('div', {}, '')),
        ...list.map(a => renderRow(a, { now, threshold, cols, serving: current.has(a.name), adaptive: (s.adaptive || []).find(x => x.name === a.name) })),
      )));
  }
  if (!accounts.length) ledger.append(h('p', { class: 'muted' }, 'No accounts yet. Add a Claude or Codex account to start.'));

  $('#foot').textContent = `Updated ${new Date(now).toLocaleTimeString()}. Accounts are stored in ${s.dashboard?.configPath || ''}`;
}

function renderBell(accounts, opts) {
  const list = issues(accounts, opts);
  const count = $('#bell-count');
  count.hidden = !list.length;
  count.textContent = list.length;
  const label = list.length ? `${list.length} account${list.length === 1 ? '' : 's'} need${list.length === 1 ? 's' : ''} attention` : 'No account alerts';
  $('#bell summary').setAttribute('aria-label', label);
  if ($('#bell-live').dataset.n !== String(list.length)) { // announce changes only, not every refresh
    $('#bell-live').dataset.n = list.length;
    $('#bell-live').textContent = label;
  }
  // Keep keyboard focus while refreshing the alerts, including resolved accounts.
  const focusedAccount = $('#bell').contains(document.activeElement) ? document.activeElement.dataset.account : null; // provider:name, as one email can be both
  $('#bell-list').replaceChildren(
    h('h2', {}, list.length ? `${list.length} account${list.length === 1 ? ' has' : 's have'} a problem` : 'No problems'),
    ...(list.length ? list.map(({ account: a, items }) => h('div', { class: 'attn-item' },
      h('span', { class: `dot ${items[0].level}`, title: items[0].level }),
      h('div', {}, h('div', { class: 'who' }, a.name), ...items.map(i => h('div', { class: 'what' }, i.text))),
      me?.role !== 'viewer' && items.some(i => i.action === 'signin')
        ? h('button', { class: 'btn small primary', type: 'button', 'data-account': `${a.provider || 'anthropic'}:${a.name}`, onclick: () => openSignin(a.provider || 'anthropic', a.name) }, 'Sign in')
        : h('span'),
    )) : [h('p', { class: 'ok' }, h('span', { class: 'dot good' }), 'Every account is signed in and usable.')]),
  );
  if (focusedAccount != null) {
    const button = [...$('#bell-list').querySelectorAll('button')].find(b => b.dataset.account === focusedAccount);
    (button || $('#bell summary')).focus({ preventScroll: true });
  }
}

function renderLeft(accounts, now, threshold) {
  const groups = ['anthropic', 'codex'].map(provider => ({ provider, windows: remaining(accounts, provider, now) })).filter(g => g.windows.length);
  $('#left-groups').replaceChildren(...(groups.length ? groups.map(({ provider, windows }) => h('div', { class: 'left-group', style: `--n:${windows.length}` },
    h('h3', {}, `${providerName(provider)} subscriptions`),
    h('div', { class: 'left-tiles' }, ...windows.map(w => {
      const share = w.left / w.count;
      const sev = severity(1 - share, threshold);
      const title = w.accounts.map(a => `${a.name}: ${pct(a.left)} left${a.resetAt > now ? `, resets in ${formatDuration(a.resetAt - now)}` : ''}`).join('\n');
      return h('div', { class: 'left-tile', title },
        h('div', { class: 'line' }, h('span', { class: 'label' }, w.label), h('span', { class: 'muted' }, w.hint)),
        h('div', { class: `value ${sev}` }, `${pct(share)} left`),
        h('div', { class: 'track' }, h('div', { class: `fill ${sev}`, style: `width:${share * 100}%` })),
        h('div', { class: 'sub' }, `${w.left.toFixed(1)} of ${w.count} account${w.count === 1 ? '' : 's'} unused`),
        h('div', { class: 'sub' }, w.nextResetAt ? `next reset in ${formatDuration(w.nextResetAt - now)} (${w.nextResetAccount.replace(/@.*/, '')})` : 'nothing used yet'),
      );
    })),
  )) : [h('p', { class: 'muted' }, 'No quota reported yet. Refresh quotas to ask the proxy.')]));
}

function renderTide(accounts, now, threshold) {
  const root = $('#tide-chart');
  const rows = accounts.filter(a => !a.disabled).map(a => ({ a, marks: meters(a).filter(m => m.resetAt && m.resetAt > now) })).filter(r => r.marks.length);
  const W = Math.max(760, root.clientWidth || 1000), left = 190, right = 40, rowH = 40, top = 28;
  const H = top + Math.max(rows.length, 1) * rowH + 24;
  const span = 7 * 86400e3;
  const x = t => left + Math.min(1, Math.max(0, (t - now) / span)) * (W - left - right);
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Timeline of quota resets' });

  // day ticks at local midnights
  const d0 = new Date(now); d0.setHours(24, 0, 0, 0);
  for (let t = d0.getTime(); t < now + span; t += 86400e3) {
    el.append(svg('line', { class: 'axis', x1: x(t), x2: x(t), y1: top - 6, y2: H - 20 }));
    el.append(svg('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, new Date(t).toLocaleDateString(undefined, { weekday: 'short' })));
  }
  el.append(svg('line', { class: 'now', x1: left, x2: left, y1: top - 10, y2: H - 20 }));
  el.append(svg('text', { class: 'now-label', x: left + 6, y: top - 12 }, 'now'));
  el.append(svg('text', { x: W - right, y: top - 12, 'text-anchor': 'end' }, '+7 days'));

  if (!rows.length) el.append(svg('text', { class: 'empty', x: left + 12, y: top + rowH / 2 + 4 }, 'No reset times reported yet. Refresh quotas to ask the proxy.'));

  rows.sort((p, q) => nextReset(p.a, now) - nextReset(q.a, now));
  rows.forEach(({ a, marks }, i) => {
    const y = top + i * rowH + rowH / 2;
    const name = a.name.length > 22 ? `${a.name.slice(0, 21)}…` : a.name;
    el.append(svg('text', { class: 'name', x: left - 12, y: y + 4, 'text-anchor': 'end' }, name));
    el.append(svg('line', { class: 'lane', x1: left, x2: W - right, y1: y, y2: y }));
    const weekly = marks.filter(m => m.key !== 'unified5h');
    const sessions = marks.filter(m => m.key === 'unified5h');
    for (const m of [...sessions, ...weekly]) {
      const sev = severity(m.utilization, threshold);
      const hollow = m.key === 'unified5h';
      const cls = `mark${hollow ? ' hollow' : ''}${sev !== 'ok' ? ` ${sev}` : ''}`;
      const title = `${a.name} — ${m.label} ${pct(m.utilization)}, resets ${when(m.resetAt, now)} (in ${formatDuration(m.resetAt - now)})`;
      const mark = a.provider === 'codex'
        ? svg('rect', { class: cls, x: x(m.resetAt) - 5, y: y - 5, width: 10, height: 10 })
        : svg('circle', { class: cls, cx: x(m.resetAt), cy: y, r: hollow ? 4.5 : 5.5 });
      mark.append(svg('title', {}, title));
      el.append(mark);
    }
    // direct label for the window that matters most: the fullest weekly one
    const lead = weekly.sort((p, q) => q.utilization - p.utilization)[0] || sessions[0];
    if (lead) {
      const lx = x(lead.resetAt);
      const text = `${lead.label} ${pct(lead.utilization)}, ${when(lead.resetAt, now)}`;
      const anchorEnd = lx > W - right - 190;
      el.append(svg('text', { class: 'tag', x: anchorEnd ? lx - 12 : lx + 12, y: y + 4, 'text-anchor': anchorEnd ? 'end' : 'start' }, text));
    }
  });
  root.replaceChildren(el);
}

function renderRow(a, { now, threshold, cols, serving, adaptive }) {
  const ms = meters(a);
  const byKey = k => ms.find(m => m.key === k);
  const scoped = ms.filter(m => !['unified5h', 'unified7d'].includes(m.key));
  const slots = cols === 2 ? [byKey('unified5h'), byKey('unified7d')] : [byKey('unified5h'), byKey('unified7d'), scoped];
  const auth = a.auth || {};

  const badges = [];
  if (a.disabled) badges.push(h('span', { class: 'badge' }, 'paused'));
  else if (a.status === 'active' && !a.unavailable) badges.push(h('span', { class: 'badge good' }, 'active'));
  else badges.push(h('span', { class: `badge ${a.status === 'error' ? 'critical' : 'warning'}` }, a.unavailable || a.status || 'unknown'));
  if (serving) badges.push(h('span', { class: 'badge serving' }, 'serving now'));
  if (a.onExtraUsage) badges.push(h('span', { class: 'badge critical' }, 'on paid extra usage'));
  if (auth.expiresAt && auth.expiresAt < now) badges.push(h('span', { class: `badge ${auth.hasRefreshToken ? '' : 'critical'}` }, auth.hasRefreshToken ? 'token due for refresh' : 'sign-in expired'));

  const sub = a.provider === 'codex'
    ? `ChatGPT ${auth.planType || a.quota?.planType || ''}`.trim()
    : [a.orgName, tier(auth)].filter(Boolean).join(', ');

  const u = a.usage || {};
  const tokens = (u.totalInputTokens || 0) + (u.totalOutputTokens || 0) + (u.totalCacheReadTokens || 0) + (u.totalCacheCreationTokens || 0);

  return h('div', { class: `lrow${a.disabled ? ' disabled' : ''}` },
    h('div', { class: 'who' }, h('div', { class: 'name' }, a.name), h('div', { class: 'sub' }, sub), h('div', { class: 'badges' }, badges)),
    ...slots.map((m, i) => Array.isArray(m)
      ? (m.length ? h('div', {}, ...m.map(x => renderMeter(x, now, threshold, x.label))) : h('div', { class: 'meter none' }, 'Per model: not metered separately'))
      : renderMeter(m, now, threshold, i === 0 ? 'Session' : 'Weekly')),
    h('div', { class: 'usage' },
      h('div', {}, h('strong', {}, compact(u.totalRequests || 0)), ' requests'),
      h('div', {}, h('strong', {}, compact(tokens)), ' tokens'),
      h('div', {}, `last used ${ago(u.lastUsed, now)}`),
      a.sessions ? h('div', {}, `${a.sessions} active session${a.sessions === 1 ? '' : 's'}`) : null,
      adaptive?.weight != null ? h('div', {}, `routing share ${pct(adaptive.weight)}`) : null,
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn small', type: 'button', disabled: a.disabled || serving, onclick: () => control({ action: 'switch', account: a.name }) }, 'Use now'),
      h('button', { class: 'btn small', type: 'button', onclick: () => control({ action: 'disable', account: a.name, disabled: !a.disabled }) }, a.disabled ? 'Resume' : 'Pause'),
      h('button', { class: 'btn small', type: 'button', onclick: () => openSignin(a.provider || 'anthropic', a.name) }, 'Sign in again'),
    ),
  );
}

function tier(auth) {
  const r = String(auth.rateLimitTier || '').toLowerCase(), s = String(auth.seatTier || '').toLowerCase();
  if (r.includes('20x') || s === 'team_tier_2') return 'Max 20×';
  if (r.includes('5x') || s === 'team_tier_1') return 'Max 5×';
  if (s.includes('enterprise')) return 'Enterprise';
  if (s === 'team_standard') return 'Team';
  return null;
}

function renderMeter(m, now, threshold, label) {
  if (!m) return h('div', { class: 'meter none' }, `${label}: no data yet`);
  const sev = severity(m.utilization, threshold);
  const reset = m.resetAt && m.resetAt > now ? `resets in ${formatDuration(m.resetAt - now)}, ${when(m.resetAt, now)}` : m.resetAt ? 'reset time passed, awaiting update' : 'no reset time';
  const stale = m.seenAt && now - m.seenAt > 6 * 3600e3 ? h('span', { class: 'stale' }, `, seen ${ago(m.seenAt, now)}`) : null;
  return h('div', { class: 'meter', title: m.hint },
    h('div', { class: 'line' }, h('span', { class: `pct ${sev}` }, pct(m.utilization)), h('span', { class: 'muted' }, label || m.label)),
    h('div', { class: 'track' }, h('div', { class: `fill ${sev}`, style: `width:${Math.min(100, m.utilization * 100)}%` }), h('div', { class: 'tick', style: `left:${threshold * 100}%`, title: `switches at ${pct(threshold)}` })),
    h('div', { class: 'reset' }, reset, stale),
  );
}

async function control(body) {
  try { await api('/api/control', body); await refresh(); }
  catch (err) { const b = $('#banner'); b.hidden = false; b.textContent = `${body.action} failed: ${err.message}`; }
}

// ── sign-in dialog ──────────────────────────────────────────────────────────
const dlg = $('#signin');
let login = null;

const COPY = {
  anthropic: {
    title: 'Sign in to Claude',
    step1: 'Open the sign-in page in a new tab and approve access for Claude Code. Use the account you want to add or repair.',
    step2: 'Anthropic then shows an authorization code. Copy it and paste it here.',
  },
  codex: {
    title: 'Sign in to Codex (ChatGPT)',
    step1: 'Open the sign-in page in a new tab and approve access for the Codex CLI.',
    step2: 'Your browser is then sent to a localhost page that will probably not load. That is expected: copy the full address from the address bar and paste it here.',
  },
};

async function openSignin(provider, accountName) {
  const c = COPY[provider] || COPY.anthropic;
  $('#signin-title').textContent = accountName ? `${c.title} for ${accountName}` : c.title;
  $('#signin-step1').textContent = c.step1;
  $('#signin-step2').textContent = c.step2;
  $('#signin-input').value = '';
  const result = $('#signin-result'); result.textContent = ''; result.className = 'result';
  $('#signin-finish').disabled = false;
  $('#add-menu').open = false;
  $('#bell').open = false;
  dlg.showModal();
  try {
    login = await api('/api/login/start', { provider });
    $('#signin-link').href = login.url;
  } catch (err) {
    result.textContent = `Could not start sign-in: ${err.message}`; result.className = 'result err';
  }
}

$('#signin-copy').addEventListener('click', async () => {
  if (!login) return;
  try { await navigator.clipboard.writeText(login.url); $('#signin-copy').textContent = 'Copied'; setTimeout(() => { $('#signin-copy').textContent = 'Copy link'; }, 1500); } catch { prompt('Copy this link', login.url); }
});
$('#signin-cancel').addEventListener('click', () => dlg.close());
$('#signin-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!login) return;
  const result = $('#signin-result');
  const input = $('#signin-input').value.trim();
  if (!input) { result.textContent = 'Paste the code or address first.'; result.className = 'result err'; return; }
  $('#signin-finish').disabled = true;
  result.textContent = 'Exchanging the code and saving the account…'; result.className = 'result';
  try {
    const r = await api('/api/login/finish', { id: login.id, input });
    result.textContent = `${r.action === 'updated' ? 'Updated' : 'Added'} ${r.name}.${r.reloaded ? ' The proxy picked it up.' : ` Saved, but the proxy did not reload: ${r.reloadError}`}`;
    result.className = 'result good';
    login = null;
    await refresh();
    setTimeout(() => dlg.close(), 1800);
  } catch (err) {
    result.textContent = err.message; result.className = 'result err';
    $('#signin-finish').disabled = false;
  }
});
document.querySelectorAll('[data-signin]').forEach(b => b.addEventListener('click', () => openSignin(b.dataset.signin)));
$('#probe-btn').addEventListener('click', async () => {
  const btn = $('#probe-btn'); btn.disabled = true; btn.textContent = 'Refreshing…';
  await control({ action: 'probe' });
  btn.disabled = false; btn.textContent = 'Refresh quotas';
});
document.addEventListener('click', e => { for (const m of document.querySelectorAll('details.menu')) if (!m.contains(e.target)) m.open = false; });

// ── theme ───────────────────────────────────────────────────────────────────
const THEMES = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { t === 'system' ? localStorage.removeItem('theme') : localStorage.setItem('theme', t); } catch { /* ignore */ }
  $('#theme-btn').textContent = `Theme: ${t}`;
}
$('#theme-btn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || 'system';
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
});
$('#theme-btn').textContent = `Theme: ${document.documentElement.dataset.theme || 'system'}`;

// ── users (proxy client keys) ───────────────────────────────────────────────
function renderUsers(s, now) {
  const root = $('#users-table');
  const users = s.users || [];
  const usage = s.clients || {};
  if (!users.length && !Object.keys(usage).length) {
    root.replaceChildren(h('p', { class: 'muted' }, 'No users yet. Everyone is using the shared key, so usage cannot be told apart. Add a user to give them their own key.'));
    return;
  }
  const names = [...new Set([...users.map(u => u.name), ...Object.keys(usage)])].sort();
  const rows = names.map(name => {
    const u = usage[name] || {};
    const w24 = u.windows?.['24h'], w5 = u.windows?.['5h'];
    const has = users.some(x => x.name === name);
    return h('div', { class: 'urow' },
      h('div', {}, h('div', { class: 'name' }, name), h('div', { class: 'hint' }, has ? `key ${users.find(x => x.name === name).keyHint}` : 'key removed from config')),
      h('div', {}, h('strong', {}, compact(u.requests || 0)), ' requests'),
      h('div', {}, h('strong', {}, compact((u.inputTokens || 0) + (u.outputTokens || 0))), ' tokens'),
      h('div', {}, w24 ? `${compact(w24.requests)} req, ${compact((w24.inputTokens || 0) + (w24.outputTokens || 0))} tok` : '—'),
      h('div', {}, w5 ? `${compact(w5.requests)} req, ${compact((w5.inputTokens || 0) + (w5.outputTokens || 0))} tok` : '—'),
      h('div', { class: 'row' },
        has ? h('button', { class: 'btn small', type: 'button', onclick: () => userAction('rotate', name) }, 'New key') : null,
        has ? h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm(`Remove ${name}? Their key stops working immediately.`)) userAction('remove', name); } }, 'Remove') : null,
      ),
    );
  });
  root.replaceChildren(h('div', { class: 'ledger' },
    h('div', { class: 'urow head' }, h('div', {}, 'User'), h('div', {}, 'All time'), h('div', {}, ''), h('div', {}, 'Last 24 h'), h('div', {}, 'Last 5 h'), h('div', {}, '')),
    ...rows,
  ));
}

async function userAction(action, name) {
  const box = $('#user-key');
  try {
    const r = await api('/api/users', { action, name });
    if (r.key) {
      box.hidden = false;
      $('#user-key-text').textContent = `${action === 'rotate' ? 'New key' : 'Key'} for ${r.name}${r.reloaded ? '' : ` (saved, but the proxy did not reload: ${r.reloadError})`}`;
      $('#user-key-value').textContent = r.key;
      $('#user-key-copy').dataset.key = r.key;
    } else {
      box.hidden = true;
    }
    await refresh();
  } catch (err) {
    const b = $('#banner'); b.hidden = false; b.textContent = `${action} user failed: ${err.message}`;
  }
}
$('#user-add').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#user-name');
  const name = input.value.trim();
  if (!name) return;
  await userAction('add', name);
  input.value = '';
});
$('#user-key-copy').addEventListener('click', async e => {
  const key = e.currentTarget.dataset.key;
  try { await navigator.clipboard.writeText(key); e.currentTarget.textContent = 'Copied'; setTimeout(() => { e.currentTarget.textContent = 'Copy key'; }, 1500); } catch { prompt('Copy this key', key); }
});

// ── request log ─────────────────────────────────────────────────────────────
let ticks = [];
let ticksAt = 0;

async function loadActivity() {
  try {
    const r = await api('/api/activity');
    ticks = r.ticks || []; ticksAt = Date.now();
  } catch { /* keep what we have; the banner already reports proxy problems */ }
}

function renderLog(s) {
  const now = Date.now();
  const range = Number($('#log-range').value);
  const whoSel = $('#log-who');
  const names = [...new Set([...(s.users || []).map(u => u.name), ...Object.keys(s.clients || {}), ...(s.accounts || []).map(a => a.name)])];
  const current = whoSel.value;
  whoSel.replaceChildren(h('option', { value: '' }, 'everything'), ...names.map(n => h('option', { value: n }, n)));
  whoSel.value = names.includes(current) ? current : '';

  const shown = select(ticks, { since: now - range, who: whoSel.value || null }).slice().reverse();
  const pollS = Math.round((s.dashboard?.pollMs || 5000) / 1000);
  $('#log-note').textContent = `Each row is one ${pollS}-second poll of the proxy with activity in it: how many requests finished and how many tokens they used, by user and by account. Prompt contents are never recorded.`;

  const byUser = totals(shown, 'clients');
  const byAccount = totals(shown, 'accounts');
  const tiles = Object.entries(byUser).sort((a, b) => b[1].tokens - a[1].tokens).map(([name, t]) =>
    h('div', { class: 'tile' }, h('div', { class: 'label' }, name), h('div', { class: 'value' }, compact(t.tokens)), h('div', { class: 'sub' }, `tokens in ${compact(t.requests)} requests`)));
  const allReq = Object.values(byAccount).reduce((n, t) => n + t.requests, 0);
  const allTok = Object.values(byAccount).reduce((n, t) => n + t.tokens, 0);
  $('#log-summary').replaceChildren(
    h('div', { class: 'tile' }, h('div', { class: 'label' }, 'All accounts'), h('div', { class: 'value' }, compact(allTok)), h('div', { class: 'sub' }, `tokens in ${compact(allReq)} requests, cache included`)),
    ...tiles,
  );

  const fmtDelta = (obj, tok) => Object.entries(obj).map(([n, d], i) => {
    const parts = [d.requests ? `${d.requests} req` : null, tok(d) ? `${compact(tok(d))} tok` : null].filter(Boolean).join(', ');
    return h('span', { class: 'delta' }, i ? ', ' : '', h('b', {}, n.replace(/@.*/, '')), ` +${parts}`);
  });
  const rows = shown.slice(0, 200).map(t => h('div', { class: 'trow' },
    h('div', { class: 'time' }, new Date(t.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })),
    h('div', { class: 'cell-users' }, Object.keys(t.clients).length ? fmtDelta(t.clients, d => (d.inputTokens || 0) + (d.outputTokens || 0)) : h('span', { class: 'muted' }, 'shared key')),
    h('div', { class: 'cell-accounts' }, fmtDelta(t.accounts, d => d.tokens)),
    h('div', { class: 'num' }, compact(Object.values(t.accounts).reduce((n, d) => n + d.tokens, 0))),
  ));
  $('#log-table').replaceChildren(h('div', { class: 'ledger' },
    h('div', { class: 'trow head' }, h('div', {}, 'Time'), h('div', {}, 'User'), h('div', {}, 'Account'), h('div', { class: 'num' }, 'Tokens')),
    ...(rows.length ? rows : [h('div', { class: 'empty-note' }, ticks.length ? 'Nothing in this range.' : 'The log fills in as requests go through the proxy.')]),
  ));
  if (shown.length > 200) $('#log-table').append(h('p', { class: 'muted' }, `Showing the latest 200 of ${shown.length} rows. Narrow the range or pick a user.`));
}
$('#log-range').addEventListener('change', () => last && renderLog(last));
$('#log-who').addEventListener('change', () => last && renderLog(last));

// ── API cost estimate ───────────────────────────────────────────────────────
const usd = n => n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const usdRange = (lo, hi) => hi - lo < 0.005 ? usd(lo) : `${usd(lo)} – ${usd(hi)}`;
const MODEL_NAMES = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-fable-5-1': 'Claude Fable 5.1', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-4-5': 'Claude Haiku 4.5', codex: 'Codex, model split unknown', unknown: 'Logged before pricing' };
// what a priced-as-a-range Codex row was priced between
const modelHint = m => m.candidates?.length ? `priced as ${m.candidates.join(', ')}` : null;
const seg = id => $(`#${id} [aria-pressed="true"]`).dataset;
for (const id of ['cost-range', 'cost-by']) {
  $(`#${id}`).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $(`#${id}`).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    if (last) renderCost(last);
  });
}

function renderCost(s) {
  const now = Date.now();
  const range = seg('cost-range').range;
  let r, binMs = 0;
  if (range === 'all') {
    // The proxy's own cumulative counters, priced as one delta from zero.
    const all = tick({ accounts: (s.accounts || []).map(a => ({ name: a.name })) }, s, 0);
    r = usageReport(all ? [all] : [], { since: 0 });
  } else {
    binMs = Number(range) > 86400e3 ? 6 * 3600e3 : 3600e3;
    const since = now - Number(range);
    r = usageReport(ticks, { since, until: now, binMs });
  }
  const t = r.total;

  const ranged = t.costHigh - t.cost >= 0.005;
  $('#cost-hero').replaceChildren(usd(t.cost), ranged ? h('span', { class: 'hi' }, `up to ${usd(t.costHigh)}`) : '');
  const unpricedPct = t.tokens ? t.unpriced / t.tokens : 0;
  $('#cost-sub').textContent = [
    `${compact(t.requests)} requests across ${Object.keys(r.accounts).length} accounts`,
    unpricedPct ? `excludes ${unpricedPct < 0.001 ? 'under 0.1' : (unpricedPct * 100).toFixed(1)}% unpriced tokens` : null,
    ranged ? 'Codex priced as a range' : null,
    range === 'all' ? 'since the proxy started counting' : null,
  ].filter(Boolean).join(' · ');

  $('#cost-chart-title').textContent = range === 'all' ? 'Cost over time' : binMs === 3600e3 ? 'Hourly cost' : 'Cost per 6 hours';
  if (range === 'all') $('#cost-chart').replaceChildren(h('p', { class: 'muted chart-note' }, 'The request log keeps 7 days, so the all-time figure has no history to plot. Pick Past 24 h or 7 days for the chart.'));
  else renderCostChart(r.bins, binMs, now);

  const tile = (label, value) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
  $('#cost-totals').replaceChildren(
    tile('Processed tokens', compact(Math.round(t.tokens))),
    tile('Cache reads', compact(Math.round(t.cacheRead))),
    tile('Cache writes', compact(Math.round(t.cacheWrite))),
    tile('Uncached input', compact(Math.round(t.input))),
    tile('Output', compact(Math.round(t.output))),
    tile('Cache savings', usd(t.savings)),
  );

  const by = seg('cost-by').by;
  const priced = o => o.tokens && o.unpriced >= o.tokens ? null : o.cost;
  const order = (a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.tokens - a.tokens;
  const modelRows = ms => Object.entries(ms).map(([k, m]) => ({ name: MODEL_NAMES[k] || k, sub: modelHint(m), cost: priced(m), costHigh: m.costHigh, tokens: m.tokens })).sort(order);
  const entries = by === 'model'
    ? modelRows(r.models)
    : Object.entries(r.accounts).map(([k, a]) => {
      // older log rows don't record the provider, so the live account list wins
      const provider = (s.accounts || []).find(x => x.name === k)?.provider || a.provider;
      const models = modelRows(a.models);
      // one model row that is the whole account says nothing the account row doesn't
      const detail = models.length > 1 ? models : [];
      return { name: k, sub: [providerName(provider), models.length === 1 ? models[0].sub : null].filter(Boolean).join(' · '), cost: priced(a), costHigh: a.costHigh, tokens: a.tokens, requests: a.requests, detail };
    }).sort(order);
  const share = c => c == null ? '—' : t.cost ? `${(c / t.cost * 100).toFixed(1)}%` : '0%';
  const row = (e, cls = 'crow') => h('div', { class: cls },
    h('div', {}, h('div', { class: 'name' }, e.name), e.sub ? h('div', { class: 'hint' }, e.sub) : null),
    h('div', { class: `num${e.cost == null ? ' muted' : ''}` }, e.cost == null ? 'Unpriced' : usdRange(e.cost, e.costHigh)),
    h('div', { class: 'num muted' }, share(e.cost)),
    h('div', { class: 'num' }, compact(Math.round(e.tokens))),
    h('div', { class: 'num muted' }, e.requests != null ? compact(e.requests) : ''),
  );
  $('#cost-table').replaceChildren(h('div', { class: 'ledger' },
    h('div', { class: 'crow head' }, h('div', {}, by === 'model' ? 'Model' : 'Account'), h('div', { class: 'num' }, 'Cost'), h('div', { class: 'num' }, 'Share'), h('div', { class: 'num' }, 'Tokens'), h('div', { class: 'num' }, by === 'model' ? '' : 'Requests')),
    ...(entries.length ? entries.flatMap(e => [row(e), ...(e.detail || []).map(m => row(m, 'crow sub'))]) : [h('div', { class: 'empty-note' }, 'No traffic in this range yet.')]),
  ));
}

function renderCostChart(bins, binMs, now) {
  const root = $('#cost-chart');
  const W = Math.max(320, root.clientWidth || 640), H = 220, left = 52, right = 8, top = 10, bottom = 24;
  const max = Math.max(...bins.map(b => b.costHigh));
  const ranged = bins.some(b => b.costHigh - b.cost >= 0.005);
  // round the axis up to a 1/2/5 step so gridlines land on readable values
  const step = (() => { const raw = (max || 1) / 4, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map(m => m * p).find(v => v >= raw); })();
  const yMax = step * 4;
  const x = i => left + (bins.length > 1 ? i / (bins.length - 1) : 0.5) * (W - left - right);
  const y = v => top + (1 - v / yMax) * (H - top - bottom);
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${$('#cost-chart-title').textContent}, peak ${usd(max)}` });
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    el.append(svg('line', { class: 'grid', x1: left, x2: W - right, y1: y(v), y2: y(v) }));
    el.append(svg('text', { x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, usd(v)));
  }
  const label = at => new Date(at).toLocaleString(undefined, binMs === 3600e3 ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  for (const i of [0, Math.floor((bins.length - 1) / 2), bins.length - 1]) {
    el.append(svg('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === bins.length - 1 ? 'end' : 'middle' }, label(bins[i].at)));
  }
  const pts = bins.map((b, i) => `${x(i)},${y(b.cost)}`).join(' ');
  el.append(svg('polygon', { class: 'area', points: `${x(0)},${y(0)} ${pts} ${x(bins.length - 1)},${y(0)}` }));
  el.append(svg('polyline', { class: 'line', points: pts }));
  if (ranged) el.append(svg('polyline', { class: 'line high', points: bins.map((b, i) => `${x(i)},${y(b.costHigh)}`).join(' ') }));
  const cross = svg('line', { class: 'cross', y1: top, y2: H - bottom, visibility: 'hidden' });
  const dot = svg('circle', { class: 'dot', r: 4, visibility: 'hidden' });
  const hit = svg('rect', { class: 'hit', x: left, y: top, width: W - left - right, height: H - top - bottom });
  el.append(cross, dot, hit);

  const tip = h('div', { class: 'tip', hidden: true });
  const show = e => {
    const box = el.getBoundingClientRect();
    const px = (e.clientX - box.left) * (W / box.width);
    const i = Math.max(0, Math.min(bins.length - 1, Math.round((px - left) / (W - left - right) * (bins.length - 1))));
    const b = bins[i];
    for (const [k, v] of [['x1', x(i)], ['x2', x(i)]]) cross.setAttribute(k, v);
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(b.cost));
    cross.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    const end = Math.min(b.at + binMs, now);
    const accts = Object.entries(b.accounts).sort((p, q) => q[1].costHigh - p[1].costHigh);
    tip.replaceChildren(...[
      h('div', { class: 'when' }, `${new Date(b.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} – ${new Date(end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`),
      ...accts.slice(0, 6).map(([n, c]) => h('div', { class: 'kv' }, h('span', {}, n.replace(/@.*/, '')), h('span', {}, usdRange(c.cost, c.costHigh)))),
      accts.length > 6 ? h('div', { class: 'kv muted' }, h('span', {}, `${accts.length - 6} more`), h('span', {}, '')) : null,
      h('div', { class: 'kv total' }, h('span', {}, 'Total'), h('span', {}, usdRange(b.cost, b.costHigh))),
    ].filter(Boolean));
    tip.hidden = false;
    const fx = x(i) / W * box.width;
    tip.style.left = `${fx > box.width / 2 ? fx - tip.offsetWidth - 12 : fx + 12}px`;
    tip.style.top = `${top / H * box.height}px`;
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
  root.replaceChildren(el, tip);
}

// ── pages ───────────────────────────────────────────────────────────────────
function showPage() {
  const page = ['overview', 'capacity', 'logs'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('[data-page]').forEach(el => { el.hidden = el.dataset.page !== page; });
  document.querySelectorAll('[data-tab]').forEach(a => (a.dataset.tab === page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (last) render(last); // charts measure their container, which is 0 wide while hidden
}
window.addEventListener('hashchange', () => { showPage(); scrollTo(0, 0); });
let resizeTimer, renderedWidth = innerWidth;
// width only: mobile address bars fire resize on scroll, and re-rendering resets open selects
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (innerWidth !== renderedWidth && last) { renderedWidth = innerWidth; render(last); } }, 150); });
showPage();

await loadSession();
await loadActivity();
refresh();
setInterval(async () => { await loadActivity(); refresh(); }, 10_000);
