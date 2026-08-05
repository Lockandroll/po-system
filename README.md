# Nova

Internal operations platform for **Lock and Roll LLC**, a Pop-A-Lock franchise.

Nova is what the company runs on day to day: dispatch, invoicing and payments, quotes,
purchase orders, the vehicle fleet, the time clock and PTO, scheduling, equipment
tracking, onboarding and offboarding, customer feedback, e-signatures, and an in-app AI
assistant (Neurolock).

It is a single-page vanilla-JS app on a Node/Express API and PostgreSQL, deployed on
Railway.

> **The repo is called `po-system`** because Nova began as a purchase-order tool. Purchase
> orders are now a small corner of it. Don't rename anything — just know the two names
> refer to the same project.

---

## New here? Read these in order

1. **[`CLAUDE.md`](CLAUDE.md)** — the rules that cost real money when broken, the stack,
   the layout, and how the frontend and auth actually work. **Read §1 before your first
   commit.**
2. **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — the full reference: every route module, every
   cron job, every shared utility, the data model, and where to start for a given task.
3. The feature specs at the repo root (`INVOICES_SPEC.md`,
   `OFFBOARDING_IMPLEMENTATION.md`, `EMAIL_TO_TASK_SETUP.md`, `NOVA_VOICE_SETUP.md`,
   `ROYALTY_MODULE_BUILD.md`, `OFFBOARDING_API_QUICK_REFERENCE.md`, `mobile/README.md`).
   These are *design records from when the feature was built* and may lag the code — trust
   the code and `CLAUDE.md` over them.

The four things most likely to bite you on day one:

- **Windows can corrupt backticks in `.js` files.** Run `node --check` on everything you
  edit before you push. There is no build step and no CI to catch it.
- **Bump `CACHE_VERSION` in `public/sw.js`** whenever anything under `public/` changes, or
  users keep the old JavaScript from the service-worker cache.
- **`db.js` is the only migration mechanism** and it must stay idempotent.
  `CREATE TABLE IF NOT EXISTS` does *not* add columns to an existing table.
- **New permissions ship dark on purpose.** Don't add one to `DEFAULTS` while building a
  feature.

All four are explained properly in `CLAUDE.md` §1.

---

## Running locally

```bash
git clone https://github.com/Lockandroll/po-system.git
cd po-system
npm install

cp .env.example .env
# At minimum, fill in DATABASE_URL and JWT_SECRET.

npm run dev      # nodemon
# or
npm start        # node server.js
```

Then open <http://localhost:3000>.

**First run against an empty database** shows a "Create Admin Account" screen. That is
`POST /api/auth/setup`, and it only works while the `users` table is empty.

`initDB()` in `db.js` creates and migrates every table on boot, so an empty Postgres
database is all you need. Note that a migration error is logged but **non-fatal** — if
something behaves oddly on a fresh database, check the boot log for `DB init error`.

### Requirements

- Node ≥ 18 (`engines`); 20 or 22 is fine
- A PostgreSQL database

### What works without third-party keys

Most of the app runs on just `DATABASE_URL` + `JWT_SECRET`. Features degrade rather than
crash when a key is missing, but these need one to do anything:

| Feature | Needs |
|---|---|
| Email notifications, inbound email→task | `RESEND_API_KEY`, `FROM_EMAIL` |
| SMS 2FA (falls back to email), late-clock alerts | `TWILIO_*` |
| Any file upload (documents, photos, signatures, PTT) | `R2_*` (Cloudflare R2) |
| Nova AI / Neurolock, AI extraction, quiz generation | `ANTHROPIC_API_KEY` |
| Nova Voice | `ELEVENLABS_API_KEY` |
| PTT radio | `LIVEKIT_*` |
| Card payments and refunds | `SQUARE_*` |
| Dispatch geocoding, coverage zones | `GEOCODE_PROVIDER`, `GEOCODIO_API_KEY` |
| GEICO + work-order mailbox ingest | `MS_*` (Microsoft Graph) |
| Call recordings on complaints | `GOTO_*` |
| Google reviews dashboard | `REVIEWS_DATABASE_URL` |
| Web push | `VAPID_*` |
| HR document storage (onboarding) | `HR_DOC_ENC_KEY` |

`.env.example` documents all 79 variables the code reads. 25 of them were added on
2026-08-05 and sit in a marked block at the bottom of the file — several of those were
already configured in Railway while undocumented here, so **check Railway before assuming
something is unconfigured.** `CLAUDE.md` §7 has a one-liner that finds drift.

---

## Deploying

Railway auto-deploys from `main`. There is **no staging environment and no CI gate on the
Node code**, so `main` is production.

**Pre-push checklist:**

```bash
# 1. syntax-check everything you touched (see CLAUDE.md §1.1)
find . -path ./node_modules -prune -o -path ./_to_delete -prune -o -path ./mobile -prune -o -name '*.js' -print \
  | xargs -n1 node --check

# 2. did anything under public/ change? bump CACHE_VERSION in public/sw.js
# 3. new DB column? make sure there's an ALTER TABLE ... ADD COLUMN IF NOT EXISTS
# 4. new permission? confirm it is NOT in DEFAULTS / EMPLOYEE_PERMS yet
```

After the deploy, open the app and confirm the version badge in the sidebar matches the
`CACHE_VERSION` you pushed.

### First-time Railway setup

1. New Project → Deploy from GitHub repo.
2. **+ New → Database → PostgreSQL.** Railway usually auto-links `DATABASE_URL`; check
   before adding it by hand. Use the **internal** URL (`*.railway.internal`) — no SSL
   config is needed for it.
3. Set at least `JWT_SECRET` (`openssl rand -hex 32`), `NODE_ENV=production`, and `APP_URL`.
   Add the integration keys you need from the table above.
4. Settings → Networking → Generate Domain.

---

## Repo layout

```
server.js      Express app: security headers, CORS, rate limits, 60 router mounts, cron startup
db.js          pool + initDB() — 147 CREATE TABLE, 357 ALTER TABLE, idempotent, runs every boot
routes/        58 files — one Express router per domain (all mounted; 3 export a second public router)
utils/         39 files — integrations (Resend, Twilio, R2, Square, GoTo, Graph, Geocodio) + domain logic
lib/           novaTools.js (AI tool registry, shared by the in-app assistant and the MCP server)
jobs/          20 node-cron modules
middleware/    auth.js — requireAuth / requireRole / requirePermission
public/        the entire frontend: index.html shell + 15 JS modules + sw.js (PWA)
mobile/        Capacitor Android shell
```

~85,600 lines of JS/HTML/CSS. `ARCHITECTURE.md` breaks all of it down.

---

## Roles

Roles are `admin`, `owner`, `manager`, `locksmith`, `locksmith_coordinator`, `dispatcher`,
`roadside_technician`. What each can do is **not** hard-coded — it lives in a 102-permission
matrix editable at **Settings → Roles & Access**, with per-person grants via
`users.extra_perms`. `admin` and `owner` always pass every check; the Secure Vault is
owner-only. Defaults are in `utils/permissions.js`.

---

## Getting help

- Every non-obvious decision in this codebase is explained in a comment near the code.
  `middleware/auth.js`, `server.js`, `utils/geocode.js` and the Phase-2 dispatch files are
  worth reading straight through.
- `CLAUDE.md` §10 has an honest list of the known rough edges.
