# Nova — Architecture Reference

Companion to `CLAUDE.md`. That file has the rules and the shape; this one has the
inventory. Read `CLAUDE.md` first — the gotchas there will save you more time than
anything here.

Everything below was derived from the code, not from the older spec documents.

---

## 1. Boot sequence

`server.js` (387 lines) does exactly two things: build the Express app, and start the
cron jobs.

```
1. dotenv, then require the 20 job modules up front
2. app.set('trust proxy', 1)              ← Railway sits in front; rate limits key on the real IP
3. helmet(...)                            ← CSP off unless CSP_ENABLED; frameguard off (see §2)
4. manual X-Frame-Options SAMEORIGIN      ← skipped for /addin* and /api/addin*
5. optional helmet.contentSecurityPolicy  ← only when CSP_ENABLED=true
6. compression()
7. cors(...)                              ← allowlist + Office origins; only enforced when CORS_STRICT=true
8. app.use('/api/inbound', routes/inbound)     ← BEFORE express.json (raw body for Svix signature)
9. app.use('/api/square', squareLimiter, routes/square)  ← BEFORE express.json (raw body for Square signature)
10. express.json({ limit: '80mb' })
11. express.static('public')
12. read CACHE_VERSION out of public/sw.js → APP_VERSION; expose GET /api/version
13. rate limiters (see §3)
14. 60 router mounts under /api/* (from 57 route modules — see §5)
15. OAuth limiters + app.use('/', routes/oauth)   ← lives on '/', not '/api', so it needs its own limiters
16. /api/* fallthrough → JSON 404
17. GET * → public/index.html   (SPA catch-all)
18. global error handler → 500 { error: 'Internal server error' }
19. app.listen(PORT)
20. initDB().then(start all 26 cron starters)   ← errors here are logged, NOT fatal
```

Note the order of 19 and 20: **the server starts listening before the database is
migrated**, and a migration failure does not stop it. A bad `db.js` change surfaces as
query errors on live traffic, not as a failed deploy.

---

## 2. Security posture

Nova had no security headers at all before 2026-08. Three helmet defaults are overridden,
each for a concrete reason documented in `server.js`:

| Override | Why |
|---|---|
| `contentSecurityPolicy: false` | `app.js` has 761 inline `onclick` handlers. A CSP without `'unsafe-inline'` takes the whole UI down. Opt in with `CSP_ENABLED=true`; the opt-in policy still allows inline script but pins script/frame/form destinations. Use `CSP_REPORT_ONLY=true` first. |
| `frameguard: false` | Helmet's `SAMEORIGIN` default would stop Outlook from rendering the add-in taskpane, which Office loads in an iframe from `outlook.office.com`. `X-Frame-Options` is instead applied manually to everything **except** `/addin*` and `/api/addin*`. |
| `crossOriginResourcePolicy: 'cross-origin'` | The add-in pulls its own icons and assets; the `same-origin` default blocks them. |

HSTS is on with `includeSubDomains: false` — deliberately, because a forgotten
non-HTTPS subdomain under `popalockar.com` would be very hard to un-break (browsers cache
HSTS for the full max-age).

CORS is a **two-stage rollout**. By default every origin is allowed, but each unapproved
one is logged once per boot and written to the audit log as a `cors_blocked` event. Setting
`CORS_STRICT=true` starts actually blocking. Requests with no `Origin` header are always
allowed — that covers the Resend webhook, the Square webhook and callback, and the Railway
health check.

---

## 3. Rate limits

| Scope | Window | Max |
|---|---|---|
| `/api/*` (general) | 1 min | 200 |
| `/api/auth/login`, `/api/auth/verify-2fa`, `/api/auth/forgot-password` | 15 min | 10 |
| `/api/vault/challenge`, `/api/vault/verify-gate` | 15 min | 20 |
| `/api/square/*` | 1 min | 120 |
| `/oauth/register` | 1 hour | 10 |
| `/oauth/authorize` | 15 min | 20 |
| `/oauth/token` | 15 min | 120 |

The OAuth limiters exist because `/oauth/*` sits on `/`, not `/api/`, so the general
limiter never saw it — until 2026-08 those endpoints (one of which is an unauthenticated
password prompt, another of which creates a permanent DB row by protocol design) had no
limit at all.

---

## 4. Authentication

### Login

1. `POST /api/auth/login` — verifies the password, generates a 6-digit code, stores it in
   `two_factor_codes`, sends it by **SMS** (Twilio) if the user has a phone and
   `receive_sms`, else by **email** (Resend). Returns `{ requires2fa: true, userId, via }`.
2. Frontend shows the 2FA screen (`renderTwoFactor` in `app.js`).
3. `POST /api/auth/verify-2fa` — validates the code, returns the JWT.
4. Every authenticated response carries a **fresh** token in `X-New-Token`; `api()` in
   `app.js` picks it up transparently. Rolling expiry: 24h normally, 30d with remember-me,
   90d for Outlook add-in tokens.

Trusted devices (`GET/DELETE /api/auth/trusted-devices`) let a user skip 2FA on a known
device. `POST /api/auth/setup` only works while the users table is empty — that is the
first-run admin creation. `GET /api/auth/setup-needed` tells the frontend which screen to
show.

### Token claims and the gates they trigger

| Claim | Effect |
|---|---|
| `id`, `email`, `name`, `role` | identity; `role` is **re-read from the DB** each request and the claim is ignored for authorization |
| `se` | session epoch. Mismatch with `users.session_epoch` → 401. Bumped by password reset and forced sign-out |
| `onb` | user was mid-onboarding when the token was minted → re-check status in DB, apply the onboarding whitelist |
| `nt` | minted by `lib/novaTools.js` when the AI calls back into the API — subject to the same onboarding gate, so a hire cannot reach the whole API through the assistant |
| `addin` | Outlook add-in token; confined to `/api/addin/*`, 90-day expiry, exempt from the deactivation and offboarding gates |
| `remember` | 30-day rolling expiry instead of 24h |

### Response headers the client reacts to

| Header | Client behaviour (`app.js`) |
|---|---|
| `X-New-Token` | store it; this is how sessions stay alive |
| `X-Perms-Rev` | if it changed, refetch permissions and re-render — held back if the user is mid-form, then applied on their next navigation |
| `X-Min-Version` | if this build is older, flush caches and reload. If the invoice editor is dirty, save the draft and *offer* the reload instead of taking it |

---

## 5. Route inventory

`routes/` holds **58 files and every one is mounted.** 57 of them mount under `/api/*`
across **60 prefixes**, because three modules export a second router:

| Extra mount | Comes from | Why |
|---|---|---|
| `/api/sign` | `signatures.publicRouter` | the signer's page needs no JWT |
| `/api/quiz-take` | `quiz.publicRouter` | quiz links are token-gated, not session-gated |
| `/api/exit-interviews` | `offboarding.exitInterviewRouter` | separate permission surface from offboarding itself |

The 58th file, `routes/oauth.js`, is mounted at `/` rather than `/api` because the OAuth
metadata paths are fixed by RFC. That is also why it needs its own rate limiters (§3).

Prefixes below are relative to `/api` unless noted.

### Core / identity

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/auth` | `auth.js` | 448 | login + SMS 2FA, password reset, first-run setup, trusted devices, `GET /me` |
| `/users` | `users.js` | 559 | user CRUD, new-hire creation, deactivate/reactivate/unlock/force-signout, org placement, CSV import, invites (tokens stored hashed) |
| `/cities` | `cities.js` | 91 | city list + per-user city scoping |
| `/settings` | `settings.js` | 66 | key/value company settings. A small whitelist (logo, company display fields, `role_permissions`, min-version) is readable by any authenticated user; everything else needs `manage_settings` |
| `/audit` | `audit.js` | 129 | audit log, security summary, emergency lockdown |
| `/dashboard` | `dashboard.js` | 99 | home-screen stats — ~8 independent reads fired concurrently with `Promise.all` |
| `/suggestions` | `suggestions.js` | 129 | employee suggestion box |
| `/push` | `push.js` | 36 | VAPID key + subscribe/unsubscribe |

### Purchasing

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/pos` | `pos.js` | 578 | purchase orders: draft → submit → approve/reject → order → tracking |
| `/running` | `running.js` | 204 | monthly requisition list; pushes into a PO |
| `/parts` | `parts.js` | 284 | parts catalog, markup, bulk import, duplicate check |
| `/vendors` | `vendors.js` | 159 | vendors/accounts. Read needs `view_vendors` **or** `manage_vendors`; read-only callers get credentials stripped in the handler |
| `/addresses` | `addresses.js` | 59 | shipping addresses per city |

### Sales and billing

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/quotes` | `quotes.js` | 530 | quotes + photos; push-to-PO. A line is labor or a part, and anything unrecognised is treated as a part |
| `/invoices` | `invoices.js` | 2,410 | the biggest router. Invoices, line items, required photos, signature capture, VIN/ID/plate scanning, Square payment collection and reconciliation, splits, dispute packets, parts-used report. Settled statuses **freeze** the invoice — changes go through refunds |
| `/refunds` | `refunds.js` | 1,164 | append-only refunds. A refund is never an edit; the signed original stays byte-for-byte intact, which is what the Square dispute packet relies on. Request → approve → send to Square |
| `/deposits` | `deposits.js` | 345 | cash deposits, receipts, expenses, AI extraction from photos |
| `/pulsar` | `pulsar.js` | 581 | imports the Pulsar "Call Search" CSV for a pay week and reconciles cash-collected calls against what each tech deposited |
| `/royalty` | `royalty.js` | 459 | Pop-A-Lock royalty & ad-fund statements per city, stored as re-exportable history (`.xlsx` via `exceljs`, plus the original CSV) |
| `/ar` | `ar.js` | 468 | A/R aging, per-account terms and ledger, payments, adjustments, staged imports, statements. **Balance is derived from a view, never stored.** Nothing moves money until Post, and an unmatched line is never auto-applied |

### Dispatch (Phase 1 live-dark, Phase 2A/2B shipped dark)

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/dispatch` | `dispatch.js` | 891 | the board, duty ("ready to accept calls"), job create/assign/status/cancel/tags, click-to-call. Techs here do **not** punch a clock — the duty toggle decides board visibility, availability, and whether location is stored at all. No automatic overnight clear (nights are a real shift); the board reports hours-on-duty instead. Geocodes the address on create via `utils/geocode.js` and writes `lat`/`lon`/`geocode_accuracy`/`zone_id` |
| `/service-types` | `serviceTypes.js` | 191 | service catalog + categories + call tags + per-user skill categories. The category is load-bearing in three places (who sees the call, which pay row applies, which price row matches), which is why deleting is not offered — only deactivating |
| `/call-search` | `callSearch.js` | 286 | call **history** including done/GOA/cancelled, which the board never shows. Three widening permissions decide the rows (own / city / all); customer names and addresses are masked **in the query**, and the CSV export reads the same masked projection |
| `/time-codes` | `timeCodes.js` | 293 | per-service, per-location windows of the week carrying a price and three ETAs (public/account/EDU), plus account price exceptions. A save is **refused** if the week has a gap or an overlap |
| `/coverage` | `coverage.js` | 187 | coverage zones. Zip lists today, polygons once a geocoder is fully switched on. **Zones may not overlap** — enforced in the router, not the DB, and the error names the zone that already owns the zip |
| `/pay` | `pay.js` | 481 | tech pay grades and rows (same grade names company-wide, separate rows per city), the pay report, and per-job recalculation. Pay is **frozen on the call at close-out**; a call matching no row pays $0 **and raises a flag** |
| `/locations` | `locations.js` | 540 | location pings (up to 200 per request, so a phone out of a dead zone can dump its buffer), Live Map feed, trails, purge, settings |

### Fleet

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/vr` | `vr.js` | 370 | vehicle repairs: draft → submit → approve/reject, plus AI extraction from a photo/PDF |
| `/vehicles` | `vehicles.js` | 169 | fleet registry, deactivate/reactivate/sell |
| `/inspections` | `inspections.js` | 572 | monthly vehicle inspections, checklist admin, compliance view, photos, follow-up tasks |

### People

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/timeclock` | `timeclock.js` | 627 | punches, breaks, timesheets, week submit/approve/reopen, holidays, manager board. **Every timestamp is set by the server** (`NOW()`) — the phone only sends the action |
| `/pto` | `pto.js` | 1,125 | requests, approvals, ledger, cancellations, retroactive logging, awards, settings. Stored in **hours** (8h = 1 day); shown as hours for hourly/salary staff, days for commission staff |
| `/schedule` | `schedule.js` | 503 | shifts, positions, publish, copy-week, recurring, bulk. Field roles never trigger overtime warnings |
| `/onboarding` | `onboarding.js` | 2,150 | the gated, strictly sequential new-hire track (video / SOP read / quiz), uploads, HR docs, packet. The lock itself lives in `middleware/auth.js` |
| `/offboarding`, `/exit-interviews` | `offboarding.js` | 1,227 | offboarding lifecycle, templates, automated steps, finalize; plus the token-gated public exit form and the exit-interview insights router. Managers are scoped to their own supervisor tree |
| `/quiz`, `/quiz-take` | `quiz.js` | 727 | weekly SOP quiz. `/quiz-take` is a **token-gated public router** (no JWT). Self-bootstrapping: creates its tables and seeds defaults on load |
| `/assets` | `assets.js` | 2,346 | equipment tracker: types, kits, per-location stock and ledger, transfers, per-tech holdings, signed acknowledgments, replacement requests with photos. **Unlike every other module, managers here are scoped to their own cities** |

### Documents, signing, vault

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/documents` | `documents.js` | 558 | document vault: folders, presigned upload/download, shares by user or role. Only **owners** see everything by default — admins must be granted access like anyone else |
| `/signatures`, `/sign` | `signatures.js` | 993 | e-signature module. Source and flattened PDFs live in R2. `page_dimensions` captured at upload is the source of truth for the normalized(0–1) → PDF-point mapping used by the editor and the flatten step. `/sign` is the **public signer router** |
| `/sops` | `sops.js` | 73 | SOP documents (admin), text extracted client-side |
| `/vault` | `vault.js` | 378 | owner-only **zero-knowledge** credential store. One shared DEK encrypts every entry; each owner has an RSA keypair whose private key is encrypted under their own master password and recovery key, and the DEK is wrapped to each owner's public key. Nothing secret ever reaches the server. A new owner is admitted when an existing owner wraps the DEK to their public key, entirely in-browser |

### Work intake

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/tasks` | `tasks.js` | 642 | tasks, subtasks, comments, CC, attachments, reorder/autosort |
| `/task-templates` | `taskTemplates.js` | 120 | task templates + ordered steps |
| `/work-orders` | `workOrders.js` | 406 | inbound work orders (email-parsed), assignment, status, NTE history, reparse |
| `/signoffs` | `signoffs.js` | 442 | sign-off sheets and trips; feeds invoice creation via `POST /invoices/from-signoff/:id` |
| `/scheduled` | `scheduled.js` | 78 | scheduled outbound messages (admin) |

### Customers

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/feedback` | `feedback.js` | 505 | customer feedback / complaints: notes, attachments, linked call recordings. Non-admins scoped to the cities they manage. Playing a recording needs its own permission (`play_call_recordings`) |
| `/reviews` | `reviews.js` | 524 | Google reviews read from an **external** review-bot Postgres (`REVIEWS_DATABASE_URL`, read-only), assignment to technicians, tech tally, and filing a low-star review as a complaint |
| `/geico` | `geico.js` | 168 | GEICO survey store, stats, manual run/ingest. Action endpoints also accept a shared secret (`x-report-key: REPORT_API_KEY`) so they can be curl-tested without a session |

### AI

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/ai` | `ai.js` | 529 | Nova AI (Neurolock) chat + agent actions, usage caps, conversation history. Also exports `runAgentForActor` |
| `/voice` | `voice.js` | 125 | Nova Voice. One vendor, ElevenLabs, for both ears and mouth: `POST /transcribe` (Scribe) and `POST /speak` (TTS). The brain is unchanged — the client sends the transcript to the existing chat endpoint |
| `/mcp` | `mcp.js` | 141 | remote MCP server. JSON-RPC over Streamable HTTP, exposing the `lib/novaTools.js` registry to an external Claude. Bearer-protected with a Nova-issued JWT |
| `/` (root) | `oauth.js` | 419 | OAuth 2.1 authorization server for the MCP: RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591 dynamic client registration, an authorize endpoint with login + consent, and a token endpoint with mandatory PKCE (S256) and refresh rotation |

### Integrations and webhooks

| Prefix | File | Lines | Owns |
|---|---|---|---|
| `/inbound` | `inbound.js` | 346 | Resend inbound webhooks: `POST /email` (email→task), `POST /feedback` (Pulsar tech-conduct emails), `POST /sms`. Svix signature verified against the **raw** body |
| `/square` | `square.js` | 263 | Square POS callback + webhook. Both **unauthenticated** by necessity — Square redirects a raw browser at the callback and POSTs the webhook from its own servers. Signature verified against the raw body |
| `/goto` | `goto.js` | 409 | GoTo Connect. GoTo has no client_credentials grant, so an admin consents once in a browser; this router owns that handshake plus webhook setup, call index/backfill, lookup and recording playback |
| `/addin` | `addin.js` | 157 | Outlook add-in surface: minimal user list, parse, create, Entra SSO exchange, token mint. Add-in tokens are confined here by `middleware/auth.js` |
| `/ptt` | `ptt.js` | 408 | push-to-talk. Nova owns identity and authorization; **LiveKit owns audio**. This file decides which channels a user may join and mints short-lived LiveKit tokens scoped to exactly one room (`ptt_<channel code>`) |

---

## 6. Background jobs

All 20 modules live in `jobs/`, are `require`d at the top of `server.js`, and are started
after `initDB()` resolves. Cron expressions are `node-cron`; the timezone is
America/New_York where the module sets one.

| File | Schedule(s) | Does |
|---|---|---|
| `reminders.js` | `0 8 * * *` | PO order reminders |
| `cleanup.js` | `15 3 * * *`, `20 3 * * *` | purge old audit logs (`AUDIT_RETENTION_DAYS`) and closed work orders (`WORK_ORDER_RETENTION_DAYS`) |
| `scheduledMessages.js` | `* * * * *` | sends due scheduled messages |
| `taskReminders.js` | `0 7 * * *`, `0 8 * * *`, `0 3 * * *` | task due/overdue notices, CC notices, the recurring-task spawner, completed-task cleanup |
| `workOrders.js` | `* * * * *` | polls the work-order mailbox via Microsoft Graph and parses new orders (dormant unless `WORK_ORDERS_ENABLED=true`) |
| `timeclock.js` | `*/5 * * * *`, `10 3 * * *` | late-clock-in alerts (SMS) and auto-close of forgotten punches |
| `docExpiry.js` | `0 8 * * *` | document expiry reminders |
| `reviewRatings.js` | `0 9 * * *` | daily Google-review rating snapshot |
| `reviewComplaints.js` | `REVIEW_COMPLAINTS_CRON` | files 1–3★ Google reviews as customer-feedback complaints. **The first run only records a baseline watermark and files nothing** — set `REVIEW_COMPLAINTS_SINCE` before first boot to seed an earlier start. The threshold `settings.review_complaint_max_rating` is clamped 1–4. Reviews with no `review_id` are skipped (nothing to dedupe on) |
| `signatureReminders.js` | `0 9 * * *` | nudges pending signers |
| `ptoAccrual.js` | `0 1 * * *` | PTO accrual + year-end carryover |
| `geicoIngest.js` | `30 19 * * *`, `0 13 * * 1` | ingests the GEICO mailbox and sends the weekly digest |
| `geicoReport.js` | none of its own | report builder for the previous Mon–Sun window; the schedule that calls it lives in `geicoIngest.js`, which exports `startGeicoReport` |
| `quiz.js` | `*/15 * * * *`, `5 9 * * *` | generates and sends the weekly SOP quiz, then reminds |
| `inspectionReminders.js` | `0 8 * * *` | inspection nudges, manager nudges, overdue escalation |
| `offboarding.js` | (three starters) | auto-deactivation on the last day, quarterly drill, offboarding cleanup |
| `gotoSync.js` | `*/15 * * * *`, `*/10 * * * *`, `20 3 * * *` | GoTo token refresh, call indexing, nightly reconcile |
| `locationCleanup.js` | `40 3 * * *` | prunes old location pings |
| `dispatch.js` | `* * * * *` (×2) | accept-timeout reminders and unassigned-call alerts |
| `ar.js` | `15 7 * * *`, `30 7 * * *` | collections notice and statement day |

---

## 7. Shared utilities (`utils/`, 39 files)

### Integrations

| File | Lines | Notes |
|---|---|---|
| `goto.js` | 2,440 | the whole GoTo Connect client: OAuth, call index, recording media |
| `square.js` | 1,185 | Square client: payments, refunds, webhooks, reconciliation |
| `graph.js` | 173 | Microsoft Graph app-token auth + mailbox reads (GEICO, work orders) |
| `email.js` | 84 | `sendEmail()` + `emailTemplate()` via Resend. Sender controlled by `FROM_EMAIL` |
| `sms.js` | 30 | `sendSms()` via Twilio using native `fetch` — no npm package |
| `push.js` | 49 | VAPID web push |
| `r2.js` | 77 | Cloudflare R2: `presignUpload`, `presignDownload`, `getObjectBuffer`, `putObject`, `deleteObject` |
| `geocode.js` | 276 | one function, provider swappable by config. **Geocodio today**, Google written but gated. Three rules baked in: a geocode failure never blocks a call; the same address is never paid for twice (cached against a normalised form); **the cache TTL respects the provider's licence** — Geocodio permits indefinite retention, Google allows 30 days and forbids display on a non-Google map |
| `addinSso.js` | 88 | verifies Office SSO tokens from Entra |

### Domain logic

| File | Lines | Notes |
|---|---|---|
| `permissions.js` | 227 | RBAC: `ALL_PERMS` (102), `DEFAULTS`, `hasPermission`, `permsRev`. 15s cache on the matrix |
| `pay.js` | 428 | tech pay computation |
| `ar.js` | 377 | A/R math against the `ar_invoice_balances` view |
| `security.js` | 339 | security event recording, lockdown |
| `pulsarCash.js` | 326 | cash-call reconciliation |
| `invoicePdf.js` / `signoffPdf.js` / `disputePdf.js` | 304 / 257 / 354 | `pdfkit` document builders |
| `royaltyEngine.js` / `royaltyExcel.js` | 219 / 230 | royalty computation and `exceljs` workbook |
| `timeCodes.js` | 247 | week-window validation (gap/overlap refusal) |
| `pricing.js` | 198 | price resolution across service, location, zone and account |
| `zones.js` | 137 | coverage-zone matching |
| `quizGen.js` | 193 | AI quiz generation from SOP chunks |
| `feedbackAI.js` / `feedbackIntake.js` | 95 / 276 | complaint classification and intake |
| `taskParse.js` / `taskFromEmail.js` | 123 / 84 | email→task parsing |
| `workOrderParser.js` | 142 | work-order email parsing |
| `pulsarParse.js` | 125 | Pulsar email parsing |
| `hrCrypto.js` | 84 | AES-256-GCM for HR documents (`HR_DOC_ENC_KEY`) |
| `org.js` | 151 | supervisor-tree traversal used by onboarding/offboarding scoping |
| `duty.js` | 57 | dispatch duty state |
| `audit.js` | 26 | `logAudit()` |
| `clientVersion.js` | 44 | the `client_min_version` gate |
| `poNumber.js` | 69 | PO number allocation |
| `completionPacket.js` | 164 | offboarding completion packet |
| `messageTokens.js` | 74 | date tokens in scheduled messages |
| `notify.js` | 79 | notification fan-out |
| `sopIndex.js` | 46 | SOP chunking for AI retrieval |

### `lib/`

| File | Lines | Notes |
|---|---|---|
| `novaTools.js` | 2,465 | the AI tool registry. `TOOLS`, `toAnthropicTools()`, `getTool()`. Shared by `routes/ai.js` and `routes/mcp.js`, so an external Claude and the in-app assistant get the same capabilities. Mints its own callback JWT carrying `nt`, which is why `middleware/auth.js` re-runs the onboarding gate for it |
| `diag.js` | 17 | in-memory diagnostic ring buffer |

---

## 8. Clients

| Client | Where | Notes |
|---|---|---|
| **Web / PWA** | `public/` | installable; `sw.js` pre-caches the shell. `CACHE_VERSION` is the app version (see `CLAUDE.md` §1.3) |
| **Android** | `mobile/android` | Capacitor shell around the same web app. `public/js/native.js` is the bridge: background GPS with the phone locked, external links opening in the phone's browser, and a plain-language disclosure before location is collected. Built by `.github/workflows/android-workflow.yml` |
| **Outlook add-in** | `public/addin/`, `unified-addin/`, `outlook-addin-manifest.xml` | "Send to Nova". Entra SSO → `POST /api/addin/sso` → a 90-day token confined to `/api/addin/*` |
| **External Claude (MCP)** | `routes/mcp.js` + `routes/oauth.js` | OAuth 2.1 with PKCE, then JSON-RPC to the `novaTools` registry |

---

## 9. Storage and file flow

Uploads never pass through the API. The pattern, repeated across invoices, quotes,
inspections, assets, documents, signatures, feedback and PTT:

```
POST  .../upload-url        → presigned R2 PUT URL (utils/r2.js)
PUT   <presigned URL>       → browser uploads straight to Cloudflare R2
POST  .../confirm           → Nova records the object key and marks the row ready
GET   .../download | /url   → presigned R2 GET URL
```

The convention across `documents`, `invoices`, `quotes`, `inspections`, `feedback`,
`signatures` and `onboarding` is that a row is only real once `status = 'ready'` — an
abandoned upload leaves a placeholder row that no gate accepts. `assets` and `ptt` use the
same presign flow with their own endpoint names.

---

## 10. Where to start reading

Depending on what you're here to do:

| Task | Start at |
|---|---|
| Add an API endpoint | `routes/<domain>.js`, then `server.js` mount, then `middleware/auth.js` to pick the gate |
| Add a screen | a new `public/js/<module>.js`, plus `public/index.html` and `sw.js` `SHELL_ASSETS` |
| Change permissions | `utils/permissions.js`, then the Roles & Access screen (`renderRoles` in `app.js`) |
| Add a column or table | `db.js` — and read `CLAUDE.md` §1.4 first |
| Add a scheduled job | `jobs/<name>.js` exporting a `startX()`, then require + call it in `server.js` |
| Understand the auth model | `middleware/auth.js` top to bottom; it is only 210 lines and every branch is commented |
| Understand money | `routes/invoices.js` (freeze on settle), `routes/refunds.js` (append-only), `routes/ar.js` (derived balance) |
