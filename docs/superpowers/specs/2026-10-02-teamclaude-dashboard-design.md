# Team Claude web dashboard — design

Date: 2026-10-02. Status: approved by default (built autonomously; revise freely).

## Purpose

A standalone web dashboard for the Team Claude proxy (`@karpeleslab/teamclaude`
1.1.x) that answers three questions in a glance: which accounts are broken or
blocked, which are close to their limit, and when capacity comes back. It also
lets the operator sign an account in again (Claude or Codex) without a terminal.
Audience: the NOMMA IT team hosting one proxy with ~7 pooled seats.

Not in scope: request/event logs, per-user policies, billing, multi-tenant auth.

## Data sources (all already exist in Team Claude)

- `GET /teamclaude/status` on the proxy: accounts, quota buckets (`unified5h`,
  `unified7d`, `unified7dFable`, resets, `seenAt`), status/unavailable reasons,
  cooldown timestamps, usage counters, routes, adaptive weights, server info.
- `POST /teamclaude/{switch,disable,probe,reload}` on the proxy.
- The config file (`~/.config/teamclaude.json`): token `expiresAt`, `source`,
  `planType` and the proxy `apiKey` the dashboard uses to call the proxy.
  Tokens are never sent to the browser.
- Team Claude's own modules, imported directly: `oauth.js` (profile fetch,
  token pair parsing, `parseAuthCode`), `codex-auth.js` (auth URL, code
  exchange), `identity.js` (upsert matching), `config.js` (locked atomic
  config update). The dashboard writes accounts exactly the way the CLI does.

## Research takeaways

Looked at devasheeshG/claude-code-proxy (accounts sorted "needs reauth first",
reauthenticate action on the card), CLIProxyAPI's management center (OAuth
start → poll/paste flow in the browser, per-credential health), and the usage
monitors (Claude-Code-Usage-Monitor, claude-code-statusline, Claude-Usage-Tracker):
separate meters per window with their own countdown, absolute and relative reset
time, threshold colouring with labels, "last known" staleness labels, missing
means unknown not zero. Taken: attention-first ordering, per-window meters with
countdowns, browser-driven OAuth with paste fallback, provenance/staleness.
Not taken: multi-page admin shells, databases, card grids.

## Design

Concept: a watch bill and tide table. Capacity returns on a schedule like a
tide; the hero is a timeline of when each account's windows reset, not a big
number.

Layout (single page, left-aligned, max width 1200px):

```
Team Claude · proxy up 1d 0h · 1.1.22            [Add account ▾] [Probe now]
Needs attention (1)
  omercer@nomma.net   account error — sign in again        [Sign in again]
When capacity returns              now ───────────────────────── +7 d
  ecaldwell  ──────────●  Weekly 72% · Sun 3:00 pm
  cdonovan   ────●         Weekly 87% · Fri 1:00 pm
Claude accounts (5)
  name · org · status | Session meter+reset | Weekly | Fable | usage | actions
Codex accounts (2)
  name · plan · status | Session | Weekly | usage | actions
```

Tokens: paper `#F6F7F5`, surface `#FFFFFF`, ink `#16222E`, secondary `#5B6670`,
hairline `#DDE2E1`, accent sea `#0E5A70`. Dark: plane `#0F1418`, surface
`#161C22`, ink `#F2F4F3`, secondary `#A7B0B6`, hairline `#262E34`, accent
`#4FA7BF`. Status (dataviz fixed palette, icon + label always): good `#0ca30c`,
warning `#fab219`, serious `#ec835a`, critical `#d03b3b`. Meter fill: accent
below 70%, warning 70–90%, critical ≥ 90%; track is a light step of the same
hue; a tick marks the switch threshold. Type: IBM Plex Sans (system fallback),
tabular figures only in the ledger columns.

## Architecture

- `server.js` — Node 22 `node:http`, no framework. Serves `public/` and:
  - `GET /api/status` → proxy status + per-account `{expiresAt, source,
    planType, hasRefreshToken}` from config.
  - `POST /api/control` `{action, account?, disabled?}` → forwarded to proxy.
  - `POST /api/login/start` `{provider}` → `{id, url}`; PKCE verifier kept in
    memory for 10 minutes.
  - `POST /api/login/finish` `{id, input}` → exchange code, upsert account into
    config (same matching as the CLI), `POST /teamclaude/reload`.
  - Optional HTTP Basic auth via `DASHBOARD_PASSWORD`.
- `lib/attention.js` — pure, shared by server tests and browser: derive
  attention items and meter rows from a status account.
- `public/index.html`, `app.js`, `style.css` — vanilla, no build step.
- Docker: `node:22-alpine`, `network_mode: host` (proxy binds loopback), config
  directory bind-mounted so Team Claude's atomic rename + lock work.

Sign-in flow in the browser: Claude uses the manual redirect
(`console.anthropic.com/oauth/code/callback`) so the user copies the code shown
on Anthropic's page. Codex only accepts `localhost:1455`, so the user copies the
address bar of the page they land on (it may fail to load) and pastes it; the
server parses `code` and `state` from it. Both are the same two-step dialog.

## Error handling

Proxy unreachable → banner with the URL tried, last good data kept and marked
stale. Login errors (state mismatch, exchange failure, rejected token) are shown
verbatim in the dialog. Config write failures are reported; nothing is saved
partially (Team Claude's atomic write).

## Testing

`node --test` on `lib/attention.js` and the login input parser. Manual: run
against the live proxy, screenshot light and dark, exercise sign-in dialog.
