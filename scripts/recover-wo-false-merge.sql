-- ---------------------------------------------------------------------------
-- Recover work orders that were wrongly folded together as "NTE revisions".
--
-- Cause: findRevisionTarget() merged on wo_number + account alone. Bass Pro
-- prints one site code (S108121C) on every form it sends, so six separately
-- sent work orders parsed to the same wo_number and five were folded into the
-- first, taking their PDFs with them.
--
-- This script un-folds them: it gives each stub its attachments, its own
-- fields and its own row back, and rolls the parent's NTE and revision count
-- back to what its own form said.
--
-- HOW TO RUN
--   1. Deploy the code fix FIRST. Until it is live, the next mailbox poll can
--      re-merge anything this script separates.
--   2. Run STEP 0 on its own and read it.
--   3. Run STEP 1 through STEP 7 as one block. It ends with ROLLBACK on
--      purpose. Read the STEP 7 output, then change ROLLBACK to COMMIT and
--      run it again.
--   4. In Nova, open each recovered work order and press "Re-parse with AI"
--      so wo_number is re-read now that the parser can see the subject line.
--
-- The group is set in ONE place: the g_parent value in STEP 1. It is 126 for
-- the Bass batch. Everything else follows from it.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- STEP 0 - INSPECT. Read-only. Run this by itself first.
-- ===========================================================================
SELECT COALESCE(w.revision_of_id, w.id) AS group_id,
       w.id, w.wo_ref, w.status, w.email_subject,
       w.wo_number, w.po_number, w.address, w.nte_amount,
       (SELECT count(*) FROM work_order_attachments a WHERE a.work_order_id = w.id) AS files
FROM work_orders w
WHERE COALESCE(w.revision_of_id, w.id) = 126
ORDER BY w.id;

-- Which PDF is going where. Every stub should claim at least one file.
SELECT a.id AS attachment_id, a.work_order_id AS currently_on, a.filename,
       substring(a.filename from '[0-9]{6,}') AS number_in_filename,
       (SELECT s.wo_ref FROM work_orders s
         WHERE (s.id = 126 OR s.revision_of_id = 126)
           AND substring(a.filename from '[0-9]{6,}') IS NOT NULL
           AND s.email_subject LIKE '%' || substring(a.filename from '[0-9]{6,}') || '%'
         LIMIT 1) AS will_move_to
FROM work_order_attachments a
WHERE a.work_order_id = 126
ORDER BY a.id;
-- If will_move_to is NULL for every row, the filenames do not carry the job
-- number. Stop here and tell me - the fallback is to split them by insertion
-- order instead, and I would rather write that against what you actually see.


-- ===========================================================================
-- STEP 1 - Pin the group down before anything is edited.
-- ===========================================================================
BEGIN;

CREATE TEMP TABLE fix_group ON COMMIT DROP AS
SELECT 126::int AS g_parent;

CREATE TEMP TABLE fix_stubs ON COMMIT DROP AS
SELECT w.id, w.wo_ref, w.email_subject, w.nte_amount
FROM work_orders w, fix_group g
WHERE w.revision_of_id = g.g_parent
  AND w.status = 'superseded';


-- ===========================================================================
-- STEP 2 - Send each PDF back to the email it arrived on.
-- Matched on the job number in the filename against the number in the subject.
-- Anything that does not match stays on the parent, which is where its own
-- form belongs.
-- ===========================================================================
UPDATE work_order_attachments a
SET work_order_id = s.id
FROM fix_stubs s, fix_group g
WHERE a.work_order_id = g.g_parent
  AND substring(a.filename from '[0-9]{6,}') IS NOT NULL
  AND s.email_subject LIKE '%' || substring(a.filename from '[0-9]{6,}') || '%';


-- ===========================================================================
-- STEP 3 - Refill the stub rows.
--
-- applyRevision() returned before the big field UPDATE ran, so these rows only
-- ever got parsed / account_name / wo_number / nte_amount. Everything a
-- dispatcher needs is sitting unused in the parsed JSONB. wo_number comes from
-- the SUBJECT, because the subject is the only place the real job number was
-- ever written.
-- ===========================================================================
UPDATE work_orders w
SET wo_number           = COALESCE(substring(w.email_subject from '[0-9]{6,}'), w.wo_number),
    claim_id            = COALESCE(w.claim_id, NULLIF(w.parsed->>'wo_number', 'unknown')),
    po_number           = NULLIF(w.parsed->>'po_number', 'unknown'),
    store_name          = NULLIF(w.parsed->>'store_name', 'unknown'),
    store_number        = NULLIF(w.parsed->>'store_number', 'unknown'),
    address             = NULLIF(w.parsed->>'address', 'unknown'),
    city_state_zip      = NULLIF(w.parsed->>'city_state_zip', 'unknown'),
    service_requested   = NULLIF(w.parsed->>'service_requested', 'unknown'),
    service_requested_by= NULLIF(w.parsed->>'service_requested_by', 'unknown'),
    contact_name        = NULLIF(w.parsed->>'contact_name', 'unknown'),
    contact_phone       = NULLIF(w.parsed->>'contact_phone', 'unknown'),
    special_instructions= NULLIF(w.parsed->>'special_instructions', 'unknown'),
    notes               = NULLIF(w.parsed->>'notes', 'unknown'),
    confidence          = NULLIF(w.parsed->>'confidence', 'unknown'),
    needed_by           = CASE WHEN w.parsed->>'needed_by' ~ '^\d{4}-\d{2}-\d{2}$'
                               THEN (w.parsed->>'needed_by')::date ELSE NULL END,
    account_id          = p.account_id,
    account_number      = p.account_number,
    city_code           = p.city_code,
    updated_at          = NOW()
FROM fix_stubs s, fix_group g, work_orders p
WHERE w.id = s.id AND p.id = g.g_parent;


-- ===========================================================================
-- STEP 4 - Let them be their own jobs again.
-- ===========================================================================
UPDATE work_orders w
SET status = 'received', revision_of_id = NULL,
    revision_count = 0, last_revision_at = NULL, updated_at = NOW()
FROM fix_stubs s
WHERE w.id = s.id;

INSERT INTO work_order_activity (work_order_id, user_id, user_name, type, body)
SELECT s.id, NULL, 'System', 'event',
       'Restored to its own work order. It had been folded into ' || p.wo_ref ||
       ' as an NTE revision because both forms print the same work order number. ' ||
       'They are different jobs.'
FROM fix_stubs s, fix_group g, work_orders p
WHERE p.id = g.g_parent;


-- ===========================================================================
-- STEP 5 - Give the parent its own NTE back.
-- Each fold stomped nte_amount, so the parent is currently showing whichever
-- revision landed last. Its own form is in its own parsed JSON.
-- ===========================================================================
UPDATE work_orders w
SET nte_amount = CASE WHEN COALESCE(w.parsed->>'nte_amount','') ~ '[0-9]'
                      THEN NULLIF(regexp_replace(COALESCE(w.parsed->>'nte_amount',''), '[^0-9.]', '', 'g'), '')::numeric
                      ELSE w.nte_amount END,
    -- The parent is carrying the shared site code too. Give it the number off its own
    -- subject line and park the site code in claim_id, same as the stubs.
    wo_number = COALESCE(substring(w.email_subject from '[0-9]{6,}'), w.wo_number),
    claim_id  = COALESCE(w.claim_id, NULLIF(w.parsed->>'wo_number', 'unknown')),
    revision_count = 0, last_revision_at = NULL, updated_at = NOW()
FROM fix_group g
WHERE w.id = g.g_parent;

DELETE FROM work_order_nte_history h
USING fix_group g
WHERE h.work_order_id = g.g_parent
  AND h.source = 'email'
  AND h.revision_wo_id IN (SELECT id FROM fix_stubs);

INSERT INTO work_order_activity (work_order_id, user_id, user_name, type, body)
SELECT g.g_parent, NULL, 'System', 'event',
       'NTE and revision history corrected: ' || (SELECT count(*) FROM fix_stubs) ||
       ' separate work orders had been wrongly folded into this one and have been restored.'
FROM fix_group g;


-- ===========================================================================
-- STEP 6 - Make sure nothing else in the database has the same problem.
-- Any row listed here is a fold where the two jobs disagree on PO or street
-- number, which is the same failure under a different account.
-- ===========================================================================
SELECT s.id AS stub_id, s.wo_ref AS stub, s.email_subject,
       p.id AS parent_id, p.wo_ref AS parent,
       s.po_number AS stub_po, p.po_number AS parent_po,
       s.address AS stub_addr, p.address AS parent_addr
FROM work_orders s
JOIN work_orders p ON p.id = s.revision_of_id
WHERE s.revision_of_id IS NOT NULL
  AND (
    (s.po_number IS NOT NULL AND p.po_number IS NOT NULL
      AND upper(regexp_replace(s.po_number,'[^A-Za-z0-9]','','g')) <> upper(regexp_replace(p.po_number,'[^A-Za-z0-9]','','g')))
    OR
    (substring(s.address from '^\s*(\d+)') IS NOT NULL AND substring(p.address from '^\s*(\d+)') IS NOT NULL
      AND substring(s.address from '^\s*(\d+)') <> substring(p.address from '^\s*(\d+)'))
  )
ORDER BY p.id, s.id;


-- ===========================================================================
-- STEP 7 - Read this before you commit.
-- ===========================================================================
SELECT w.id, w.wo_ref, w.status, w.revision_of_id, w.email_subject,
       w.wo_number, w.po_number, w.address, w.nte_amount,
       (SELECT count(*) FROM work_order_attachments a WHERE a.work_order_id = w.id) AS files
FROM work_orders w, fix_group g
WHERE w.id = g.g_parent OR w.id IN (SELECT id FROM fix_stubs)
ORDER BY w.id;
-- Expect: six rows, all status 'received', all revision_of_id NULL, a distinct
-- wo_number and PO on each, and files >= 1 on every row. If any row shows
-- files = 0 its PDF did not match by filename - ROLLBACK and tell me.

ROLLBACK;  -- change to COMMIT once STEP 7 looks right
