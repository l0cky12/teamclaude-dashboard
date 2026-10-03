# Dashboard sign-in and account switching — design

Date: 2026-10-02. Status: approved (mockups reviewed in chat; two-step flow chosen).

## Purpose

Replace the browser's HTTP Basic auth prompt with a real sign-in page where each
person has their own dashboard account, and let a device remember several
accounts so switching between them is one click. Roles keep viewers from
changing anything.

Not in scope: linking dashboard accounts to proxy keys, multiple concurrent
sessions per browser, password self-service (admins reset passwords).

## The flow (approved mockups)

1. **First visit on a device** with nothing remembered: name + password form.
   When the server has no accounts at all, the same screen creates the first
   admin and asks for the setup password (`DASHBOARD_PASSWORD`) if one is set.
2. **Choose an account**: boxed list of accounts remembered on this device
   (initials, name, role), plus "Use another account" and "Remove an account
   from this device".
3. **Enter your password**: the chosen account in a box with "Change", password
   field, "Keep me signed in on this device" (30 days; otherwise the session
   ends with the browser).
4. **Wrong password**: same screen, error under the field, field cleared and
   refocused.
5. **Use another account**: name + password with "Remember this account".
6. **Switching inside the dashboard**: an avatar button in the header opens a
   menu with the current account, "Switch to" the other remembered accounts
   (jumps to step 3 for that account), "Use another account", and "Sign out".
   Switching signs the current account out first; one session per browser.

Remembered accounts live in the browser's `localStorage` (name, role, last
sign-in). Nothing secret is stored there.

## Server

- **Users file** `DASHBOARD_DATA_DIR/users.json`: `{ users: [{ name, role,
  hash, salt, createdAt, lastSignInAt }] }`. Passwords hashed with scrypt.
  Roles: `admin` (everything, including dashboard accounts), `operator`
  (account and proxy actions), `viewer` (read-only). GET is open to every
  signed-in role; `POST /api/accounts` and `/api/session/*` admin actions need
  `admin`; every other POST needs `admin` or `operator`.
- **Session cookie** `tc_session`, HttpOnly, SameSite=Lax: `name.exp.sig`
  where `sig` is HMAC-SHA256 over name, expiry and a fingerprint of the user's
  password hash, keyed by a random secret in `DASHBOARD_DATA_DIR/secret`.
  Stateless, survives restarts, and a password reset or removal invalidates it.
- **Endpoints**: `GET /api/session` (who am I, whether setup is needed),
  `POST /api/session` (sign in; 401 on bad password, 429 after 5 failures for
  a name in 15 minutes), `DELETE /api/session` (sign out), `POST /api/accounts`
  (`add`, `reset`, `remove`, `setup`).
- **Unauthenticated**: `/login`, its script, `style.css`, `theme.js`, `/lib/*`
  and `/api/session` are open. Everything else on `/api/*` answers 401 JSON;
  pages redirect to `/login`. `DASHBOARD_PASSWORD` in `Authorization: Basic`
  still works as an admin fallback for scripts and for first setup.

## Client

- `public/login.html` + `public/login.js`: the five screens above, driven by
  `location.hash` (`#other`, `#account=<name>`) and the remembered list.
- `public/app.js`: on 401 go to `/login`; header avatar menu; "Dashboard
  accounts" section on Logs & users (list, add with role and temporary
  password, reset password, remove) for admins. Non-admins see no management
  controls and viewers see the action buttons disabled.

## Testing

`node --test` on `lib/auth.js` (hash/verify, token sign/verify, tamper, expiry,
fingerprint change). Manual end to end against the mock proxy with the
headless browser, screenshots of every screen in light and dark for the PR.
