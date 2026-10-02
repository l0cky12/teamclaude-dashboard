// Sign-in page: first visit, choose a remembered account, enter password,
// use another account. Remembered accounts live in localStorage (name, role,
// last sign-in); the session itself is an HttpOnly cookie set by the server.
const $ = sel => document.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
};
const KEY = 'tc-accounts';
const ROLE = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const save = list => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable: nothing is remembered */ } };
const initials = name => { const p = String(name).split('@')[0].split(/[._\-\s]+/).filter(Boolean); return ((p[0]?.[0] || '') + (p[1]?.[0] || p[0]?.[1] || '')).toUpperCase() || '?'; };

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `${res.status} ${res.statusText}`), { status: res.status });
  return json;
}

const session = await api('GET', '/api/session');
if (session.user && !location.hash) location.replace('/');

function remember(user) {
  save([{ name: user.name, role: user.role, at: Date.now() }, ...load().filter(a => a.name !== user.name)]);
}
const show = id => ['first', 'choose', 'password'].forEach(s => { $('#s-' + s).hidden = s !== id; });
const showError = (el, input, message) => { el.textContent = message; el.hidden = false; input.classList.add('bad'); input.value = ''; input.focus(); };
const clearError = (el, input) => { el.hidden = true; input.classList.remove('bad'); };

// ── first visit / use another account / server setup ───────────────────────
function showFirst(mode) {
  const setup = mode === 'setup';
  $('#first-back').hidden = mode !== 'other';
  $('#first-title').textContent = setup ? 'Create the admin account' : mode === 'other' ? 'Use another account' : 'Sign in';
  $('#first-sub').textContent = setup ? 'This dashboard has no accounts yet. The first one is the admin.' : mode === 'other' ? "Sign in with a name that isn't saved here yet." : 'No accounts are saved on this device yet.';
  $('#first-setup-wrap').hidden = !(setup && session.setupPassword);
  $('#first-pass').autocomplete = setup ? 'new-password' : 'current-password';
  $('#first-go').textContent = setup ? 'Create account and sign in' : 'Sign in';
  $('#first-help').hidden = setup;
  $('#first-name').value = ''; $('#first-pass').value = '';
  clearError($('#first-err'), $('#first-pass'));
  show('first');
  $('#first-name').focus();
}
$('#s-first').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#first-name').value.trim(), password = $('#first-pass').value, rem = $('#first-remember').checked;
  try {
    if (session.setup) await api('POST', '/api/accounts', { action: 'setup', name, password, setupPassword: $('#first-setup').value });
    const r = await api('POST', '/api/session', { name, password, remember: rem });
    if (rem) remember(r.user);
    location.replace('/');
  } catch (err) { showError($('#first-err'), $('#first-pass'), err.message); }
});

// ── choose an account ───────────────────────────────────────────────────────
let removing = false;
function showChoose(list) {
  $('#choose-list').replaceChildren(
    ...list.map(a => h('button', { type: 'button', class: 'acc', onclick: () => { if (removing) { save(load().filter(x => x.name !== a.name)); route(); } else location.hash = `#account=${encodeURIComponent(a.name)}`; } },
      h('span', { class: 'av' }, initials(a.name)), h('b', {}, a.name), h('span', { class: 'muted role' }, ROLE[a.role] || a.role || ''),
      removing ? h('span', { class: 'remove' }, 'Remove') : h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'))),
    h('button', { type: 'button', class: 'acc add', onclick: () => { location.hash = '#other'; } }, h('span', { class: 'av plus' }, '+'), h('b', {}, 'Use another account')),
  );
  $('#choose-remove').textContent = removing ? 'Done' : 'Remove an account from this device';
  show('choose');
}
$('#choose-remove').addEventListener('click', e => { e.preventDefault(); removing = !removing; route(); });

// ── enter your password ─────────────────────────────────────────────────────
let chosen = null;
function showPassword(acc) {
  chosen = acc;
  $('#pw-av').textContent = initials(acc.name);
  $('#pw-name').textContent = acc.name;
  $('#pw-role').textContent = ROLE[acc.role] || acc.role || '';
  $('#pw-user').value = acc.name;
  $('#pw-pass').value = '';
  clearError($('#pw-err'), $('#pw-pass'));
  show('password');
  $('#pw-pass').focus();
}
$('#s-password').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/session', { name: chosen.name, password: $('#pw-pass').value, remember: $('#pw-keep').checked });
    remember(r.user); // refreshes role and last sign-in
    location.replace('/');
  } catch (err) {
    showError($('#pw-err'), $('#pw-pass'), err.status === 401 ? "That password isn't right. Check it and try again." : err.message);
  }
});

// ── routing ─────────────────────────────────────────────────────────────────
function route() {
  const list = load();
  if (session.setup) return showFirst('setup');
  if (location.hash.startsWith('#account=')) {
    const acc = list.find(a => a.name === decodeURIComponent(location.hash.slice(9)));
    if (acc) return showPassword(acc);
  }
  if (location.hash === '#other' || !list.length) return showFirst(location.hash === '#other' && list.length ? 'other' : 'first');
  showChoose(list);
}
window.addEventListener('hashchange', () => { removing = false; route(); });
route();
