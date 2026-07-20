# Offboarding API Quick Reference

## Endpoints by Category

### Lifecycle Management

#### List Offboardings
```
GET /api/offboarding
Query params: status, type, year
Auth: Required (view_offboarding)
Returns: Array of offboarding objects with user info + step counts
```

#### Create Offboarding (Start Wizard)
```
POST /api/offboarding
Auth: Required (manage_offboarding)
Body: {
  user_id: number,
  type: "voluntary|involuntary|job_abandonment|retirement|end_of_contract|other",
  notice_date: "YYYY-MM-DD",
  last_day: "YYYY-MM-DD",
  deactivate_mode: "end_of_last_day|immediate|on_finalize",
  reason_category: "pay|schedule-hours|management|better-opportunity|personal-family|other",
  reason_notes: "string",
  eligible_for_rehire: boolean,
  rehire_notes: "string"
}
Returns: { id, user_id, status: "draft", ... }
```

#### Get Offboarding Detail
```
GET /api/offboarding/:id
Auth: Required (view_offboarding)
Returns: Full offboarding object with steps + events array
```

#### Begin Offboarding (Draft → Active)
```
POST /api/offboarding/:id/begin
Auth: Required (manage_offboarding)
Effect: Composes templates → creates frozen steps → status = "active"
Returns: Updated offboarding object
```

#### Cancel Offboarding
```
POST /api/offboarding/:id/cancel
Auth: Required (manage_offboarding)
Body: { reason: "string" }
Effect: status = "cancelled" (terminal state)
Returns: Updated offboarding object
```

#### Finalize Offboarding (Active → Archived)
```
POST /api/offboarding/:id/finalize
Auth: Required (manage_offboarding)
Blocks: If any required steps are "pending"
Effect: status = "finalized", archives packet
Returns: { success: true, finalized_at: timestamp }
```

---

### Step Management

#### List Steps for Offboarding
```
GET /api/offboarding/:id/steps
Auth: Required (view_offboarding)
Returns: Array of frozen steps with status + completion details
```

#### Complete Step (Manual)
```
POST /api/offboarding/:id/steps/:step_id/complete
Auth: Required (manage_offboarding)
Body: { note: "string (optional)" }
Effect: status = "done", completed_at = NOW()
Returns: Updated step object
```

#### Skip Step
```
POST /api/offboarding/:id/steps/:step_id/skip
Auth: Required (manage_offboarding)
Body: { reason: "string (required)" }
Effect: status = "skipped", skip_reason stored
Returns: Updated step object
```

---

### Automation Execution

#### Run Automation
```
POST /api/offboarding/:id/run/:auto_key
Auth: Required (manage_offboarding)
Supported auto_key values:
  - deactivate_user: Deactivate account + purge sessions
  - clear_future_shifts: Delete all future shifts
  - cancel_future_pto: Cancel PTO + snapshot balance
  - vault_sweep: Identify credentials to rotate
  - reassign_open_tasks: Move pending tasks to manager
  - pto_payout_note: Log PTO balance
  - completion_packet: Generate HTML packet
  - timeclock_final_check: Validate timesheet entries

Effect: Executes automation + marks step as "done" + logs event
Returns: { success: true, action: "...", result: {...} }
```

---

### Exit Interviews (Public Access)

#### Load Exit Form (Public, No Auth)
```
GET /api/offboarding/exit/:token
Query params: (none)
Effect: Validates token + returns form questions
Returns: {
  id: number,
  offboarding_id: number,
  questions: [
    { id, prompt, qtype: "radio|select|text", options: {...} }
  ]
}
Error 404: Token not found or expired
Error 410: Token expired
```

#### Submit Exit Form (Public, No Auth)
```
POST /api/offboarding/exit/:token
Body: {
  would_return: "yes|maybe|probably_not|no",
  responses: [
    { question_id: number, value: "string|number" }
  ]
}
Effect: Creates exit_interview_answers + sets submitted_at
Returns: { success: true, submitted_at: timestamp }
Error 404: Token not found
Error 410: Token expired
```

---

### Exit Interview Responses & Insights

#### List All Response Records
```
GET /api/exit-interviews
Auth: Required (view_exit_interviews)
Returns: Array of { name, role, would_return, submitted_at, ... }
```

#### Get Single Response Detail
```
GET /api/exit-interviews/:interview_id
Auth: Required (view_exit_interviews)
Returns: Full interview object + all answers
```

#### Get Insights Dashboard
```
GET /api/exit-interviews/insights
Auth: Required (view_exit_interviews)
Returns: {
  total_finalized: number,
  departures_by_role: [ { role, count } ],
  would_return_trend: [ { would_return, count } ],
  reasons_by_type: [ { reason, count } ]
}
```

---

### Templates & Questions (Admin Only)

#### List Templates
```
GET /api/offboarding/templates
Auth: Required (manage_offboarding)
Returns: Array of templates with nested steps
```

#### Create Template
```
POST /api/offboarding/templates
Auth: Required (manage_offboarding)
Body: {
  name: "string",
  roles: [null for core | "field"|"coordinator"|"manager"|"admin"],
  employment_types: ["full_time"|"part_time"|null]
}
Returns: Created template object
```

#### Get Questions Bank
```
GET /api/offboarding/questions
Auth: Required (manage_offboarding)
Returns: Array of question objects
```

#### Create/Edit Question
```
POST /api/offboarding/questions
Auth: Required (manage_offboarding)
Body: {
  prompt: "string",
  qtype: "radio|select|text",
  options: { options: ["opt1", "opt2"] } (if radio/select),
  active: boolean
}
Returns: Created/updated question object
```

---

## Common Response Patterns

### Success Response
```json
{
  "id": 42,
  "user_id": 5,
  "name": "John Doe",
  "type": "voluntary",
  "status": "active",
  "last_day": "2026-08-15",
  "total_steps": 21,
  "done_steps": 7,
  "created_at": "2026-07-18T12:00:00Z"
}
```

### Error Response
```json
{
  "error": "Descriptive message",
  "code": "error_code" (optional)
}
```

### Event Log Entry
```json
{
  "id": 1,
  "offboarding_id": 42,
  "actor_id": 3,
  "kind": "auto_deactivate_user|manual_complete|status_change|...",
  "detail": { "result": "...", "meta": "..." },
  "created_at": "2026-07-18T12:30:00Z"
}
```

---

## Status Values

**Offboarding Status:**
- `draft` - Created, not yet started
- `active` - In progress, steps being completed
- `pending_finalize` - All steps done, waiting for final sign-off
- `finalized` - Complete, archived
- `cancelled` - Terminated early (terminal)

**Step Status:**
- `pending` - Waiting to be completed
- `done` - Completed successfully
- `skipped` - Skipped with reason

**Exit Interview Status:**
- `draft` - Form not sent yet
- `sent` - Token created, awaiting response
- `submitted` - Response received and stored
- `waived` - Opted out

---

## Permission Requirements Summary

| Endpoint | Required Permission |
|----------|-------------------|
| GET /offboarding | view_offboarding |
| POST /offboarding | manage_offboarding |
| POST /offboarding/:id/begin | manage_offboarding |
| POST /offboarding/:id/cancel | manage_offboarding |
| POST /offboarding/:id/steps/*/complete | manage_offboarding |
| POST /offboarding/:id/run/* | manage_offboarding |
| POST /offboarding/:id/finalize | manage_offboarding |
| GET /offboarding/exit/:token | (none - public) |
| POST /offboarding/exit/:token | (none - public) |
| GET /exit-interviews | view_exit_interviews |
| GET /offboarding/templates | manage_offboarding |
| POST /offboarding/templates | manage_offboarding |

---

## Example Workflows

### Typical Offboarding Flow
```
1. POST /api/offboarding (create in draft)
2. POST /api/offboarding/:id/begin (transition to active + create steps)
3. POST /api/offboarding/:id/steps/:sid/complete (manual steps)
4. POST /api/offboarding/:id/run/vault_sweep (automations)
5. POST /api/offboarding/:id/run/completion_packet (generate packet)
6. POST /api/offboarding/:id/finalize (archive)
```

### Exit Interview Flow (Employee)
```
1. Receive email with link: /api/offboarding/exit/{token}
2. GET /api/offboarding/exit/{token} (load form)
3. POST /api/offboarding/exit/{token} (submit responses)
```

### Insights Flow (Admin)
```
1. GET /api/exit-interviews (load response list)
2. GET /api/exit-interviews/insights (load dashboard)
3. View trends + identify patterns
```

---

## Testing Tips

- **Empty Org**: Create test user first with role assigned
- **Token Testing**: Use 30-day window for exit form links
- **Permissions**: Ensure user has view_offboarding + manage_offboarding
- **Automations**: Run deactivate_user on immediate mode to test instantly
- **Cron Jobs**: Check server logs for job execution messages
