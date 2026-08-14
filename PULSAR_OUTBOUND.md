# Nova to Pulsar (outbound)

The other direction. `utils/webhookIngest.js` is how Pulsar tells us something
happened; `utils/pulsarOut.js` is how we tell Pulsar to make something happen.

Built against the published docs at <https://www.idssonline.com/api/>
(last updated 24 May 2026). It ships **disarmed** — deploying it changes
nothing until you set an environment variable.

---

## What the documentation changed

I had guessed at the protocol before you sent the link. Four of those guesses
were wrong, and every one of them would have failed in a way that is hard to
diagnose from the outside:

| I had assumed | Actually |
|---|---|
| token in a header called `token` | header is called **`auth`**. A wrong header name is a silent 401 with nothing in the logs to explain it |
| one URL, one `action` parameter | **three provisioned URLs** (API, import, GPS) and a numeric `header` code per request |
| HTTP status tells you if it worked | **it does not.** A rejected request is a healthy `200` with `wasSuccess:false` inside |
| form-encoded body | JSON, except GPS, which is plain text |

The third one is the one that mattered. A client that trusts the status code
reports every rejection as a success, forever, and the only symptom is that
nothing happens in Pulsar. That check now has its own function (`judge`) and
seven tests.

---

## Environment variables

**Railway Variables tab. Not the repo, not a chat.**

| Variable | Value |
|---|---|
| `PULSAR_SKEY` | from Duty — sent as the `skey` header |
| `PULSAR_TOKEN` | from the dispenser — sent as the `auth` header |
| `PULSAR_OUT_MODE` | `off` / `dry` / `live`, defaults to `off` |
| `PULSAR_API_URL` | `https://api.idssonline.com/apiv2.ashx` (already the default) |
| `PULSAR_IMPORT_URL` | **need from Duty** — required for `add_call` |
| `PULSAR_GPS_URL` | **need from Duty** — required for `gps` |

There is no public base URL; Pulsar provisions one per integration per endpoint.
Asking for an endpoint we have no URL for is a clean refusal that names the
variable to set, not a request to the wrong place.

The three modes: **`off`** refuses everything, no row and no request.
**`dry`** builds the request, writes the call-log row, and stops one line before
the send. **`live`** actually talks to Pulsar. Go in that order.

---

## The credentials

Read from the environment at call time and nowhere else.

`add_call` is the reason redaction matters more here than it looks: that
endpoint wants the **sKey in the request body** as well as in the headers, so
the secret sits inside the exact blob you would naturally log verbatim. Every
request body is stripped before it reaches the database, and the tests assert
neither value appears in any stored row or any audit entry.

The status screen shows `set, ends 4A2B` and nothing more. No screen in Nova can
display these values. The token dispenser fires once — save it before you paste
it anywhere.

---

## What it can do

| Action | Endpoint | Sends | Status |
|---|---|---|---|
| `auth_test` | API | `header: 100` | **verified** — documented, harmless, echoes your request back |
| `assign_call` | API | `Header: 104000`, status `0` | unverified, draft on their side |
| `accept_call` | API | status `1` | unverified, draft |
| `enroute` | API | status `2` | unverified, draft |
| `onsite` | API | status `3` | unverified, draft |
| `direct_tech` | API | any status you pass | unverified, draft |
| `add_call` | import | `requestType: NewJob` | unverified — needs the import URL |
| `gps` | GPS | comma-separated device ids, `text/plain` | unverified — needs the GPS URL |

The four status verbs are all the same Direct Tech endpoint with the status
pinned, so calling code says what it means instead of passing a bare `2` around.

**Start with `auth_test`.** It is the only action marked verified, because it is
fully documented *and* changes nothing in Pulsar. If it comes back
`wasSuccess:true`, the credentials and both header names are right and
everything else is just field shapes.

`verified` means "somebody watched this succeed against the real API", not
"matches the docs". In live mode an unverified action is refused unless you
explicitly force it — so a wrong guess costs a rejection in the call log rather
than a real technician sent to a real address. Flip the flag only for something
you have personally seen work.

Not built: Quoting and Personnel. Quoting is documented but not what you asked
for; Personnel and Webhook Events are unpublished drafts. `/probe` covers both
until they are.

---

## The thing that makes this verifiable

Every action Nova takes in Pulsar generates a Pulsar event that comes straight
back through the receiver we already built.

So we never have to trust a `200`, or even a `wasSuccess:true`. Send `enroute`,
then watch for dataHeader 67 arriving on `/api/sync/in/pulsar`. If the response
said yes and no event arrives, the response was lying. That loop is why the
inbound half had to be built first, and it is what `expect_header` in the action
registry is for.

There is also an `uncertain` flag: if Pulsar answers in an envelope we do not
recognise, the call is not failed, but it is marked so the log can show it and
the inbound echo can settle it. Assuming is fine. Assuming quietly is not.

---

## Big ids

Pulsar ids are 18-digit int64s. JavaScript cannot hold one:

```
201002101610450898  ->  201002101610450900
```

The loss happens at parse time, before any of our code runs, so there is nothing
to fix downstream. The client **refuses** a parameter that arrives as an unsafe
number rather than quietly addressing a record that does not exist. Pass ids as
strings, the whole way down. Duty warned about this in exactly these words.

---

## The screen

**Settings → Data Sync → Outbound.**

Everything to the left of that tab is what partners send us. This tab is what we
send them, and it exists mainly so arming the integration is a deliberate,
visible act rather than an environment variable nobody remembers setting.

It shows the mode, whether each credential is loaded (last four only, never the
value), which of the three URLs we actually have, every action with its state,
and the full call log. Clicking a call shows the exact request sent — credentials
already stripped — and the exact response.

Running an action opens a JSON box rather than a generated form. Pulsar's field
list is long, conditional and still growing: a box accepts a field we have never
heard of, and a generated form silently drops it.

The tab loads before the inbound source checks, so it works even with no inbound
sources configured. You can be sending to Pulsar long before anyone has pointed
a webhook at us.

---

## Still needed from Duty

Down to two, and neither blocks the first test:

1. **The import URL** (for creating calls) and the **GPS URL**. Provisioned per
   integration, so not something I can guess.
2. **Is Direct Tech live yet?** The docs mark it Draft, and it is the endpoint
   that does everything you actually want — assign, accept, enroute, on-site.

**Accepting a digital** is answered: Duty hasn't built it yet (today, or Monday).
Nothing to do until then. When it lands, it is likely either `direct_tech` with
status `1` or a new header code, and both are a few lines in the action registry.

---

## Running it

```
node test-outbound.js       # 109 assertions, no DB, no network beyond loopback
node test-outbound-dom.js   # 19, the Outbound screen
node test.js                # 239, the inbound side, unchanged
```

Then, with `PULSAR_OUT_MODE=live` and the credentials set, open the Outbound tab
and run **`auth_test`**. That one call proves the credentials, both header names
and the URL, and cannot change anything in Pulsar.
