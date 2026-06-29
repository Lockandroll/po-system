# Email → Nova Task (Outlook)

Two ways to turn an email into a Nova task:

1. **Forward-to-email** — forward any email to a Nova address; AI reads it and creates the task. Works on desktop, web, and phone.
2. **Outlook ribbon button** — a "Send to Nova" button that opens a popup with the AI-extracted highlights to review before saving.

---

## How assignment works

- **Default:** the task is assigned to whoever forwarded the email (matched by their email address to a Nova user).
- **Override in the email body:** type an instruction at the top before forwarding, e.g. *"Assign to Mike, due Friday"* — the AI uses that for the assignee, due date, and title.
- **No one named:** assigned to the sender.
- **Unknown senders are ignored** (only emails from a registered Nova user create tasks).

---

## Files added (already in the repo)

| File | Purpose |
|------|---------|
| `utils/taskParse.js` | Calls Claude to extract title/description/priority/due date/assignee |
| `utils/taskFromEmail.js` | Matches sender + assignee to users, inserts the task |
| `routes/inbound.js` | Resend inbound webhook (`POST /api/inbound/email`) |
| `routes/addin.js` | Add-in endpoints (`/api/addin/parse`, `/create`, `/users`) |
| `public/addin/taskpane.html` | The Outlook popup UI |
| `public/addin/commands.html` | Required add-in function file |
| `outlook-addin-manifest.xml` | The Outlook add-in manifest (upload to M365) |
| `server.js`, `db.js` | Route wiring + `tasks.source` column |

---

## Phase 1 — Forward-to-email setup

### 1. GoDaddy DNS (subdomain so your real mail is untouched)
Add the MX record Resend gives you for a subdomain, e.g. **`in.popalockar.com`**.
(Resend shows the exact MX host/priority when you add the receiving domain.)

### 2. Resend
1. Resend → **Domains** → add receiving domain `in.popalockar.com`, verify the MX record.
2. Resend → **Webhooks** → **Add Webhook**:
   - URL: `https://www.popalockar.com/api/inbound/email`
   - Event: **`email.received`**
3. Copy the webhook **Signing Secret** (starts with `whsec_`).

### 3. Railway
Add one variable:
```
RESEND_INBOUND_SECRET = whsec_xxxxxxxx
```
(`RESEND_API_KEY` and `ANTHROPIC_API_KEY` are already set and are reused.)

### 4. Test
Forward an email to **`tasks@in.popalockar.com`** (any name @ the subdomain works).
You should get a confirmation email back and see the task in Nova. Check Railway logs for `[inbound] created task #…` if anything seems off.

### 5. One-click button in Outlook (Quick Step)
Outlook → **Home → Quick Steps → Create New**:
- Action: **Forward** → To: `tasks@in.popalockar.com`
- Name it **"Send to Nova"**, optionally assign a keyboard shortcut.

Now one click forwards the selected email and Nova creates the task. On your phone, just forward manually.

---

## Phase 2 — Native Outlook add-in (ribbon button + popup)

> Optional, nicer UX. Requires a Microsoft 365 Business plan and admin access.

1. Deploy the code (Phase 1 push covers it) so `https://www.popalockar.com/addin/taskpane.html` is live.
2. Microsoft 365 admin center → **Settings → Integrated apps → Add-ins → Deploy Add-in**.
3. Choose **Upload custom apps** → upload `outlook-addin-manifest.xml`.
4. Assign to yourself / a test group → finish. Rollout can take up to 24 hours.
5. In Outlook, open a message → **Send to Nova** appears in the ribbon → sign in once (your Nova login) → review the highlights → **Create task**.

The add-in is inert until you deploy the manifest, so shipping the code is safe.

---

## Notes / limitations
- Forwarded threads: the AI focuses on any instruction you type at the top, then the latest message.
- Attachments are not yet attached to the task (the email text is parsed). Can be added later.
- If a forwarded sender isn't a Nova user, nothing is created (by design).
