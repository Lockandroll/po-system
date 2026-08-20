# Nova — Project Context

**Nova** is the internal operations platform for **Lock and Roll LLC**, a Pop-A-Lock franchise.
It is a single-page web app plus a Node/Express API on PostgreSQL, deployed on Railway.

This file is the source of truth for how the codebase actually works. If something here
disagrees with a spec doc, a comment, or a chat message, trust this file and the code.
See `ARCHITECTURE.md` for the full reference (route-by-route, job-by-job, table-by-table).

> **Repo name vs product name.** The repo, the npm package and the deploy are all still
> called `po-system`, because Nova started life as a purchase-order tool. Purchase orders
> are now roughly 1% of it. Do not rename anything — just know the two names mean the
> same thing.

---

## 1. Read this before you touch anything

These are the rules that cost real money when broken. Most of them are not obvious from
the code.

### 1.1 Windows corrupts backticks in `.js` files

Editing a `.js` file **through a Windows editor, clipboard paste, or PowerShell heredoc**
can silently mangle backtick characters. A file that looked fine in the editor then fails
to parse on Railway, and the deploy is down.

The rule is **not** "backticks are illegal" — several files legitimately use template
literals (`routes/offboarding.js`, `utils/completionPacket.js`, `jobs/offboarding.js`,
`db.js`, `public/js/offboarding.js`). The rule is:

- **House style is string concatenation.** New code in `.js` should avoid backticks so
  the hazard never applies. Most files carry a comment saying so.
- **If you must paste a `.js` file containing backticks, use the GitHub web editor**, not
  a Windows tool.
- **Always run `node --check <file>` after editing a `.js` file** and before pushing.
  There is no build step and no CI syntax gate, so `node --check` is the only thing
  standing between a mangled paste and a broken production deploy.

To check the whole repo at once:

```bash
find . -path ./node_modules -prune -o -path ./_to_delete -prune -o -path ./mobile -prune -o -name '*.js' -print \
  | xargs -n1 node --check
```

### 1.2 Apostrophes inside HTML strings

The frontend builds HTML by concatenating strings into `innerHTML`. A raw `'` inside an
HTML attribute breaks the markup. Use the HTML entity:

```js
// wrong
html += "<button onclick=\"go('Let's go')\">";
// right
html += "<button onclick=\"go('Let&#39;s go')\">";
```

### 1.3 Bump `CACHE_VERSION` in `public/sw.js` on every frontend change

`public/sw.js` holds `var CACHE_VERSION = 'nova-vNNN';`. That string is the **single
source of truth for the app version**:

- The service worker pre-caches the app shell under that key, so **if you don't bump it,
  users keep running the old `app.js` from cache.**
- `server.js` reads it from disk at boot and serves it at `GET /api/version`, which feeds
  the version badge in the sidebar.

Current value: **`nova-v333`**. Bump it whenever anything under `public/` changes.

### 1.4 `initDB()` is the only migration mechanism, and it is idempotent

`db.js` (5,037 lines) runs on every boot. It contains **167 `CREATE TABLE IF NOT EXISTS`**
statements and **400 `ALTER TABLE`** statements. There is no migration tool, no version
table, and no down-migrations.

- `CREATE TABLE IF NOT EXISTS` **does not add columns to a table that already exists.**
  Adding a column to an existing table means adding an `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS` alongside it. `db.js` says this in five separate comments because it has bitten
  people five times.
- Everything must be safe to run repeatedly, on a database that may be at any prior state.
- A failure in `initDB()` is logged and **non-fatal** — the server still listens. So a
  broken migration shows up as runtime query errors, not as a boot failure.

### 1.5 New modules ship dark

Several modules are deployed but reachable by nobody. `utils/permissions.js` builds
`ALL_PERMS` (112 permissions today); a permission that appears in `ALL_PERMS` but in
neither `EMPLOYEE_PERMS` nor any role's `DEFAULTS` is invisible to every role except
`admin`/`owner` until someone ticks the box in **Settings → Roles & Access** (or grants it
to one person via `users.extra_perms`).

Currently shipped dark: all of Dispatch (`view_dispatch`, `manage_dispatch`,
`assign_dispatch`), the Phase 2A/2B dispatch stack (`manage_service_types`,
`manage_dispatch_tags`, `view_call_views`, `search_dispatch*`, `view_customer_pii`,
`manage_pricing`, `manage_coverage`), tech pay (`manage_pay_grades`, `view_pay_report`,
`view_own_pay`), A/R (`view_ar`, `manage_ar`, `ar_writeoff`), Accounts Payable
(`view_ap`, `manage_ap`), inbound/outbound sync (`view_sync`, `manage_sync`,
`pulsar_write` — the webhook token in `manage_sync` is close to admin, so it stays
admin/owner-only by design, not just by omission) and the IVR check-in stack
(`manage_ivr_profiles`, `override_checkin` — `checkin_job` itself *is* in
`EMPLOYEE_PERMS`, deliberately, but ships inert until an admin writes a phone
profile for the account).

**Do not add a new permission to `DEFAULTS` or `EMPLOYEE_PERMS` as part of building a
feature.** That is a separate, deliberate go-live decision.

### 1.6 Two routers are mounted before `express.json()` — on purpose

`routes/inbound.js` (Resend inbound email/SMS webhooks) and `routes/square.js` (Square POS
callback + webhook) both verify a signature computed over the **raw** request body. They
are mounted in `server.js` **above** `app.use(express.json(...))` so the body is still
raw when they see it. Moving them breaks signature verification silently — the webhook
just starts 401ing.

Because they sit above the `/api/` rate limiter too, each has its own limiter.

### 1.7 `_to_delete/` is scratch, not code

`_to_delete/` holds ~40,000 lines of superseded staged files from past sessions. It is
gitignored. Never read it for reference and never wire anything to it — it is stale by
definition. Same for anything named `*.bak-*`.

---

## 2. Stack

| Layer | What | Notes |
|---|---|---|
| Runtime | Node ≥ 18 (`engines`) | Railway picks the version; local dev is on 22 |
| API | Express 4 + `express-async-errors` | one global error handler in `server.js` |
| DB | PostgreSQL via `pg` Pool | Railway Postgres; no SSL when the host is `*.railway.internal` |
| Auth | `jsonwebtoken` + `bcryptjs` | 24h rolling JWT, SMS 2FA |
| Security | `helmet`, `cors`, `express-rate-limit`, `compression` | CSP and strict CORS are both **opt-in via env** |
| Scheduling | `node-cron` | 24 modules in `jobs/`, all started from `server.js` after `initDB()` |
| Files | `@aws-sdk/client-s3` + `s3-request-presigner` | Cloudflare R2, browser↔R2 direct via presigned URLs |
| PDF | `pdfkit` (generate), `pdf-lib` (flatten/stamp) | invoices, sign-offs, dispute packets, signatures |
| Excel | `exceljs` | royalty statements |
| Push | `web-push` (VAPID) | web/desktop push |
| Frontend | Vanilla JS, classic `<script>` tags | **no framework, no bundler, no build step** |
| Mobile | Capacitor Android shell in `mobile/` | built by `.github/workflows/android-workflow.yml` |

**There is no build step, no automated test suite, and no linter.** `npm start` runs
`node server.js`. A handful of `test*.js` scripts at the repo root (§3) exercise specific
features by hand against a real Postgres — they are not run in CI and nothing fails a
push if they'd fail. The only automated check in the repo is the Android workflow. This
is why §1.1's `node --check` habit matters so much.

---

## 3. Repo layout

Line counts are JS/HTML/CSS only, excluding `node_modules`, `.git` and `_to_delete`.
**Total: 105,502 lines** (checked against commit `7ee1064`, 2026-08-20).

```
po-system/
  server.js                 531    Express app: helmet/CORS/limiters, 74 router mounts, job startup
  db.js                   5,037    pool + initDB() — 167 CREATE TABLE, 400 ALTER TABLE
  package.json                     no build/test scripts; start = node server.js
  .env.example                     documented env vars (see §7 for the gaps)

  routes/       65 files  33,339    one Express router per domain (see ARCHITECTURE.md §5)
  utils/        50 files  14,454    integrations + shared logic (email, sms, r2, square, goto, pay, pricing…)
  lib/           2 files   2,482    novaTools.js (AI tool registry), diag.js
  jobs/         24 files   4,661    node-cron schedules
  middleware/    1 file      210    auth.js — requireAuth / requireRole / requirePermission
  scripts/       2 files     263    one-off ops scripts (backout_pto_grant.js, ap_selftest.js)
  test*.js       6 files   2,576    ad-hoc verification scripts at repo root (check-in, IVR sim,
                                     outbound + DOM variants); not wired to CI — see §2

  public/                 41,949    the entire frontend, served static
    index.html             1,032    shell + inline styles; loads the 17 modules below in order
    js/app.js             28,224    the app: state, api(), navigate/render, 119 render* screens
    js/*.js       16 more           per-module screens (see §5)
    sw.js                     142   service worker + CACHE_VERSION (the app version)
    vendor/leaflet/                vendored Leaflet for the maps
    addin/                         Outlook add-in taskpane

  mobile/android/                   Capacitor Android shell
  unified-addin/                    Outlook add-in assets
  outlook-addin-manifest.xml
  .github/workflows/android-workflow.yml
```

**Docs in the repo:** `README.md` (setup + deploy), `ARCHITECTURE.md` (deep reference),
this file, plus per-feature specs — `INVOICES_SPEC.md`, `OFFBOARDING_IMPLEMENTATION.md`,
`OFFBOARDING_API_QUICK_REFERENCE.md`, `EMAIL_TO_TASK_SETUP.md`, `NOVA_VOICE_SETUP.md`,
`ROYALTY_MODULE_BUILD.md`, `AP_MODULE_SETUP.md`, `SYNC_RECEIVER.md`, `PULSAR_OUTBOUND.md`,
`mobile/README.md`. Feature specs describe *intent at the time they were written* and may
lag the code.

---

## 4. Backend: how a request works

```
request
  → helmet (CSP off unless CSP_ENABLED=true; frameguard applied manually so Outlook can iframe /addin)
  → X-Frame-Options SAMEORIGIN, except /addin* and /api/addin*
  → compression
  → cors (logs unapproved origins; only BLOCKS them when CORS_STRICT=true)
  → /api/inbound and /api/square  ← mounted here, before express.json, for raw-body signatures
  → express.json({ limit: '80mb' })
  → express.static(public)
  → rate limiters: /api/* 200/min · login+2FA+forgot 10/15min · vault gate 20/15min · oauth 3 tiers
  → router (routes/*.js)
      → requireAuth              (middleware/auth.js)
      → requirePermission(perm)
      → handler
  → /api/* unknown → JSON 404
  → * → public/index.html (SPA catch-all)
  → global error handler → 500 { error: 'Internal server error' }
```

### `requireAuth` does more than verify a token

`middleware/auth.js` is only 210 lines but it is the most load-bearing file in the repo.
On every authenticated request it:

1. Verifies the `Bearer` JWT.
2. Confines **add-in tokens** (90-day, `payload.addin`) to the `/api/addin/*` surface.
3. Does **one** users read, shared by every gate below (`req._userRow`).
4. **Fails closed**: a DB read error → `503`; a missing user row → `401`.
5. Enforces deactivation (`active = false` → 401 on the very next request).
6. Enforces **session revocation** via `users.session_epoch` vs the token's `se` claim —
   a password reset or forced sign-out invalidates every older token.
7. Enforces the **onboarding gate**: a hire mid-onboarding can reach only `/api/auth`,
   `/api/onboarding`, `/api/push`, and `/api/timeclock` *in phase 2 only* (phase 1 is
   unpaid paperwork).
8. Enforces the **offboarding gate**: once offboarding starts, only auth, timeclock, PTO
   and push.
9. Takes the authoritative role from the **DB row**, never the JWT claim.
10. Re-signs a fresh token into the `X-New-Token` response header (rolling expiry:
    24h, 30d with remember-me, 90d for add-in tokens).
11. Sets `X-Perms-Rev` — a hash of role + `extra_perms` + active + the global role matrix.
    The client compares it and refetches permissions when it moves, so an admin's
    permission change lands on the user's next click instead of their next login.
12. Sets `X-Min-Version` from the `client_min_version` setting, which lets a deploy force
    stale clients to hard-reset caches and reload.
13. Supports **View-As**: an admin can preview another user's real data read-only via the
    `X-View-As` header. Writes are refused while previewing, and an admin cannot
    impersonate an `owner`.

### Authorization

`utils/permissions.js` owns RBAC. The matrix lives in `settings.role_permissions` as JSON
and is cached for 15s.

- `admin` and `owner` always pass every check. `owner` is coerced to `admin` for
  authorization but keeps `isOwner` (the Vault is owner-only).
- Roles: `admin`, `owner`, `manager`, `locksmith`, `locksmith_coordinator`, `dispatcher`,
  `roadside_technician`. `DEFAULTS` in `utils/permissions.js` is the fallback when a role
  has no saved entry.
- `users.extra_perms` (`TEXT[]`) grants one capability to one person without changing
  their role. Checked only when the role itself lacks it.
- Route gate: `requirePermission('view_x')`. Several modules layer extra scoping *inside*
  the handler — `routes/assets.js` scopes managers to their own cities, `routes/feedback.js`
  to the cities they manage, `routes/offboarding.js` and `routes/onboarding.js` to their
  supervisor tree.

---

## 5. Frontend: how the SPA works

**`public/index.html` is no longer the whole frontend.** It is a 1,032-line shell that
loads 17 classic scripts in a fixed order:

```
app.js  vault.js  pto.js  onboarding.js  offboarding.js  ptt.js  nova-voice.js
native.js  location.js  dispatch.js  callSearch.js  timeCodes.js  coverage.js  pay.js  ar.js
ap.js  sync.js
```

These are **classic scripts, not modules.** Everything is global by design, because
`app.js` contains **839 inline `onclick=` handlers** that need to resolve global function
names. Consequences a newcomer will hit:

- A module can call anything `app.js` defines with `function foo()` or `var foo`.
- Top-level `const`/`let` in `app.js` are **not** reachable from the other files (they are
  script-scoped, not on `window`). If a later module needs a value, it has to be `var` or
  a function.
- Load order matters. `app.js` must be first; any module using `api()`, `state` or `can()`
  depends on it.
- Those 839 inline handlers are also why **CSP is off by default** — a policy without
  `'unsafe-inline'` takes the entire UI down. `CSP_ENABLED=true` turns on a policy that
  still allows inline script but pins everything else.

### `app.js` core pieces

| Piece | What it does |
|---|---|
| `state` | the whole client state: user, token, current view, caches |
| `api(method, path, body)` | fetch wrapper. GETs are cached with stale-while-revalidate and deduped in-flight; any non-GET busts the cache. Handles `X-New-Token`, `X-Perms-Rev`, `X-Min-Version`, and 401 → login |
| `navigate(view, param)` | sets `state.currentView`, pushes history, persists to localStorage, calls `render()` |
| `render()` | dispatches to one of 119 `render*` functions in `app.js` (138 across all modules) |
| `navModel()` | builds the sidebar from `can(...)` checks — the nav *is* the permission map |
| `can(perm)` | client-side permission check (cosmetic only; the server is authoritative) |
| `icons` / `NAVI` | inline SVG icon set |

### The per-module files

| File | Lines | Owns |
|---|---|---|
| `app.js` | 28,224 | everything not listed below |
| `onboarding.js` | 1,678 | locked new-hire track + admin path builder |
| `sync.js` | 1,323 | inbound webhook sources, event log, replay (see `SYNC_RECEIVER.md`) |
| `dispatch.js` | 1,302 | dispatch board + "ready to accept calls" duty toggle |
| `ptt.js` | 1,294 | Zello-style push-to-talk radio (LiveKit) |
| `location.js` | 924 | tech location card + dispatcher Live Map (Leaflet) |
| `pto.js` | 681 | time off: requests, approvals, ledger |
| `vault.js` | 646 | owner-only zero-knowledge credential vault (all crypto in-browser) |
| `offboarding.js` | 587 | offboarding wizard, templates, public exit form, insights |
| `pay.js` | 568 | tech pay grades and the pay report |
| `ar.js` | 541 | A/R aging, per-account ledger, payment import |
| `ap.js` | 473 | Accounts Payable: bills, due dates, payment marking (see `AP_MODULE_SETUP.md`) |
| `timeCodes.js` | 417 | per-location pricing windows and ETAs |
| `callSearch.js` | 359 | call history with PII masking |
| `native.js` | 238 | Capacitor bridge: background GPS, external links, disclosure |
| `coverage.js` | 233 | coverage zones (zip lists today, polygons later) |
| `nova-voice.js` | 220 | voice-in-the-radio: listens for `nova-ptt-talk`, no wake word |

---

## 6. Data model

~165 tables, all created in `db.js`. Grouped by domain:

- **Identity** `users`, `cities`, `user_cities`, `settings`, `audit_logs`, `password_resets`, `two_factor_codes`, `trusted_devices`, `push_subscriptions`, `user_grid_prefs`
- **Purchasing** `purchase_orders`, `po_line_items`, `running_list_items`, `parts`, `vendors`, `shipping_addresses`, `ap_bills`, `ap_bill_attachments`
- **Sales** `quotes`, `quote_line_items`, `quote_photos`, `invoices`, `invoice_line_items`, `invoice_photos`, `invoice_payments`, `invoice_refunds`, `invoice_refund_lines`, `square_orphan_payments`
- **Dispatch** `dispatch_jobs`, `dispatch_job_events`, `dispatch_job_views`, `dispatch_tags`, `dispatch_job_tags`, `service_categories`, `service_types`, `user_service_categories`, `tech_duty`, `tech_duty_log`, `tech_locations`, `location_pings`
- **Pricing & coverage** `location_services`, `service_time_codes`, `account_service_prices`, `coverage_zones`, `coverage_zone_zips`, `geocode_cache`
- **Pay & A/R** `pay_grades`, `pay_rows`, `ar_payments`, `ar_payment_lines`, `ar_adjustments`, `ar_import_batches`, `ar_import_lines`
- **Fleet** `vehicles`, `vehicle_repairs`, `vr_line_items`, `vehicle_inspections`, `inspection_items`, `inspection_photos`, `inspection_checklist`
- **People** `time_entries`, `time_breaks`, `time_week_approvals`, `holidays`, `shifts`, `shift_positions`, `shift_events`, `pto_requests`, `pto_ledger`, `pto_request_days`, `pto_cancellations`
- **On/offboarding** `onboarding_steps`, `onboarding_progress`, `onboarding_quiz_attempts`, `onboarding_packet_responses`, `onboarding_events`, `hr_documents`, `offboardings`, `offboarding_templates`, `offboarding_template_steps`, `offboarding_steps`, `offboarding_events`, `exit_interviews`, `exit_interview_questions`, `exit_interview_answers`
- **Work** `tasks`, `task_subtasks`, `task_activity`, `task_attachments`, `task_cc`, `task_templates`, `task_template_steps`, `work_orders`, `work_order_attachments`, `work_order_activity`, `work_order_nte_history`, `work_order_dead_emails`, `signoff_forms`, `signoff_photos`, `suggestions`
- **Customers** `customer_feedback`, `customer_feedback_activity`, `customer_feedback_attachments`, `review_assignments`, `review_rating_snapshots`, `geico_surveys`, `feedback_call_recordings`
- **Docs & signing** `documents`, `document_folders`, `document_shares`, `sop_documents`, `sop_chunks`, `signature_requests`, `signature_signers`, `signature_fields`, `signature_events`, `signature_templates`
- **Money in** `deposits`, `deposit_receipts`, `deposit_expenses`, `pulsar_imports`, `pulsar_cash_calls`, `royalty_statements`
- **Integrations** `goto_oauth`, `goto_calls`, `goto_webhook`, `goto_pending_media`, `oauth_clients`, `oauth_codes`, `oauth_refresh_tokens`, `ai_conversations`, `ai_usage`, `ai_monthly_usage`
- **Sync, messaging & IVR** (new since 2026-08-05, see `SYNC_RECEIVER.md` / `PULSAR_OUTBOUND.md`) `webhook_sources`, `webhook_events`, `webhook_event_stats`, `webhook_rejections`, `outbound_calls`, `scheduled_messages`, `scheduled_message_sends`, `ivr_profiles`, `checkin_events`, `job_runs`
- **Vault** `vault_members`, `vault_entries`, `vault_challenges`
- **Assets** `asset_types`, `assets`, `asset_stock`, `asset_stock_moves`, `asset_transfers`, `asset_transfer_lines`, `asset_holdings`, `asset_kits`, `asset_kit_items`, `asset_acknowledgments`, `asset_ack_lines`, `asset_requests`, `asset_request_lines`, `asset_request_photos`

Conventions worth knowing: PTO is stored in **hours** (8h = 1 day); time-clock timestamps
are always set by the **server** (`NOW()`), never the client; A/R balance is **derived from
a view**, never stored; refunds **append** rows rather than editing the invoice, so the
signed original stays byte-for-byte intact.

---

## 7. Environment

The code reads **117** environment variables; `.env.example` documents **93** of them —
drifted **24** behind again since the 2026-08-05 catch-up (the AP, sync/webhook, and IVR
modules each read their own env block and none of it made it into `.env.example` yet).
Several were already live in Railway while being undocumented here, so **check Railway
before assuming a feature is unconfigured, and check the drift command below before
assuming `.env.example` is current.**

If you add a `process.env.X` read, add it to `.env.example` in the same commit. To find
drift later:

```bash
diff <(grep -rahoE 'process\.env\.[A-Z0-9_]+' --include='*.js' routes utils jobs lib middleware db.js server.js \
        | sed 's/process.env.//' | sort -u) \
     <(grep -ahoE '^[A-Z0-9_]+=' .env.example | sed 's/=//' | sort -u)
```

Two env flags are **staged rollouts you should not flip blind**:

- `CORS_STRICT` — off by default. Unapproved origins are logged and written to the audit
  log as `cors_blocked` but still allowed. Watch the log for a week, add anything real to
  `CORS_ORIGINS`, *then* turn it on.
- `CSP_ENABLED` / `CSP_REPORT_ONLY` — turn report-only on first and read what it would
  have blocked.

---

## 8. Deploying

Railway auto-deploys from `main` on GitHub (`Lockandroll/po-system`). There is no staging
environment and no CI gate on the Node code.

**Before you push:**

1. `node --check` every `.js` file you touched (§1.1).
2. Bump `CACHE_VERSION` in `public/sw.js` if anything under `public/` changed (§1.3).
3. If you added a column, confirm there is an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   next to the `CREATE TABLE`, not just the create (§1.4).
4. If you added a permission, confirm it is **not** in `DEFAULTS`/`EMPLOYEE_PERMS` unless
   going live is the intent (§1.5).

**After the deploy:** open the app and check the version badge in the sidebar matches the
`CACHE_VERSION` you pushed. If it doesn't, the deploy hasn't landed or the SW hasn't
updated.

---

## 9. Conventions

- **String concatenation over template literals** in `.js` (§1.1). `&#39;` for apostrophes
  in HTML strings (§1.2).
- **Comments carry the *why*.** This codebase is unusually well commented and the comments
  are load-bearing — many record a decision ("Tony's call", "raised from 500 because…")
  that is not recoverable from the code. Keep that up: when you make a non-obvious choice,
  write down why, not what.
- **Fail closed** on auth and permission paths. There are several deliberate examples in
  `middleware/auth.js` and `utils/permissions.js`; match them.
- **Every knob goes in the `settings` table**, not a constant, so behaviour can change
  without a deploy.
- **Audit anything that moves money or access** via `utils/audit.js` → `logAudit()`, and
  security events via `utils/security.js` → `record()`.
- **New route module?** Create `routes/<domain>.js`, `module.exports = router`, and mount it
  in `server.js` under `/api/<domain>`. Gate every route with `requireAuth` plus a
  `requirePermission`.
- **Uploads never pass through the API.** Presign with `utils/r2.js` and let the browser
  talk to R2 directly (`POST .../upload-url` → PUT to R2 → `POST .../confirm`).

---

## 10. Known rough edges

Honest list, so nobody wastes an afternoon rediscovering these:

- **`routes/invoices.js` contains two raw NUL bytes** (lines ~2451 and ~2456) used as a
  string key separator. It parses and runs fine. As of this file's current size, plain
  `grep` no longer flags it as binary — the earlier `-a` workaround isn't necessary
  anymore, but don't count on that staying true as the file changes size again.
- **`public/js/app.js` is 28,224 lines** and holds 119 screens. It is the main source of
  merge pain. New screens should go in their own `public/js/<module>.js` and be added to
  both `index.html` and `sw.js`'s `SHELL_ASSETS`.
- **No automated tests, no linter, no CI on the Node code.** The `test*.js` scripts at
  the repo root are manual, not CI-run. `node --check` is the whole automated safety net.
- **`server.js` uses `app.get('*', ...)` for the SPA catch-all, which only works on
  Express 4.** The lockfile pins 4.22.2. Upgrading to Express 5 throws at boot on that
  line (path-to-regexp no longer accepts a bare `*`) — the replacement is a plain
  `app.use((req, res) => ...)` fallback. Don't bump Express casually.
- **`.env.example` drifts easily** — it was 25 variables behind the code until 2026-08-05,
  and as of this update it's **24 behind again** (§7). Add new `process.env` reads to it
  in the same commit (§7 has a one-liner that finds drift).
- **Feature spec `.md` files at the repo root may lag the implementation.** They are
  design records, not documentation of current behaviour.
- **`_to_delete/`** is stale scratch (§1.7).
