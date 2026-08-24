# COI Module Plan (Certificates of Insurance)

**Status:** PLAN ONLY, nothing built yet.
**Lives in:** Accounts (`routes/vendors.js`, `public/js/app.js` renderVendors), plus a new
`COI` screen and a new `routes/coi.js`.
**Date:** 2026-08-24

---

## 1. The problem being solved

Once a year the policy renews and every national account, property manager and
municipality wants a fresh certificate with its own name in the holder box, its own
required limits, and its own additional-insured wording. Today that lives in email
threads and somebody's memory. The failure mode is not "we forgot to file a form",
it is an account quietly going non-compliant and jobs stopping.

Nova should be able to answer three questions at any moment:

1. Which accounts need a COI, and what exactly does each one require?
2. What did we last send them, and when does it expire?
3. At renewal, what is the single document I hand the agent so all of it goes out at once?

---

## 2. Shape of the feature

Three surfaces:

**A. Per account: a COI section.** On the account (existing Accounts screen) a COI panel
holding that account's *requirements* plus its *certificate history*. This is the record of
truth for one account.

**B. A COI screen (new nav item under Accounts).** Every account that requires a COI, one row
each, with a status chip: Current / Expiring / Expired / Missing / Waived. This is the daily
view and where the badge count comes from.

**C. A renewal cycle.** Started once per policy year. Produces the PDF packet for the agent
and then becomes the live checklist: requested to agent, certificate received, sent to
account, confirmed. Closing the cycle is what proves the renewal actually finished.

---

## 3. Data model

### 3.1 `account_coi_requirements` (one row per account, created on demand)

Kept in its own table rather than more columns on `vendors`. `vendors` already carries 25+
bolt-on columns and the COI block is ~30 fields that only apply to a minority of accounts.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `account_id` | INT REFERENCES vendors(id) ON DELETE CASCADE, UNIQUE | |
| `coi_required` | BOOLEAN NOT NULL DEFAULT true | false = shows as "Not required", drops out of the packet |
| `holder_name` | VARCHAR(255) | goes in the CERTIFICATE HOLDER box verbatim |
| `holder_address` | TEXT | multi-line, verbatim |
| `additional_insured` | JSONB | array of `{ name, relationship }`; often more than one entity |
| `ai_wording` | TEXT | verbatim wording the account dictates for Description of Operations |
| `waiver_gl`, `waiver_auto`, `waiver_wc` | BOOLEAN | waiver of subrogation, per line |
| `primary_noncontrib` | BOOLEAN | primary and non-contributory |
| `cancel_notice_days` | SMALLINT | e.g. 30 |
| `req_gl_occurrence` | NUMERIC(12,0) | required minimums, all nullable |
| `req_gl_aggregate` | NUMERIC(12,0) | |
| `req_gl_products_agg` | NUMERIC(12,0) | |
| `req_auto_csl` | NUMERIC(12,0) | combined single limit |
| `req_umbrella_each` | NUMERIC(12,0) | |
| `req_wc_statutory` | BOOLEAN | |
| `req_el_each_accident` | NUMERIC(12,0) | employers liability |
| `req_el_disease_each` | NUMERIC(12,0) | |
| `req_el_disease_policy` | NUMERIC(12,0) | |
| `req_garagekeepers` | NUMERIC(12,0) | relevant for us, vehicles in our care |
| `submit_method` | VARCHAR(10) | `email` / `portal` / `mail` |
| `submit_emails` | TEXT | comma separated, where the finished COI goes |
| `submit_portal_url` | VARCHAR(255) | compliance portals (myCOI, Ebix and similar) |
| `submit_notes` | TEXT | "upload under Vendor ID 4471", that kind of thing |
| `named_insured` | VARCHAR(255) | which entity the cert is issued for, if it varies |
| `source_note` | TEXT | where the requirement came from (contract, page, date) |
| `updated_by`, `updated_at` | | |

Portal credentials are NOT duplicated here. The account already has
`username` / `password` / `security_questions` and those stay the single copy.

### 3.2 `account_coi_certificates` (history, newest is current)

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `account_id` | INT REFERENCES vendors(id) ON DELETE CASCADE | |
| `cycle_id` | INT REFERENCES coi_renewal_cycles(id) ON DELETE SET NULL | null for off-cycle certs |
| `r2_key` | VARCHAR(512) UNIQUE NOT NULL | `coi/<account_id>/<uuid>-<filename>` |
| `file_name`, `mime_type`, `size_bytes` | | |
| `status` | VARCHAR(20) DEFAULT 'pending' | pending until the R2 PUT is confirmed, same two-step as the vault |
| `effective_on`, `expires_on` | DATE | expiry drives everything |
| `carrier`, `policy_numbers` | VARCHAR/TEXT | free text, for reference |
| `lim_gl_occurrence` ... `lim_el_disease_policy` | NUMERIC(12,0) | mirrors the `req_*` set, typed in at upload |
| `has_ai`, `has_waiver`, `has_pnc` | BOOLEAN | the three boxes that get missed most |
| `mismatch` | JSONB | computed at save: array of `{ field, required, actual }` |
| `sent_at`, `sent_to`, `sent_by` | | set when Nova emails it out |
| `superseded` | BOOLEAN NOT NULL DEFAULT false | flipped when a newer cert covers the same account |
| `uploaded_by`, `uploaded_at` | | |

Current cert for an account = highest `expires_on` among `status='ready'` and not superseded.

### 3.3 `coi_renewal_cycles` + `coi_renewal_items`

```
coi_renewal_cycles(id, name, policy_effective DATE, policy_expires DATE,
                   status VARCHAR(12) DEFAULT 'open',   -- open | closed
                   packet_generated_at, created_by, created_at, closed_at)

coi_renewal_items(id, cycle_id, account_id,
                  status VARCHAR(12) DEFAULT 'needed',  -- needed | requested | received | sent | confirmed | waived
                  requested_at, certificate_id, sent_at, confirmed_at, notes,
                  UNIQUE(cycle_id, account_id))
```

Starting a cycle snapshots every account with `coi_required = true` into items. Snapshotting
matters: an account added in March should not silently appear in a January cycle's history.

### 3.4 Our own policy (settings)

Store the master policy in `settings` under key `coi_policy`:
carrier, agency name, agent name / email / phone, policy numbers per line, effective and
expiration dates. Feeds the packet cover page and the "renewal is coming" reminder.

---

## 4. Upload flow

Same three-step the document vault uses, so bytes never touch Railway:

1. `POST /api/coi/certificates/upload-url` reserves the row (`status='pending'`) and returns
   a presigned PUT URL from `utils/r2.js`.
2. Browser PUTs the file straight to R2.
3. `POST /api/coi/certificates/:id/confirm` flips it to `ready`, HEAD-checks the object exists,
   and runs the mismatch comparison.

Download and preview go through `r2.presignDownload` exactly like `routes/documents.js`.

**Mismatch check** runs server-side on confirm and on any later edit of limits. For each
`req_*` that is set, if the corresponding `lim_*` is null or lower, push
`{ field, required, actual }` onto `mismatch`. Same for `has_ai` / `has_waiver` / `has_pnc`
against `additional_insured` / `waiver_*` / `primary_noncontrib`. A non-empty `mismatch`
renders as a red "Does not meet requirements" banner on the cert with the specific lines
listed. It never blocks a save. The certificate is what the carrier issued; Nova's job is to
tell you it is short, not to refuse the file.

Limits are typed in by whoever uploads. Do not try to OCR ACORD forms in v1.

---

## 5. Sending the COI to the account

`POST /api/coi/certificates/:id/email` mirrors `routes/documents.js` `:id/email`:
pulls the file from R2, attaches it, sends through `utils/email.js` with `emailTemplate()`,
then stamps `sent_at` / `sent_to` / `sent_by` and advances the matching renewal item to `sent`.

Recipients default to `submit_emails` from the requirements, editable in the dialog before
sending. If `submit_method = 'portal'`, the send button is replaced by an "Open portal" link
(reusing `vendorOpenSite` so the password copies) plus a "Mark as submitted" button, because
a portal upload has to be done by hand.

---

## 6. The renewal packet PDF

`utils/coiPacketPdf.js`, pure pdfkit (matching `utils/disputePdf.js` and `utils/invoicePdf.js`,
no browser). Route: `GET /api/coi/cycles/:id/packet.pdf`.

- **Cover page:** our named insured and address, current policy carrier / numbers / expiration,
  agent contact, count of certificates requested, generated-on date.
- **One block per account** (2 to 3 per page, not one page each, so the agent can work down it):
  holder name and address exactly as it must appear, additional insured entities, required
  wording verbatim in a boxed callout, required limits as a small table with anything above our
  current policy flagged, the waiver / P&NC / cancellation-notice checkboxes, and where to send it.
- **Trailing summary table:** account, holder, send-to, so the agent can tick them off.

Also worth exposing `GET /api/coi/cycles/:id/packet.xlsx` later if the agent asks for it, but
the PDF is v1.

---

## 7. Reminders (`jobs/coiExpiry.js`, node-cron, modeled on `jobs/docExpiry.js`)

Daily, one digest email, not one email per account:

- **Master policy renewal:** at 60 and 45 days before `coi_policy.policy_expires`, email admins
  "time to start the COI renewal cycle" with a one-click link.
- **Per-account certificates:** at 60 and 30 days before `expires_on`, and again on the day it
  expires, list the accounts in a single digest. `reminder_sent_at` / `expiry_notice_sent_at`
  style columns on the cert row prevent repeats, same guard `docExpiry` uses.
- **Missing:** accounts with `coi_required = true` and no ready certificate at all get their own
  section in the same digest. This is the one that actually catches problems.

---

## 8. Status, chips and the badge

Single helper `coiStatus(account)` used by the Accounts table chip, the COI screen, the badge
count and the digest. One source, so they cannot disagree:

- `not_required` (grey) when `coi_required = false`
- `missing` (red) when required and no ready cert
- `expired` (red) when the newest cert's `expires_on` is in the past
- `expiring` (amber) when within 60 days
- `mismatch` (amber, takes precedence over `current`) when the current cert has a non-empty `mismatch`
- `current` (green) otherwise, showing the expiry date

Accounts table gets one new `COI` column with the chip. The COI nav item gets a count badge of
`missing + expired + expiring`.

---

## 9. Permissions

- Read: existing `view_vendors` or `manage_vendors`.
- Write: new `manage_coi` permission (upload, edit requirements, email, run cycles).

Separate from `manage_vendors` on purpose. Whoever handles insurance renewals should be able to
do COIs without being handed every vendor portal password. Add to `ALL_PERMS` in
`utils/permissions.js` and to the `manager` default list.

---

## 10. Files touched

**New**
- `routes/coi.js`
- `utils/coiPacketPdf.js`
- `jobs/coiExpiry.js`
- `public/js/coi.js` (COI screen + the account COI panel, keeping `app.js` from growing again)
- `test-coi.js`, `test-coi-dom.js`

**Modified**
- `db.js` (4 new tables, indexes)
- `server.js` (register `/api/coi`, start the cron job)
- `utils/permissions.js` (`manage_coi`)
- `public/js/app.js` (COI column + chip in `vendorsRenderTable`, COI button in the account row)
- `public/index.html` (nav item, script tag)
- `public/sw.js` + `utils/clientVersion.js` (version bump)
- `routes/dashboard.js` (badge count)

> Every new `.js` file must be `git add`ed or the Railway deploy MODULE_NOT_FOUNDs. This has
> bitten this repo repeatedly (ivrBrain.js, invite.js, geicoComplaints.js).
>
> All `.js` edits go through the GitHub web editor. Windows silently corrupts backticks.

---

## 11. Build order

**Phase 1 (the useful core):** tables, requirements editor on the account, upload + store +
history, status chip on the Accounts table. After this alone, the requirements stop living in
email.

**Phase 2 (renewal):** cycles, the checklist screen, the packet PDF. This is the piece that
makes renewal a one-afternoon job.

**Phase 3 (distribution):** email to account, portal tracking, mismatch flags surfaced.

**Phase 4 (safety net):** the reminders job, the dashboard badge, the missing-COI digest.

---

## 12. Open questions

1. **Named insured.** Does every certificate go out under one entity (Lock and Roll LLC), or do
   some markets need a different named insured? If it varies, `named_insured` per account is
   already in the model, but the packet needs to group by it.
2. **Agent contact.** Who is the agent, and do they want the packet emailed or handed over? A
   one-click "email packet to agent" is trivial to add once Phase 2 exists.
3. **Retention.** Keep expired certificates forever, or archive after N years? Recommend keeping
   them, they are small and useful in a dispute.
4. **Off-cycle accounts.** Some accounts renew on their own contract date, not our policy date.
   The model handles it (`cycle_id` nullable), but the checklist should probably show them as a
   separate "off-cycle" section rather than pretending they belong to this year's batch.
5. **Auto-request.** Should Nova email the agent automatically when a new account is created with
   `coi_required = true`, or is that always a human decision? Recommend human for v1.
