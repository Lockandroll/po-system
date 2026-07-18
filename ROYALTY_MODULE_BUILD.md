# Nova — Royalty Statements module (build + test guide)

**What it does:** Drop **one** Pulsar *Call Search* export covering every city. Nova splits it by the
**Location** column, matches each location to a city, and builds that city's **Automated Royalty &
Advertising Fund Statement** using **that city's own saved rates**. Every statement is stored so you
can re-export the formatted Excel or re-download that city's CSV any time.

Validated against Birmingham May-2026 to the penny: **Royalty $1,310.19 · Gross $26,203.76 · Ad
$262.04**. Combined split verified on a 3-city file — each city computes with its own rate
(e.g. 5% → $1,310.19, 6% → $1,572.23, 4% + 80% parts → $1,042.31).

---

## Files in this drop

**New**
- `utils/royaltyEngine.js` — verified compute engine (dependency-free).
- `utils/royaltyExcel.js` — builds the statement `.xlsx` (exceljs) + Call Data audit sheet.
- `routes/royalty.js` — API (list, config, single + **combined** preview/import, export.xlsx, source.csv, delete).

**Modified**
- `db.js` — `royalty_statements` table (auto-created on boot; `UNIQUE(city_id, period)` → re-import replaces).
- `server.js` — mounts `/api/royalty`.
- `routes/royalty.js` + `public/js/app.js` — access is **owner-gated + a per-person allowlist** (NOT role-based): owners always see Royalty, and an owner picks specific people (View / Full) in an in-module panel. Grants live in `users.extra_perms`; Royalty was removed from the Roles & Access matrix.
- `public/js/app.js` — Royalty nav + view: **combined import**, **per-city rate table**, **owner access panel**, statement history. Also patched the Users edit form so saving a profile can't wipe a Royalty grant.
- `utils/permissions.js` — dropped Royalty from the manager role default (now owner + allowlist only).
- `public/sw.js` — cache bump to **v184**.
- `package.json` + `package-lock.json` — **exceljs 4.4.0** (lockfile updated for `npm ci`).

Rates, the location→city alias map, and the motor-club list are stored in **settings**
(`royalty_rates`, `royalty_location_map`, `royalty_motor_clubs`) — no schema change for those.

---

## Deploy
1. Commit + push in GitHub Desktop → Railway auto-deploys (`initDB()` makes the table; `npm ci` installs exceljs).
2. Hard-refresh Nova for **v184**.

## Test
1. Sidebar → **Royalty** is visible to **owners only** at first. As an owner, open **Who can access Royalty** and add specific people — **View & export** or **Full (import/delete)**. Admins are *not* included automatically. A grant takes effect on that person's next click (no sign-out).
2. Open **Royalty rates & settings** → set each city's Royalty / Advertising / Parts-cost % (the Default
   row covers any city you leave blank) → **Save**. You only do this once.
3. Pick the **Statement Period**, drop the combined Pulsar CSV. Nova shows a **detected-cities table**:
   each Location → matched City, the rate it will use, completed calls, and computed Gross / Royalty / Ad.
   - Any location it can't match shows a City dropdown (highlighted) — assign it; the choice is
     **remembered** for next month via the alias map.
   - Reassigning a row re-computes it with that city's rate instantly.
4. **Save all statements** → each city lands in **Statement history** (re-importing a city+month replaces it).
5. From history: **Excel** (formatted statement) · **CSV** (that city's slice of the export) · **✕** delete.

Sanity file: a Birmingham May-2026 Call Search should produce the totals above.

---

## Notes
- **Who can see it:** owner-gated + an owner-managed people list inside the module. It is deliberately
  NOT in Roles & Access — even other Admins are excluded unless an owner adds them. Only owners can
  edit the list (so an admin can't grant themselves). Grants are stored per-user in `extra_perms`.
- **Each city can have different rates** — that's the per-city table. Rates snapshot into each saved
  statement, so changing them later never rewrites old months.
- **Combined vs single:** the UI is combined-first (one file, many cities). The API still has single-city
  endpoints (`POST /royalty/preview`, `POST /royalty`) if ever needed.
- **Location matching:** exact city-name match first, then the saved alias map, then your manual
  assignment (which is saved). So month one you may map a few; after that it's automatic.
- **Motor-club list** is editable in the same settings panel (default: Agero-Swoop, GEICO, ALLSTATE,
  Allied Dispatch, Roadside Protect). Blank Account = Core · listed = Motor Club · other = National.
- **City names/codes** come from Nova's Cities — confirm the non-BHM cities there so Location matching lands.
