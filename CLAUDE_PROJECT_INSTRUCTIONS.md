# Claude project instructions — paste text

The Nova project in the Claude app has its own instructions field, configured in the app
rather than in this repo. Those instructions were written when the frontend was a single
3,300-line `index.html` and are now substantially wrong.

**Replace them with the text between the markers below.** It is deliberately short: the
detail belongs in `CLAUDE.md`, which is version-controlled and gets updated alongside the
code. Anything duplicated into the app settings will drift.

Keeping this file in the repo means the paste text is reviewable in a PR like everything
else.

---

<!-- BEGIN PASTE -->

# Nova — Project Context

Nova is the internal operations platform for Lock and Roll LLC (a Pop-A-Lock franchise):
dispatch, invoicing and payments, quotes, purchase orders, fleet, time clock and PTO,
scheduling, equipment, onboarding/offboarding, customer feedback, e-signatures, and an
in-app AI assistant (Neurolock).

Vanilla-JS SPA + Node/Express + PostgreSQL, deployed on Railway, auto-deploying from
`main`. No build step, no test suite, no linter, no staging environment.

The repo, the npm package and the deploy are all named `po-system` for historical reasons.
Same thing as Nova. Do not rename.

## Read the repo docs first

**`CLAUDE.md` at the repo root is the source of truth** for the stack, the file layout, the
auth model, the frontend architecture, the data model, and — most importantly — the rules
that break production when ignored. Read it before proposing or making changes. If anything
here or in a spec `.md` disagrees with `CLAUDE.md` or the code, the code wins.

`ARCHITECTURE.md` has the full inventory: all 57 routers, all 20 cron jobs, all 39 shared
utilities, the 147 tables, and where to start reading for a given task.

## The five rules that matter most

1. **Windows can silently corrupt backticks in `.js` files.** House style is string
   concatenation. If a `.js` file with backticks must be pasted, use the GitHub web
   editor. **Always run `node --check` on every `.js` file you edit** — there is no build
   step or CI to catch a mangled paste before it takes production down.
2. **Bump `CACHE_VERSION` in `public/sw.js`** whenever anything under `public/` changes.
   That string is the app version: the service worker caches the shell under it, and
   `server.js` reads it at boot for `GET /api/version`. Skip it and users keep running the
   old `app.js` from cache.
3. **`db.js` is the only migration mechanism.** It runs on every boot and must stay
   idempotent. `CREATE TABLE IF NOT EXISTS` does **not** add columns to a table that
   already exists — a new column needs an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` too.
   A failure in `initDB()` is logged but non-fatal, so a bad migration shows up as runtime
   query errors, not a failed deploy.
4. **New modules and permissions ship dark.** A permission in `ALL_PERMS` but not in
   `EMPLOYEE_PERMS` or any role's `DEFAULTS` is reachable only by admin/owner until someone
   ticks it in Settings → Roles & Access. Do not add a permission to `DEFAULTS` as part of
   building a feature — going live is a separate decision.
5. **Use `&#39;` for apostrophes inside HTML strings** built for `innerHTML`.

## Frontend, accurately

`public/index.html` is an ~875-line shell, **not** the whole frontend. It loads 15 classic
scripts in a fixed order, starting with `public/js/app.js` (~23,800 lines, ~110 screens),
then `vault, pto, onboarding, offboarding, ptt, nova-voice, native, location, dispatch,
callSearch, timeCodes, coverage, pay, ar`.

They are classic scripts, not ES modules — everything is global on purpose, because
`app.js` carries ~760 inline `onclick` handlers. Top-level `const`/`let` in `app.js` are
**not** visible to the later files; use `var` or a function if a module needs it. New
screens belong in a new `public/js/<module>.js` added to both `index.html` and `sw.js`'s
`SHELL_ASSETS`, not appended to `app.js`.

## Editing conventions

- HTML and Markdown edit safely with any tool. `.js` files are the ones with the backtick
  hazard — `node --check` after every edit.
- Every knob goes in the `settings` table, not a constant, so behaviour changes without a
  deploy.
- Fail closed on auth and permission paths; there are several deliberate examples in
  `middleware/auth.js` to match.
- Audit anything that moves money or access (`utils/audit.js`), and security events
  (`utils/security.js`).
- Uploads never pass through the API — presign with `utils/r2.js` and let the browser talk
  to Cloudflare R2 directly.
- Comments in this codebase carry the *why* and are load-bearing. Preserve them, and add
  your own reasoning when you make a non-obvious choice.

## Don't read `_to_delete/`

It holds ~40,000 lines of superseded scratch files from past sessions. Gitignored, stale by
definition. Same for anything named `*.bak-*`.

<!-- END PASTE -->
