# Inbound Sync Receiver

Nova's generic front door for partners who want to push JSON at us. Pulsar's
"syncer" is the first tenant. Nothing in it is Pulsar-specific.

---

## What a "syncer" is

Duty's syncer is Pulsar's change-propagation process. When something happens in
Pulsar — a call is created, a job is assigned, a status flips — the syncer's job
is to make sure every other system that cares finds out. It is the thing that
keeps two databases from drifting apart.

There are only two ways to do that, and he offered both:

**Polling (we hit them).** We ask Pulsar every N minutes "what changed since
timestamp X?". We control the schedule and the retries. We need an API token
from them, and we are always up to N minutes stale. Most requests return nothing.

**Webhooks (they hit us).** Pulsar POSTs each change to a URL we give them, as it
happens. Near-real-time, no wasted calls, no token to manage on our side. The
cost is that we now run a public endpoint, and reliability becomes our problem:
if we are down or slow when they call, that event is gone unless someone retries.

Duty said "either or", asked for a page he can POST to, and pointed out the sync
would help the auto-assignment work. Webhooks are the right pick — auto-assign is
worthless on 15-minute-old data — so this is the webhook receiver.

The reliability cost is what most of the code below is about. **The rule that
makes a webhook receiver safe is: store first, answer fast, interpret later.**
Every one of Duty's deliveries is written to disk verbatim before any Nova code
tries to understand it. If our mapping is wrong, or does not exist yet, the data
is still here and can be replayed. A receiver that parses-then-stores loses
events every time someone ships a bug.

---

## What Pulsar actually sends

Confirmed by Duty, 2026-08-13. One object, or an array of them:

```json
{ "autonum": "0", "dataTarget": "", "dataHeader": 0,
  "locationID": "0", "targetID": "0", "accountID": "0",
  "gmtStamp": "2026-08-13T00:00:00Z",
  "targetUID": "00000000-0000-0000-0000-000000000000" }
```

Four things about this envelope drive real decisions:

**`dataHeader` is the record type.** Duty: *"if its 1000 its a new job, if its
1001 its someone accepting a job, if its 2000 its a new digital, if its 2001 its
a digital getting accepted, etc."* It is the only bare number in the payload, and
it is what the whole thing routes on.

**This is the entire Pulsar feed.** *"every event in pulsar flows through this,
its the main feed of the pulsar matrix"* and *"there are LOTS of them and it'll
spam ya."* That is why `accept_types` and the traffic counters exist — see the
firehose section below. He also offered a subscription so Pulsar filters on their
side, which is strictly better than filtering on ours; take it if he builds it,
and keep our filter anyway as the backstop.

**The envelope carries no data — it is a pointer.** It says *record of this type,
this id, changed at this time*. Acting on one means fetching the record from
Pulsar, which needs an API token Nova does not have yet. Until that is settled,
parking these is the only correct thing to do with them.

**`"0"` and the nil GUID are sentinels, not values.** Every id is a string, and
`"0"` / `00000000-0000-0000-0000-000000000000` mean absent. Treating `"0"` as
integer zero and looking up location 0 is the obvious bug; `pulsarId()` in
`utils/webhookHandlers.js` is the only thing that should ever read these fields.

Source configuration for Pulsar:

```
dedupe_path      autonum        (assumed unique per change — CONFIRM with Duty)
event_type_path  dataHeader
accept_types     (leave empty at first — watch the traffic, then narrow)
```

---

## Batches

A top-level array is **split into one event per element**, not stored as a blob.
Three reasons, all of which show up the first time a batch of 200 arrives:

- dedupe is per record, so a resent batch overlapping an earlier one by 190
  records stores 10, not 200 duplicates
- a retry re-runs only the records that failed
- one malformed record cannot hold the other 199 hostage

A batch is validated before anything is stored, so it is all-or-nothing at the
door — half-storing a batch and then returning 400 is the worst case, because the
partner retries and you get partial duplicates of a request you rejected.

The cost: `raw_body` for a batched record is the re-serialized element, not the
original request bytes. Everything inside the element is preserved exactly; only
the surrounding whitespace and brackets are lost.

---

## The firehose: accept_types and traffic counters

`accept_types` on a source is a comma-separated allowlist of event types. Empty
or NULL means accept everything, which is the correct **default** — you cannot
decide which of Pulsar's codes matter by reading a spec, you decide by watching
what actually arrives.

That is what the counters are for. `webhook_event_stats` records, per source and
per type, how many were stored and **how many were dropped**. The dropped column
is the entire point: a type you are not storing is otherwise invisible, so
without it you can never safely widen or narrow the filter.

```
GET /api/sync/stats?source=pulsar
```

Two behaviours worth knowing:

- **A filtered record answers 202, never an error.** Anything that looks like a
  failure would make a well-behaved syncer retry the exact traffic you just said
  you did not want, forever.
- **A record with no type at all is always kept**, even under a filter. It cannot
  be matched against the list, and silently dropping the one delivery whose shape
  you did not anticipate is precisely the failure this design exists to avoid.

Counters are buffered in memory and flushed once a minute rather than upserted
per delivery: on a feed carrying every event in a partner's system, one counter
row per type would be the hottest row in the database and every delivery would
queue behind it. A hard restart loses up to one minute of counts. Fine for
statistics, unacceptable for events — which is why events are never treated this
way.

---

## Shape

```
Pulsar syncer
     |
     |  POST https://<app>/api/sync/in/pulsar
     |  X-Nova-Token: <secret>
     |  {"id":"evt_123","event":"call.updated", ...}
     v
routes/sync.js  (inboundRouter, raw body, mounted BEFORE express.json)
     |
     v
utils/webhookIngest.js
     |  1. authenticate against webhook_sources.secret_hash
     |  2. INSERT the raw bytes into webhook_events
     |  3. answer 202 -----------------------------------> back to Pulsar
     |  4. setImmediate -> process out of band
     v
utils/webhookHandlers.js   <- the ONLY file that knows what the JSON means
     |
     v
Nova's real tables
```

`jobs/webhookRetry.js` sweeps once a minute for anything that failed, was never
picked up, or was abandoned mid-processing by a restart.

---

## Files

| File | Role |
|---|---|
| `routes/sync.js` | Public receiver (`inboundRouter`) + admin CRUD (sources, events, stats, replay) |
| `utils/webhookIngest.js` | Auth, storage, dedupe, claim/retry/backoff. Generic. |
| `utils/webhookHandlers.js` | Per-source mapping functions. **The only file you edit per integration.** |
| `jobs/webhookRetry.js` | Retry sweep + payload retention |
| `db.js` | `webhook_sources`, `webhook_events`, `webhook_event_stats` |
| `server.js` | Mounts `/api/sync/in` before `express.json()`; mounts `/api/sync` with the rest |
| `utils/permissions.js` | `view_sync`, `manage_sync` (ship dark — admin/owner only) |

**`utils/webhookIngest.js`, `utils/webhookHandlers.js`, `routes/sync.js` and
`jobs/webhookRetry.js` are NEW files. `git add` them.** A commit that misses one
deploys a `server.js` that requires a module Railway does not have, and the app
MODULE_NOT_FOUNDs on boot.

---

## Adding an integration

Three steps. Only the second one is code.

**1. Create the source.** As an admin:

```
POST /api/sync/sources
{ "name": "Pulsar Syncer", "slug": "pulsar", "dedupe_path": "id", "event_type_path": "event" }
```

The response contains the URL and the token. **The token is shown once and is not
recoverable** — only its SHA-256 is stored. Lost it? `POST /api/sync/sources/:id/rotate`.

**2. Write the handler.** Add a function in `utils/webhookHandlers.js` under the
source's `handler` key (defaults to the slug):

```js
handlers.pulsar = async function (event, ctx) {
  var p = event.payload;
  // ... map into Nova's tables
};
```

Until that function exists, deliveries land with status `parked`. That is the
intended state, not a failure: give Duty the URL today, collect real payloads,
then write the mapping against what actually arrives instead of guessing.

**3. Replay the backlog.**

```
POST /api/sync/replay-batch  { "source": "pulsar", "status": "parked" }
```

---

## The handler contract

```
async function (event, ctx) -> undefined | { note } | { skip: true, note }
```

| | |
|---|---|
| `event.payload` | parsed JSON |
| `event.raw_body` | the exact bytes, for when a partner's shape surprises you |
| `event.event_type` | whatever was at the source's `event_type_path` |
| `event.external_id` | the partner's own id, if they sent one |
| `ctx.pool` | the pg pool |

| Outcome | Status | Behaviour |
|---|---|---|
| return | `done` | — |
| `return { skip: true }` | `skipped` | understood, deliberately ignored |
| `throw` | `failed` | retried: 30s, 2m, 5m, 15m, 1h, 3h, 6h, 12h, then dead-lettered |
| `throw handlers.permanent(msg)` | `failed` | dead-lettered immediately, no retries |

The last row matters. A database blip is a `throw`. A payload we will never be
able to make sense of is a **permanent** throw — retrying that one just writes
the same error into the log eight times.

---

## What Duty gets

Everything below is safe to paste to him as-is.

```
URL     POST https://<your-railway-domain>/api/sync/in/pulsar
Auth    X-Nova-Token: <token>
        (Authorization: Bearer <token> also works if that is easier)
Body    application/json, up to 2 MB

Responses
  202  {"ok":true,"id":9931,"duplicate":false}   accepted and stored
  200  {"ok":true,"id":9931,"duplicate":true}    already had this one, no-op
  400  {"ok":false,"error":"invalid_json"}       do NOT retry, the bytes are bad
  400  {"ok":false,"error":"invalid_batch_item"}  an array element was not an object
  413  {"ok":false,"error":"batch_too_large"}     over 1000 records in one POST
  401  {"ok":false,"error":"unauthorized"}       bad or missing token
  413  {"ok":false,"error":"payload_too_large"}
  503  {"ok":false,"error":"nova_unavailable"}   our fault - please retry
  429  rate limited - back off and retry

Retries
  Retry on 429, 503 and any 5xx, and on a timeout with no response.
  Do NOT retry on 400 or 401.

Duplicates
  Send an "id" field that is stable per event and we will dedupe on it, so
  retrying is always safe. Without one we dedupe on identical bytes inside a
  10-minute window, which is enough to cover a lost-200 retry but not a
  deliberate re-send.

Batching
  A top-level JSON array is supported. We split it and dedupe per record, so
  overlapping batches are safe. Max 1000 records per POST.
  Batch response: {"ok":true,"batch":true,"accepted":N,"duplicates":N,"filtered":N}

Filtering
  We may ignore event types we do not use. Those still answer 202 - a filtered
  record is a success, not an error, so please do not treat it as one and retry.

We answer before we process, so the 202 means "stored, and we will not lose it",
not "acted on".
```

---

## Admin API

| | |
|---|---|
| `GET /api/sync/sources` | list, with event / failed / parked counts and whether a handler is registered |
| `POST /api/sync/sources` | create — **returns the token once** |
| `PUT /api/sync/sources/:id` | rename, enable/disable, change handler or paths |
| `POST /api/sync/sources/:id/rotate` | new token, old one dies immediately |
| `DELETE /api/sync/sources/:id` | removes the config row, **keeps the events** |
| `GET /api/sync/stats?source=` | per-type traffic, **including dropped** — the screen for sizing a firehose |
| `GET /api/sync/events?source=&status=&q=` | event log (no payload bodies — some are megabytes) |
| `GET /api/sync/events/:id` | one event, with the payload and raw body |
| `POST /api/sync/events/:id/replay` | re-run the handler against the stored payload |
| `POST /api/sync/replay-batch` | up to 500 at a time |

Reads need `view_sync`, writes need `manage_sync`. Both ship dark: only admin and
owner have them until someone ticks the box in Settings, and `manage_sync` should
probably stay there — the token it hands out is a standing write path into Nova
from outside.

---

## Environment variables

All optional; the defaults are the intended settings.

| | | |
|---|---|---|
| `SYNC_MAX_BODY_BYTES` | `2097152` | per-delivery size cap |
| `SYNC_RATE_LIMIT` | `600` | deliveries per minute across all sources |
| `SYNC_RETRY_CRON` | `* * * * *` | retry sweep cadence |
| `SYNC_RETRY_BATCH` | `50` | events per sweep |
| `SYNC_MAX_BATCH` | `1000` | records per POST in a top-level array |
| `SYNC_BLIND_DEDUPE_MS` | `600000` | window for id-less duplicate detection |
| `SYNC_STUCK_LEASE_MS` | `900000` | how long before an abandoned event is reclaimed |
| `SYNC_SOURCE_CACHE_MS` | `20000` | source/secret cache TTL (rotation latency) |
| `SYNC_PAYLOAD_RETENTION_DAYS` | unset = forever | drop bodies of processed events after N days |

---

## Design decisions worth remembering

**Mounted before `express.json()`.** The stored `raw_body` must be the exact bytes
that arrived, or hash-based dedupe drifts the moment a partner reorders their JSON
keys — and if a source ever moves to HMAC signing, the signature is computed over
raw bytes that `express.json()` would already have eaten. Same reason
`routes/inbound` and `routes/square` are mounted early.

**An unknown slug returns 401, not 404.** Otherwise the endpoint is a free
directory of every integration we run.

**A disabled source returns 503, not 403.** 403 tells a well-behaved syncer to
give up. Disabling is temporary, so we want it to retry.

**Tokens are stored as SHA-256 and compared in constant time.** The plaintext
exists exactly once, in the create/rotate response.

**Stored headers are a positive allowlist**, not a blocklist. A partner who
invents a new header carrying a credential must not silently end up in our
database.

**`next_attempt_at` doubles as a lease while a row is `processing`.** Without it,
a crash inside a handler leaves the row in `processing` forever, invisible to both
the inline path and the sweep. That is the one failure mode a retry queue cannot
have.

**Deleting a source keeps its events.** The data a partner sent is ours; losing it
because someone tidied up a config row would be the worst kind of surprise.
Disable is almost always the right action.

---

## Porting to another project

The four files are the portable unit. `utils/webhookIngest.js` and
`jobs/webhookRetry.js` are entirely generic — the only Nova-specific things in the
whole set are:

- `require('../db')` for the pg pool
- `requireAuth` / `requirePermission` on the admin routes in `routes/sync.js`
- `logAudit`

Swap those three and the two `CREATE TABLE` statements and it runs anywhere with
Express and Postgres. On a project with no Postgres, `webhook_events` is the only
table that has to exist; the rest is application code.

---

## Open with Duty

1. **Is `autonum` unique and monotonic per event?** It is being used as the
   dedupe key. If it is per-table rather than global, dedupe needs to be
   `dataHeader + autonum` instead.
2. **The full `dataHeader` code list.** 1000/1001/2000/2001 are known; there are
   "LOTS" more. Until it exists, the counters are how the list gets discovered.
3. **Is `dataTarget` ever populated, and with what?** Empty in every sample.
4. **Fetching the actual record.** The envelope is a pointer, so this needs a
   Pulsar API token and an endpoint. Nova has neither.
5. **The subscription he offered.** Filtering on Pulsar's side beats filtering on
   ours: less traffic, less storage, less noise.

---

## Verification (2026-08-13)

`test.js` — fake pg pool, real Express app on a real socket, no database:
**138/138 assertions.** Covers all four auth spellings, wrong/missing token,
unknown slug not being enumerable, disabled source, malformed JSON, empty and
oversize bodies, bare JSON scalars, non-JSON content types, `raw_body` byte
fidelity, id dedupe / nested `dedupe_path` / `X-Event-Id` fallback / blind byte
dedupe inside and outside the window, event-type resolution, the token appearing
nowhere in the stored row, parked-with-no-handler, done / skipped / failed, the
backoff step matching the attempt number, dead-lettering at the end of the
schedule and never being picked up again, permanent throws skipping retries
entirely, replay of a parked backlog in order, orphaned-pending recovery,
live-vs-expired lease reclaim, three concurrent workers claiming one event exactly
once, a dead database answering 503, and the discovery GET being identical for a
real and a fake slug.

Plus, against Duty's real envelope: array splitting, per-record dedupe across
overlapping batches, an all-duplicate batch answering 200, empty arrays, a bad
element rejecting the whole batch with nothing stored, oversize batches,
`dataHeader` surviving as a type whether quoted or bare, the accept list dropping
unwanted types while still answering 202, a typeless record surviving a filter, a
blank accept list meaning accept-everything, dropped types still being counted,
the counter buffer never double counting, every `pulsarId()` sentinel case
(`"0"`, `0`, nil GUID, blank, and `"01"` NOT being a sentinel), an unmapped
`dataHeader` skipping rather than failing, a missing `dataHeader` failing
permanently, and `dataHeader: 0` being treated as a real code rather than as a
missing field.

Two real bugs were caught by that harness and fixed:

1. `processing` rows abandoned by a crash were invisible to the sweep forever
   — fixed with the lease.
2. The catch block re-incremented `attempts`, which `RETURNING *` had already
   incremented, so every event skipped its first backoff step and dead-lettered
   one attempt early.
