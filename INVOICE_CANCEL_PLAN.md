# Nova — Invoice close-out bar + Cancel status (plan, not yet built)

_Drafted 2026-08-28 for Tony. Nothing in this has been coded yet._

## What Tony asked for

> On invoices, can we have buttons on the bottom that basically has "waiting for payment",
> "Completed", or "Cancel". If cancel, basically change the status to cancel and just allow
> the call to be closed with that status.

## What already exists (so we do not rebuild it)

Two of the three buttons are already real work, just reachable by a different route:

- `INV_STATUSES = ['draft','awaiting_payment','paid']` in `public/js/app.js` (~line 14897).
  Displayed as **Active / Waiting for Payment / Completed**. Stored values never change.
- `invProcessCardHtml()` (~17777) renders a state-dependent card: Active gets the gated green
  **Complete Invoice**, awaiting_payment gets **Record payment & Complete**, paid gets Reopen.
- `POST /invoices/:id/complete` and `POST /invoices/:id/waiting` (routes/invoices.js 2274 / 2334)
  already do the work, both behind `invoiceGates()`.
- **Cancel does not exist at all.** That is the real build.

So this is: reshape the three existing paths into one bottom bar, and add a fourth status.

---

## 1. The bottom bar (Screen 1 / Screen 5)

A sticky action bar at the bottom of the **invoice view** (`renderViewInvoice`), the page that
already owns finishing. Not on the edit form — the edit form's job is Save, and the Status
dropdown there stays as-is for the two statuses it can already reach.

Desktop: three buttons in a row, Complete widest and green.
Phone (<600px): Complete full-width on top, Waiting and Cancel splitting the row beneath, so the
green primary is never a mis-tap away from Cancel.

| Button | Calls | Gated? |
|---|---|---|
| Waiting for Payment | existing `invWaitingSheet` → `POST /:id/waiting` | yes — `invoiceGates` |
| Complete | existing `invCompleteSheet` → `POST /:id/complete` | yes — `invoiceGates` |
| Cancel | **new** `invCancelSheet` → `POST /:id/cancel` | **no** |

Cancel is deliberately ungated. The whole point of a cancel is that the invoice could not be
finished — a no-show has no customer name and no line items, so a gated Cancel would be
unreachable exactly when it is needed.

The gate checklist stays where it is, in the card above the bar, so a disabled Complete always
has its reason visible on the same screen.

**Status quo preserved:** the bar replaces the button rows inside `invProcessCardHtml`, not the
card. The Active card keeps the gate list, awaiting_payment keeps its "$X owed / waiting since"
alert, paid keeps the 15-minute reopen countdown.

---

## 2. New status: `canceled`

`invoices.status` is a plain `VARCHAR(20)` with no CHECK constraint, so the value is just added.
Nothing to migrate — no existing row becomes canceled.

### Schema (db.js, new migration block)

```
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS canceled_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(40);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancel_note TEXT;
```

Money columns are **not** zeroed in the database. `grand_total` stays $164.55 so the record of
what was quoted survives; every *report* excludes canceled rows instead. Zeroing the row would
destroy the evidence of what the customer declined, which is the one thing a cancel is worth
looking at later.

### Front end (app.js)

```
INV_STATUSES        += 'canceled'
INV_STATUS_LABELS.canceled = 'Canceled'
INV_STATUS_BADGE.canceled  = 'badge-canceled'   // new grey pill, index.html both themes
INV_STATUS_HELP.canceled   = 'The job did not happen. No charge, no parts used, no revenue.'
```

`badge-canceled` is grey, **not** red. Red is `badge-refunded` and a cancel is not a refund;
the two must not read alike in a list.

---

## 3. `POST /invoices/:id/cancel`

Permission `edit_invoice`, same owner-or-manager check as `/complete`. Body: `reason` (required,
one of four keys), `note` (optional, 2000 chars).

Refusals, in order:

1. `LOCKED_STATUSES` (paid / partially_refunded / refunded) → **409.** Money already landed;
   that unwinds through the refund flow, which leaves a record. A cancel would not.
2. A `reconciled` row in `invoice_payments` → **409**, even if status somehow is not locked.
   Square took real money.
3. Already `canceled` → **409**, idempotent message.
4. An open `initiated` / `offline_pending` Square attempt → **409**, "wait for that to settle".

On success: set status + the four new columns, `closeFollowupTask()` (a canceled invoice must not
leave a chase task sitting on someone's list), `logAudit({ action: 'canceled', details: { reason,
note, was_status, grand_total } })`.

### Reopen

`POST /:id/reopen` currently requires `LOCKED_STATUSES`. Extend it to accept `canceled` →
back to `draft`, clearing the four cancel columns. Same rule as a completed invoice: the person
who canceled it inside the 15-minute grace, or an admin any time.

---

## 4. Pulsar close-out on a canceled invoice (Screen 3)

This is the "allow the call to be closed with that status" half.

`invCloseoutHtml()` locks the copy buttons while `status === 'draft'`. Change that test to
`status === 'draft'` only — canceled falls through to the unlocked card, with
`invPulsarFields()` returning:

| # | Field | Value |
|---|---|---|
| 1 | Invoice # | the real number |
| 2 | Parts total | `0.00` |
| 3 | Labor total | `0.00` |
| 4 | COGS total | `0.00` |
| 5 | Payment type | `Canceled` |
| 6 | Payment total | `0.00` |

⚠️ **Every money field is 0.00, hard-coded, not derived.** The royalty and ad fee are computed
from what gets typed into Pulsar. A canceled job earned nothing, so anything but zero pays a
percentage on revenue that does not exist. This is the same reasoning already written into
`invPulsarTotal()` for the surcharge and tip.

The invoice number still goes in, so the call closes rather than sitting open in Pulsar.

Field 5 copying the literal word `Canceled` assumes that is what Pulsar's payment-type field
takes for a canceled call. **Worth confirming before this ships** — if Pulsar wants a different
token, it belongs in the existing `pulsar_pay_map` setting rather than hard-coded.

---

## 5. Reports and rollups — where canceled has to be excluded

This is the part that quietly breaks if it is missed.

| Place | File | Change |
|---|---|---|
| **Month-end parts report** | `routes/invoices.js` ~723 | `AND inv.status <> 'canceled'` in the WHERE. It currently filters on nothing but date, so today a canceled invoice's part lines would be ordered again next month. |
| Add-to-req | same, `/parts-report/add-to-req` | inherits the fix above |
| COGS / gross profit | `invCloseoutHtml`, `cogs` block | canceled → COGS 0, no margin line |
| Square reconciliation | `routes/invoices.js` 583 | keyed on `status = 'paid'`, so already excluded — verify only |
| Refund eligibility | `canRefund` in `renderViewInvoice` | add `inv.status !== 'canceled'` alongside the existing `!== 'draft'` |
| Invoice list filter | `app.js` 14981 | picks statuses up from `INV_STATUSES`, so Canceled appears automatically |
| Dashboard / revenue | `routes/dashboard.js` | checked — does not read invoice status. No change. |
| AR | `routes/ar.js`, `utils/ar.js` | checked — import-driven, not invoice-status-driven. No change. |

Parts: the cancel dialog says out loud that the parts go back on the truck, and tells the tech
what to do instead if a part was genuinely cut (complete the invoice at the right price). That
sentence is the control — it is cheaper than a second question in the dialog and it points at
the correct action rather than just recording an answer.

---

## 6. Files touched

| File | What |
|---|---|
| `db.js` | 4 `ALTER TABLE` in a new migration block |
| `routes/invoices.js` | `POST /:id/cancel`; reopen accepts canceled; parts-report status filter; `CANCELABLE`/`LOCKED` constants |
| `public/js/app.js` | status maps; `invActionBarHtml()`; reshape `invProcessCardHtml`; `invCancelSheet` + `invDoCancel`; `invCloseoutHtml` + `invPulsarFields` canceled branch; `canRefund` |
| `public/index.html` | `.badge-canceled` (dark + light), `.inv-actionbar` block; bump `sw.js` version |
| `test-invoice-cancel.js` | **new** — Postgres assertions |
| `test-invoice-cancel-dom.js` | **new** — DOM assertions |

⚠️ Both test files are new — `git add` them or nothing runs them in CI.

⚠️ `routes/invoices.js` and `db.js` contain backticks. Per CLAUDE.md these get pasted through the
**GitHub web editor**, never the Windows filesystem. `index.html` is safe to edit directly.

## 7. Tests to write

Postgres: cancel from draft; cancel from awaiting_payment closes the chase task; cancel refused
on paid; refused with a reconciled Square payment; refused when already canceled; reopen restores
draft and clears all four columns; **parts report excludes a canceled invoice's part lines**;
audit row written with reason.

DOM: bar renders three buttons on Active and the right subset on each other status; Complete
disabled when a gate fails while Cancel stays live; canceled invoice renders the grey badge, the
cancel banner with reason and author, and a Pulsar card whose six copy values are
`<number>, 0.00, 0.00, 0.00, Canceled, 0.00`.

## 8. Open question

Should a canceled invoice still be printable / emailable to the customer? Current thinking: yes,
but the PDF prints **CANCELED — NO CHARGE** across it and every total at $0.00. Needs Tony's call
before `utils/invoicePdf.js` is touched.
