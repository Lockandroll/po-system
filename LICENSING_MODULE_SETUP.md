# Licensing & Compliance + the account register — build + go-live

Two things that shipped together.

**The register** is a dated list of what we did on an account or a licence:
*paid $340 on 3/12/26 for the 2026 Birmingham occupational tax, ACH,
confirmation 88213.* It hangs off **both** Accounts and Licensing, and it is
reachable from a **Register** button on each row of both tables.

**Licensing & Compliance** is a second table shaped like Accounts, for the
things that are not vendors: city business licences, occupational tax
registrations, sales-tax accounts, contractor and alarm licences, franchise
registrations. Each one carries an issuing authority, a number, a renewal date,
a typical fee, a portal login and its security questions — and its own register.

Built to mirror Accounts (`routes/vendors.js`, `public/js/app.js` `renderVendors`)
and COI (`routes/coi.js`). Ships **dark** behind `view_licenses` /
`manage_licenses` — nobody but admin/owner can see Licensing until you turn it
on. The Register button on **Accounts** is *not* dark: it rides on the
`view_vendors` / `manage_vendors` that Accounts already has, so it appears for
everyone who can already see Accounts.

---

## Why it exists

Accounts held the **login** for a portal and nothing held the record of what we
did once we were inside it. That record was living in somebody's memory, and the
moment you want it is a year later when the same bill comes round and the only
useful question is *what did we pay last time, and when*.

A city occupational tax is not a vendor, so it does not belong in `vendors`. It
is a licence: an authority, a number, a renewal date and a portal you log into.
Hence the second table, with the renewal dates `vendors` has no reason to carry.

---

## Go-live checklist

1. **Deploy.** Push to `main`; Railway auto-deploys. On boot, `initDB()` creates
   `licenses` and `account_ledger_entries` (idempotent — safe to run
   repeatedly).

2. **Check the version badge.** The sidebar should read **nova-v466**. If it
   does not, the deploy has not landed or the service worker has not updated.

3. **The Register button on Accounts works immediately.** Nothing to turn on.
   Anyone with `view_vendors` can read an account's register; `manage_vendors`
   is what lets them write to it.

4. **Turn on Licensing.** Settings → **Roles & Access** → tick **Licensing &
   Compliance** for the roles that should have it:
   - `view_licenses` — see the licences and read their registers. The portal
     **username, password and security answers are stripped by the server**, not
     merely hidden, so this is safe to hand to someone who should know when the
     Birmingham licence renews without being handed the login.
   - `manage_licenses` — everything above, plus the credentials, plus writing
     register entries.

   To give it to one person only, use Edit User → extra permissions.

5. **Load the licences you already hold.** Licensing → **+ Add Licence**. The
   ones worth doing first are whatever is closest to renewing. For each: name,
   type, issuing authority, number, jurisdiction, renewal date, typical fee, and
   the portal login if there is one.

6. **Backfill last year's payments.** On each licence, click its **Register**
   cell → **+ Add entry**, with the date and amount you actually paid. That
   backfill is the whole point: it is what makes next year's renewal a
   two-second question instead of a phone call.

---

## How it behaves

- **Renewal status is computed on the server**, once, in `routes/licenses.js`
  `statusOf()` — the row pill, the banner count and anything that later wants to
  email about it all read the same answer. A licence is **Renew soon** within
  **60 days** of its date (the same 60 days the COI screen uses), **Expired**
  past it, **No date** when nobody has filled the date in, and **Inactive** when
  it is switched off. "No date" is deliberately not "Current": a licence whose
  renewal nobody recorded is a problem, not a pass.

- **The register hangs off exactly one subject.** A row points at an account or
  at a licence, never both and never neither — enforced in the database by the
  `account_ledger_one_subject` CHECK constraint, because a row that belongs to
  nothing is invisible forever.

- **Permissions ride on the subject, never on the register.** Reading an
  account's register needs whatever reading that account needs; writing needs
  `manage_vendors`. A licence's register answers to `view_licenses` /
  `manage_licenses`. That includes the per-account **restricted-to allowlist**:
  an account you are not allowed to see does not leak its payment history
  either. There is no separate ledger permission to get wrong.

- **Money is optional on every entry.** Filing a zero-dollar annual return is a
  thing that happened and is worth a line, so a `filing` or `note` entry shows a
  dash rather than `$0.00` — "no money was involved" is a different claim from
  "we paid nothing". Entry types are payment, filing, renewal, credit, refund
  and note; credits and refunds are money coming back and are drawn negative and
  totalled separately.

- **Amounts are parsed, not trusted.** `$1,234.56` typed into the box is stored
  as `1234.56`. Anything that is not a number becomes null rather than zero.

- **Every register write is audited** (`entity_type = 'ledger'`), including the
  full contents of a deleted entry — a deleted payment record is exactly the
  thing somebody will need to reconstruct later. Licence creates, edits and
  deletes are audited as `entity_type = 'license'`.

- **Deleting a licence takes its register with it** (`ON DELETE CASCADE`), and
  the confirmation says how many entries will go. If you have simply stopped
  holding a licence, untick **Active** instead — what we once paid for is still
  worth keeping.

- **A partial save never wipes a secret.** A PUT that does not mention the
  password or the security questions leaves them alone; only an explicit empty
  value clears them. This is the same guard `routes/vendors.js` carries, and the
  licensing test caught the bug it prevents: a save carrying only a new renewal
  date was blanking the portal login.

---

## Files

```
db.js                          licenses + account_ledger_entries (+ the CHECK constraint)
routes/licenses.js             licence CRUD, status computation, credential stripping
routes/ledger.js               register CRUD for both subjects, subject-derived permissions
utils/permissions.js           view_licenses / manage_licenses (dark)
server.js                      /api/licenses and /api/ledger mounts
public/js/licenses.js          the Licensing screen AND the shared register popup
public/js/app.js               nav row, view permissions, render dispatch,
                               the Register column on Accounts, the Roles & Access group
public/index.html              loads /js/licenses.js
public/sw.js                   nova-v466, licenses.js in SHELL_ASSETS
test-licensing-ledger.js       108 assertions vs a real Postgres, over real HTTP
test-licensing-dom.js          115 assertions in jsdom
```

Run the tests against a throwaway database:

```bash
DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-licensing-ledger.js
node test-licensing-dom.js
```

---

## Where this could go next

Not built, deliberately, so the first version stays small:

- **A renewal reminder task.** The A/P module already does this well
  (`jobs/ap.js`): a daily job raises a normal Nova task a few days before a bill
  is due, assigned to somebody, so chasing it happens in the task list everyone
  already uses. `licenses.responsible_user_id` and `expires_on` are both already
  there for it. This is the obvious next step and probably the one worth doing.
- **Rolling the renewal date forward when a renewal is recorded**, the way a
  paid recurring A/P bill creates next month's. `renewal_interval` is stored for
  exactly this.
- **Attaching the licence PDF itself.** `routes/accountDocs.js` already does
  this for accounts against R2; extending it would mean making
  `account_documents.account_id` nullable and adding a `license_id` beside it.
