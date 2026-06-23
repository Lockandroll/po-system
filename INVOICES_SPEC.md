# Nova — Invoices Module Spec (v0.1, working draft)

_Status: bones / design phase. Started 2026-06-23. Target: in full use within ~2 weeks._

This is the field invoicing system. A locksmith completes an invoice on-site (phone/tablet), the
customer signs on the device, and the invoice records the job, the vehicle, the parts used, payment
type, and the signed authorizations. Parts consumed feed the month-end reorder list. Built as its own
module, modeled on the existing Quotes framework.

---

## Locked decisions

| Decision | Choice |
|---|---|
| Module structure | **Separate Invoices module** (`invoices` + `invoice_line_items`), modeled on quotes |
| Card / payment data | **Pay type + last 4 only** — never store full card #, exp, or CVV (stays out of PCI scope) |
| Signature capture | **On-screen draw** on the tech's device; saved as image on the invoice |
| ID decode | **Scan PDF417 barcode on back of license** (AAMVA) → **AI front-photo fallback** → free-form always available |
| Accounts source | **Reuse existing account list**; add a **"Show in Invoice Dropdown"** checkbox to control which appear |
| Workflow | **No approval** — status only: Draft → Completed/Signed → Paid |
| Line items | Each line tagged **Labor** or **Part**; drives Labor/Parts total split |
| Parts | Part lines **pick from the existing parts catalog** (add new on the fly) → feed month-end reorder list |
| Invoice number | **Numeric, incrementing** (like the old form, e.g. `310401370`) |

---

## Data model (proposed)

### `invoices`
- `id` SERIAL PK
- `invoice_number` BIGINT/VARCHAR UNIQUE — numeric incrementing
- `locksmith_id` INTEGER → users(id) — who ran the job
- `invoice_date` DATE
- `status` VARCHAR — `draft` | `completed` | `paid`
- **Customer:** `customer_name`, `dl_number`, `dl_state`, `street_address`, `city`, `state`, `zip`, `phone`, `email`
- **Account:** `account_id` → accounts(id), `customer_po_wo`, `pay_type`, `card_last4`, `time_in`, `time_out`
- **Vehicle:** `vehicle_year`, `vehicle_make`, `vehicle_model`, `license_tag`, `tag_state`, `vin`, `mileage`
- **Entitlement docs provided:** `ent_registration` BOOL, `ent_insurance` BOOL, `ent_title` BOOL, `ent_rental` BOOL
- **Money:** `tax_rate`, `labor_amount`, `parts_amount`, `subtotal`, `tax_amount`, `tip_amount`, `grand_total`
- `notes` TEXT, `payments_note` TEXT
- **Signature:** `signature_image` (R2 key or data), `signed_name`, `signed_at`
- `cc_online` BOOL
- `created_at`, `updated_at`

### `invoice_line_items`
- `id` SERIAL PK, `invoice_id` → invoices(id) ON DELETE CASCADE
- `line_type` VARCHAR — `labor` | `part`
- `part_id` INTEGER → parts(id) NULL (set when a Part line is picked from catalog)
- `description`, `item_number`, `unit_price`, `quantity`, `taxable` BOOL, `extension` (qty × unit_price)
- order/sort column

### Accounts table additions (existing account list)
- `show_in_invoice` BOOL DEFAULT false — controls dropdown visibility
- `invoice_notes` TEXT — rates / important info shown in the popup when account is selected
- `auto_line_items` JSONB — line items pre-loaded when account is chosen
- `agreement_text` TEXT — editable authorization language printed on this account's invoices
- (default agreement text used when account has none)

---

## Key behaviors

**Account selection.** Tech picks an account from the dropdown (only `show_in_invoice` accounts shown).
On select: popup shows `invoice_notes` (rates / important info), and `auto_line_items` pre-load into the
line-item grid. Tech can edit/remove them.

**VIN decoder.** Enter VIN → decode via **NHTSA vPIC API** (free, no key) → auto-fill Year/Make/Model.
Free-form override always allowed.

**ID scan.** Scan back-barcode (PDF417) → parse AAMVA fields into customer block. If scan fails, AI reads
front photo. Manual entry always available.

**Labor vs Parts.** Each line is Labor or Part. Sum of Part lines = Parts Amount; sum of Labor lines =
Labor Amount (matches the old invoice's split). Part lines link to the parts catalog so consumed parts
roll into the month-end order with correct item numbers.

**Signature.** Customer draws signature on-device; stored with typed name + timestamp. Three authorization
paragraphs (from account's `agreement_text` or the default) print above the signature on the PDF.

**Parts → month-end.** Part lines across all invoices in the period aggregate into the reorder list,
merged with the existing Monthly REQ running list.

**PDF / print view.** Invoice renders to a print/PDF layout matching the old paper form (header, job info,
account info, vehicle, line items, totals, authorization + signature).

---

## Invoice Setup (Nova portal screen)
- Per-account: toggle "Show in Invoice Dropdown", edit notes/rates, manage auto line items, edit agreement text
- Edit the **default agreement text** (the three authorization paragraphs)
- Company header info (name, address, phone) — configurable via settings

---

## Roles
Follows existing pattern: locksmith/roadside create + see their own invoices; manager/admin see all.
(Confirm exact gates against current `can()` permissions during build.)

---

## Still to nail down (next discussion round)
1. **Tax rate** — fixed per city, per account, or chosen per-invoice? (Old form had a Tax Rate selector.)
2. **Tip** — captured how? Flat amount entered by tech, or % ?
3. **Entitlement document upload** — the old form had a "Choose File / Upload" for entitlement docs.
   Reuse the R2 document vault to attach photos of registration/insurance to the invoice?
4. **Payments field** — single payment note, or track partial/multiple payments?
5. **Editing/voiding** — can a signed invoice be edited? Void vs delete? Audit trail on changes.
6. **Emailing the invoice** — auto-email signed PDF to the customer's email on completion?
7. **"Generate Key" / "Misc." buttons** — were these quick-add line presets on the old form? Want presets?
8. **Numbering** — any required starting number / digit length to match existing records?

---

## Proposed build phases
1. **Schema + migrations** (`invoices`, `invoice_line_items`, account-table columns) in `db.js`
2. **Backend routes** (`routes/invoices.js`) — CRUD, numbering, totals, audit, notifications
3. **Account setup** — `show_in_invoice` + notes + auto line items + agreement text (backend + portal UI)
4. **Invoice form** (frontend) — customer/account/vehicle/line-items/totals, status
5. **Smart inputs** — VIN decoder (NHTSA), ID barcode scan + AI fallback
6. **Signature capture** + authorization text rendering
7. **PDF / print view** matching the old form
8. **Parts → month-end** integration with the catalog / Monthly REQ
9. **Polish** — emailing, entitlement doc upload, presets, edge cases
