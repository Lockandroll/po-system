# Accounts Payable (AP) — build + go-live

Bills **we owe**: entered, tracked to a due date, marked paid. A daily job raises
a normal Nova **task** a few days before each bill is due, so chasing a payment
happens in the same task list everyone already uses. Recurring bills roll over
automatically, bills can hold a copy of the invoice, and a bill can be started by
forwarding it to an email address.

Built to mirror the A/R module (`routes/ar.js`, `utils/ar.js`, `public/js/ar.js`,
`jobs/ar.js`). Ships **dark** behind `view_ap` / `manage_ap` — nobody but
admin/owner can see it until you turn it on.

---

## Go-live checklist

1. **Deploy.** Push to `main`; Railway auto-deploys. On boot, `initDB()` creates
   `ap_bills` and `ap_bill_attachments` (idempotent — safe to run repeatedly).

2. **Turn it on.** Settings → **Roles & Access** → tick **Accounts Payable**
   (`view_ap`, `manage_ap`) for the roles that should have it. To give it to one
   person only, use Edit User → extra permissions. Until you do, the nav item is
   hidden for everyone except admin/owner (this is deliberate, per CLAUDE.md 1.5).

3. **Set the reminder defaults.** Accounts Payable → **Settings**:
   - *Fallback reminder recipient* — who a reminder goes to when a bill has no
     assignee of its own. A bill with its own assignee always goes to that person.
   - *Remind this many days before due* — defaults to **3**.

4. **(Optional) Email intake.** To forward bills in:
   - Set `AP_INBOUND_ADDRESS` in Railway (e.g. `bills@in.popalockar.com`).
   - In Resend, add an inbound route for that address pointing at the **existing**
     `/api/inbound/email` webhook. It reuses `RESEND_INBOUND_SECRET` — no new
     secret. (Mail is routed by recipient inside `routes/inbound.js`, exactly like
     the feedback address.)
   - A staff member forwards a vendor bill to that address → Nova files a **draft**
     payable and emails them back. See "Email intake" below.

After deploy, confirm the sidebar version badge reads **nova-v274**.

---

## How it behaves

- **Reminder task.** `jobs/ap.js` runs daily at **07:45** (after the A/R jobs). For
  every unpaid bill due within the lead window — plus any already overdue that
  never got one — it creates one task (`source='ap'`, `source_id=<bill id>`),
  assigned to the bill's assignee or the fallback, due on the bill's due date.
  One task per bill, ever (guarded by `ap_bills.reminder_task_id`). Because the
  task has a due date, the normal task reminders (day-before / due-day) fire on it
  too.

- **Mark paid.** Records the amount, date, method and reference. If the bill is
  **recurring monthly**, next month's bill is created the moment this one is paid
  (day-of-month clamped to 1–28 so the 31st never skips February). "Mark unpaid"
  reverses a payment without creating a second next-month bill.

- **Void vs delete.** A paid bill is **voided** (kept for the record), never
  deleted. Only a draft or an unpaid bill can be hard-deleted (for a genuine
  mistake), which also removes its reminder task and any attached files.

- **Email intake is never trusted.** A forwarded bill lands as a **review draft**
  with the amount/due date as *parser guesses*. A person opens it, confirms the two
  fields, and saves it live — Nova never puts a guessed amount on a live "pay this"
  bill. Attachments on the email are captured to R2 best-effort; if the format is
  unusual, attach the file by hand on the draft.

- **Attachments.** Stored in Cloudflare R2 via presigned URLs (bytes go
  browser↔R2, never through the server), the same as every other upload.

---

## Data model

`ap_bills` — one row per bill: vendor_id (optional) / payee (free text), bill_number,
category, description, amount, bill_date, **due_date**, status (`unpaid` | `paid` |
`void` | `review`), paid_on / paid_amount / paid_method / paid_reference,
assigned_to, recurring / recurrence / recurrence_day / series_id / spawned_next,
reminder_task_id, reminded_on, source (`manual` | `email`), source_ref, raw_email.

`ap_bill_attachments` — bill_id, r2_key, filename, content_type, size_bytes,
uploaded_by.

Settings keys: `ap_reminder_user_id`, `ap_reminder_lead_days`.

---

## Files

**New:** `routes/ap.js`, `utils/ap.js`, `jobs/ap.js`, `public/js/ap.js`,
`scripts/ap_selftest.js`, this doc.

**Edited:** `db.js` (tables), `server.js` (mount `/api/ap`, start the job),
`utils/permissions.js` (`view_ap` / `manage_ap`, dark), `routes/inbound.js`
(the `bills@` branch), `public/js/app.js` (nav + router + Roles editor),
`public/index.html` (script tag), `public/sw.js` (asset + `nova-v274`),
`.env.example` (`AP_INBOUND_ADDRESS`).

## Verify

```bash
node scripts/ap_selftest.js         # 43 assertions over the pure helpers
find . -path ./node_modules -prune -o -name '*.js' -print | xargs -n1 node --check
```
