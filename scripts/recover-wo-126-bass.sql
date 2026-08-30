-- Un-fold the Bass batch: WO 126 (WO-2026-0114) swallowed 127,128,129,132,133.
-- Ids verified against production 2026-08-28.
-- APPLIED 2026-08-28: ran as a single WITH-CTE statement (Railway's console appends
-- its own LIMIT, which breaks both multi-statement scripts and DO blocks - the
-- statement must END in a SELECT and carry no trailing semicolon).
-- Result: files_moved 5, rows_restored 5, parent_fixed 1, nte_history 0, notes 6.
-- Backups wo_fix_backup_126 / wo_att_backup_126 left in place; drop when happy.
-- Railway's query console appends its own LIMIT, which breaks a multi-statement
-- script, so the work is one DO block (single statement, single transaction).
-- Run the STEP numbers one at a time.

-- STEP 1 - backup (run each line separately)
CREATE TABLE wo_fix_backup_126 AS
  SELECT * FROM work_orders WHERE id IN (126,127,128,129,132,133);

CREATE TABLE wo_att_backup_126 AS
  SELECT id, work_order_id FROM work_order_attachments WHERE work_order_id = 126;


-- STEP 2 - the repair. One statement. All or nothing.
DO $$
BEGIN
  -- Each PDF back to the email it arrived on.
  UPDATE work_order_attachments a
  SET work_order_id = s.id
  FROM work_orders s
  WHERE a.work_order_id = 126
    AND s.id IN (127,128,129,132,133)
    AND substring(a.filename from '[0-9]{6,}') IS NOT NULL
    AND s.email_subject LIKE '%' || substring(a.filename from '[0-9]{6,}') || '%';

  -- Refill the stubs from their own parsed JSON and make them real work orders.
  UPDATE work_orders w
  SET wo_number            = COALESCE(substring(w.email_subject from '[0-9]{6,}'), w.wo_number),
      claim_id             = COALESCE(w.claim_id, NULLIF(w.parsed->>'wo_number','unknown')),
      po_number            = NULLIF(w.parsed->>'po_number','unknown'),
      store_name           = NULLIF(w.parsed->>'store_name','unknown'),
      store_number         = NULLIF(w.parsed->>'store_number','unknown'),
      address              = NULLIF(w.parsed->>'address','unknown'),
      city_state_zip       = NULLIF(w.parsed->>'city_state_zip','unknown'),
      service_requested    = NULLIF(w.parsed->>'service_requested','unknown'),
      service_requested_by = NULLIF(w.parsed->>'service_requested_by','unknown'),
      contact_name         = NULLIF(w.parsed->>'contact_name','unknown'),
      contact_phone        = NULLIF(w.parsed->>'contact_phone','unknown'),
      special_instructions = NULLIF(w.parsed->>'special_instructions','unknown'),
      notes                = NULLIF(w.parsed->>'notes','unknown'),
      confidence           = NULLIF(w.parsed->>'confidence','unknown'),
      needed_by            = CASE WHEN w.parsed->>'needed_by' ~ '^\d{4}-\d{2}-\d{2}$'
                                  THEN (w.parsed->>'needed_by')::date ELSE NULL END,
      account_id           = p.account_id,
      account_number       = p.account_number,
      city_code            = p.city_code,
      status               = 'received',
      revision_of_id       = NULL,
      revision_count       = 0,
      last_revision_at     = NULL,
      updated_at           = NOW()
  FROM work_orders p
  WHERE w.id IN (127,128,129,132,133) AND p.id = 126;

  INSERT INTO work_order_activity (work_order_id, user_id, user_name, type, body)
  SELECT id, NULL, 'System', 'event',
         'Restored to its own work order. It had been folded into WO-2026-0114 as an NTE revision because Bass prints the same site code (S108121C) on every form it sends. These are six different stores.'
  FROM work_orders WHERE id IN (127,128,129,132,133);

  -- The parent gets its own job number back; the site code moves to claim_id.
  UPDATE work_orders
  SET wo_number      = COALESCE(substring(email_subject from '[0-9]{6,}'), wo_number),
      claim_id       = COALESCE(claim_id, NULLIF(parsed->>'wo_number','unknown')),
      nte_amount     = CASE WHEN COALESCE(parsed->>'nte_amount','') ~ '[0-9]'
                            THEN NULLIF(regexp_replace(COALESCE(parsed->>'nte_amount',''),'[^0-9.]','','g'),'')::numeric
                            ELSE nte_amount END,
      revision_count = 0, last_revision_at = NULL, updated_at = NOW()
  WHERE id = 126;

  DELETE FROM work_order_nte_history
  WHERE work_order_id = 126 AND source = 'email' AND revision_wo_id IN (127,128,129,132,133);

  INSERT INTO work_order_activity (work_order_id, user_id, user_name, type, body)
  VALUES (126, NULL, 'System', 'event',
          'NTE and revision history corrected: five separate work orders had been wrongly folded into this one and have been restored.');
END $$;


-- STEP 3 - verify
SELECT w.id, w.wo_ref, w.status, w.revision_of_id, w.wo_number, w.claim_id,
       w.store_name, w.nte_amount,
       (SELECT count(*) FROM work_order_attachments a WHERE a.work_order_id = w.id) AS files
FROM work_orders w WHERE w.id IN (126,127,128,129,132,133) ORDER BY w.id;


-- STEP 4 - only if STEP 3 looks wrong. Puts everything back exactly as it was.
-- UPDATE work_order_attachments a SET work_order_id = b.work_order_id
--   FROM wo_att_backup_126 b WHERE a.id = b.id;
-- UPDATE work_orders w SET status = b.status, revision_of_id = b.revision_of_id,
--   wo_number = b.wo_number, claim_id = b.claim_id, po_number = b.po_number,
--   store_name = b.store_name, store_number = b.store_number, address = b.address,
--   city_state_zip = b.city_state_zip, service_requested = b.service_requested,
--   service_requested_by = b.service_requested_by, contact_name = b.contact_name,
--   contact_phone = b.contact_phone, special_instructions = b.special_instructions,
--   notes = b.notes, confidence = b.confidence, needed_by = b.needed_by,
--   account_id = b.account_id, account_number = b.account_number, city_code = b.city_code,
--   nte_amount = b.nte_amount, revision_count = b.revision_count,
--   last_revision_at = b.last_revision_at
--   FROM wo_fix_backup_126 b WHERE w.id = b.id;

-- STEP 5 - once you are happy, days later:
-- DROP TABLE wo_fix_backup_126;  DROP TABLE wo_att_backup_126;
