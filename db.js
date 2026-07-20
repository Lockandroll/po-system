const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal') ? false : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false),
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on('error', function (err) { console.error('Unexpected idle DB client error:', err.message); });

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS users (' +
      '  id SERIAL PRIMARY KEY,' +
      '  email VARCHAR(255) UNIQUE NOT NULL,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  password_hash VARCHAR(255) NOT NULL,' +
      "  role VARCHAR(50) NOT NULL DEFAULT 'locksmith'," +
      '  created_at TIMESTAMP DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS purchase_orders (' +
      '  id SERIAL PRIMARY KEY,' +
      '  po_number VARCHAR(50) UNIQUE NOT NULL,' +
      '  requester_id INTEGER REFERENCES users(id),' +
      '  vendor_name VARCHAR(255) NOT NULL,' +
      '  notes TEXT,' +
      "  status VARCHAR(50) NOT NULL DEFAULT 'draft'," +
      '  approver_id INTEGER REFERENCES users(id),' +
      '  approved_at TIMESTAMP,' +
      '  rejection_reason TEXT,' +
      '  total_amount DECIMAL(10,2) DEFAULT 0,' +
      '  created_at TIMESTAMP DEFAULT NOW(),' +
      '  updated_at TIMESTAMP DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS po_line_items (' +
      '  id SERIAL PRIMARY KEY,' +
      '  po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,' +
      '  description VARCHAR(500) NOT NULL,' +
      '  quantity DECIMAL(10,2) NOT NULL,' +
      '  unit_price DECIMAL(10,2) NOT NULL' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS cities (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  code CHAR(3) NOT NULL UNIQUE,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  created_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS settings (' +
      '  key VARCHAR(100) PRIMARY KEY,' +
      '  value TEXT,' +
      '  updated_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS quotes (' +
      '  id SERIAL PRIMARY KEY,' +
      '  quote_number VARCHAR(50) UNIQUE NOT NULL,' +
      '  requester_id INTEGER REFERENCES users(id),' +
      '  customer_name VARCHAR(255) NOT NULL,' +
      '  city_code CHAR(3),' +
      '  notes TEXT,' +
      '  total_amount DECIMAL(10,2) DEFAULT 0,' +
      '  created_at TIMESTAMP DEFAULT NOW(),' +
      '  updated_at TIMESTAMP DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS quote_line_items (' +
      '  id SERIAL PRIMARY KEY,' +
      '  quote_id INTEGER REFERENCES quotes(id) ON DELETE CASCADE,' +
      '  item_number VARCHAR(100),' +
      '  manufacturer VARCHAR(255),' +
      '  description VARCHAR(500) NOT NULL,' +
      '  quantity DECIMAL(10,2) NOT NULL,' +
      '  unit_price DECIMAL(10,2) NOT NULL' +
      ');'
    );
    await client.query(
      'ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255);' +
      'ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS city_code CHAR(3);' +
      "ALTER TABLE cities ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT '#f97316';" +
      'ALTER TABLE cities ADD COLUMN IF NOT EXISTS invoice_prefix INTEGER;' +
      // Primary manager for the city. Customer feedback is assigned here first;
      // without it, intake guesses a manager and flags the record needs_review.
      'ALTER TABLE cities ADD COLUMN IF NOT EXISTS manager_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;' +
      'ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS item_number VARCHAR(100);' +
      'ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(255);' +
      'ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255);' +
      // Per-line "requested by" so multi-locksmith cities can sort parts by tech when a
      // shipment lands. Carried from running_list_items.requester_id when a running list
      // is pushed to a PO (see routes/running.js) and preserved through PO edits.
      'ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL;' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);' +
      // Bumped on password reset to invalidate all previously-issued sessions.
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch INTEGER DEFAULT 0;' +
      'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS important_info TEXT;' +
      'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,2) DEFAULT 0;' +
      'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10,2) DEFAULT 0;' +
      'ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS list_price DECIMAL(10,2);' +
      'ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS taxable BOOLEAN DEFAULT false;' +
      'ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS orderer_id INTEGER REFERENCES users(id);' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS receive_emails BOOLEAN NOT NULL DEFAULT true;' +
      'ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS shipping_address_id INTEGER;' +
      'ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS url TEXT;'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS shipping_addresses (' +
      '  id SERIAL PRIMARY KEY,' +
      '  city_code CHAR(3) NOT NULL,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  address TEXT NOT NULL,' +
      '  created_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS vendors (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  website VARCHAR(255),' +
      '  account_number VARCHAR(255),' +
      '  username VARCHAR(255),' +
      '  password TEXT,' +
      '  notes TEXT,' +
      '  created_at TIMESTAMP DEFAULT NOW(),' +
      '  updated_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS audit_logs (' +
      '  id SERIAL PRIMARY KEY,' +
      '  entity_type VARCHAR(20) NOT NULL,' +
      '  entity_id INTEGER,' +
      '  entity_number VARCHAR(50),' +
      '  action VARCHAR(50) NOT NULL,' +
      '  user_id INTEGER,' +
      '  user_name VARCHAR(255),' +
      '  details TEXT,' +
      '  created_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS ai_conversations (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER,' +
      '  user_name VARCHAR(255),' +
      '  question TEXT,' +
      '  response TEXT,' +
      '  has_image BOOLEAN DEFAULT false,' +
      '  created_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS ai_usage (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER,' +
      '  user_name VARCHAR(255),' +
      '  message_date DATE DEFAULT CURRENT_DATE,' +
      '  message_count INTEGER DEFAULT 0,' +
      '  updated_at TIMESTAMP DEFAULT NOW(),' +
      '  UNIQUE(user_id, message_date)' +
      ');' +
      'CREATE TABLE IF NOT EXISTS ai_monthly_usage (' +
      '  id SERIAL PRIMARY KEY,' +
      '  month_year VARCHAR(7) UNIQUE,' +
      '  message_count INTEGER DEFAULT 0' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS vehicles (' +
      '  id SERIAL PRIMARY KEY,' +
      '  year INTEGER NOT NULL,' +
      '  make_model VARCHAR(255) NOT NULL,' +
      '  vin VARCHAR(17),' +
      '  key_codes VARCHAR(100),' +
      '  assigned_user_id INTEGER REFERENCES users(id),' +
      '  city_code CHAR(3),' +
      '  date_of_assignment DATE,' +
      '  license_plate VARCHAR(20),' +
      '  mileage INTEGER,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  notes TEXT,' +
      '  created_at TIMESTAMP DEFAULT NOW(),' +
      '  updated_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS vehicle_repairs (' +
      '  id SERIAL PRIMARY KEY,' +
      '  vr_number VARCHAR(50) UNIQUE NOT NULL,' +
      '  requester_id INTEGER REFERENCES users(id),' +
      '  vehicle_id INTEGER REFERENCES vehicles(id),' +
      '  assigned_user_id INTEGER REFERENCES users(id),' +
      '  vehicle VARCHAR(255) NOT NULL,' +
      '  vin_last6 CHAR(6),' +
      '  shop_name VARCHAR(255),' +
      '  city_code CHAR(3),' +
      '  notes TEXT,' +
      "  status VARCHAR(50) NOT NULL DEFAULT 'draft'," +
      '  approver_id INTEGER REFERENCES users(id),' +
      '  approved_at TIMESTAMP,' +
      '  rejection_reason TEXT,' +
      '  total_amount DECIMAL(10,2) DEFAULT 0,' +
      '  created_at TIMESTAMP DEFAULT NOW(),' +
      '  updated_at TIMESTAMP DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS vr_line_items (' +
      '  id SERIAL PRIMARY KEY,' +
      '  vr_id INTEGER REFERENCES vehicle_repairs(id) ON DELETE CASCADE,' +
      '  description VARCHAR(500) NOT NULL,' +
      '  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,' +
      '  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0' +
      ');'
    );
    // Indexes on the hot child FKs (line items are always fetched by parent id).
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_line_items(po_id);' +
      'CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON quote_line_items(quote_id);' +
      'CREATE INDEX IF NOT EXISTS idx_vr_items_vr ON vr_line_items(vr_id);'
    );
    await client.query(
      'ALTER TABLE vehicle_repairs ADD COLUMN IF NOT EXISTS vehicle_id INTEGER REFERENCES vehicles(id);' +
      'ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS sold_to VARCHAR(255);' +
      'ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS sold_for DECIMAL(10,2);' +
      'ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS sold_date DATE;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS rep_name VARCHAR(255);' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS rep_email VARCHAR(255);' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS rep_phone VARCHAR(50);' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS receive_sms BOOLEAN NOT NULL DEFAULT false;'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS vehicle_inspections (' +
      '  id SERIAL PRIMARY KEY,' +
      '  inspection_number VARCHAR(50) UNIQUE NOT NULL,' +
      '  vehicle_id INTEGER REFERENCES vehicles(id),' +
      '  period_month CHAR(7) NOT NULL,' +
      '  submitted_by INTEGER REFERENCES users(id),' +
      '  city_code CHAR(3),' +
      '  mileage INTEGER,' +
      "  status VARCHAR(30) NOT NULL DEFAULT 'submitted'," +
      "  overall_result VARCHAR(20) DEFAULT 'pass'," +
      '  reviewer_id INTEGER REFERENCES users(id),' +
      '  reviewed_at TIMESTAMP,' +
      '  notes TEXT,' +
      '  created_at TIMESTAMP DEFAULT NOW(),' +
      '  updated_at TIMESTAMP DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS inspection_items (' +
      '  id SERIAL PRIMARY KEY,' +
      '  inspection_id INTEGER REFERENCES vehicle_inspections(id) ON DELETE CASCADE,' +
      '  item_key VARCHAR(60),' +
      '  label VARCHAR(255),' +
      '  answer VARCHAR(60),' +
      '  color VARCHAR(20),' +
      '  comment TEXT' +
      ');' +
      'CREATE TABLE IF NOT EXISTS inspection_photos (' +
      '  id SERIAL PRIMARY KEY,' +
      '  inspection_id INTEGER REFERENCES vehicle_inspections(id) ON DELETE CASCADE,' +
      '  item_key VARCHAR(60),' +
      '  name VARCHAR(255),' +
      '  r2_key VARCHAR(500),' +
      '  mime_type VARCHAR(255),' +
      '  size_bytes BIGINT DEFAULT 0,' +
      '  caption VARCHAR(255),' +
      '  uploaded_by INTEGER REFERENCES users(id),' +
      '  uploaded_by_name VARCHAR(255),' +
      "  status VARCHAR(20) DEFAULT 'pending'," +
      '  created_at TIMESTAMP DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS inspection_checklist (' +
      '  id SERIAL PRIMARY KEY,' +
      '  item_key VARCHAR(60) UNIQUE NOT NULL,' +
      '  label VARCHAR(255) NOT NULL,' +
      "  type VARCHAR(20) NOT NULL DEFAULT 'dropdown'," +
      '  sort_order INTEGER DEFAULT 0,' +
      '  requires_photo BOOLEAN NOT NULL DEFAULT false,' +
      '  options JSONB,' +
      '  active BOOLEAN NOT NULL DEFAULT true' +
      ');' +
      'ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS inspection_exempt BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS inspection_exempt_reason VARCHAR(255);' +
      'ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS inspector_id INTEGER REFERENCES users(id);' +
      'ALTER TABLE inspection_checklist ADD COLUMN IF NOT EXISTS options JSONB;' +
      'ALTER TABLE inspection_items ADD COLUMN IF NOT EXISTS color VARCHAR(20);' +
      'ALTER TABLE inspection_items ALTER COLUMN answer TYPE VARCHAR(60);' +
      'ALTER TABLE vehicle_inspections ADD COLUMN IF NOT EXISTS followup_task_id INTEGER;' +
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_insp_vehicle_month ON vehicle_inspections(vehicle_id, period_month);' +
      'CREATE INDEX IF NOT EXISTS idx_insp_period ON vehicle_inspections(period_month);' +
      'CREATE INDEX IF NOT EXISTS idx_insp_items_insp ON inspection_items(inspection_id);' +
      'CREATE INDEX IF NOT EXISTS idx_insp_photos_insp ON inspection_photos(inspection_id);'
    );
    // Seed the default monthly inspection checklist once (only when empty).
    await client.query(
      'INSERT INTO inspection_checklist (item_key, label, type, sort_order, requires_photo, active, options) ' +
      'SELECT s.item_key, s.label, s.type, s.sort_order, s.requires_photo, s.active, s.options::jsonb FROM (VALUES ' +
      "  ('exterior','Exterior / body condition (dents, damage)','dropdown',10,true,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('tires','Tires & tread depth','dropdown',20,true,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('lights','Lights & turn signals','dropdown',30,false,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('brakes','Brakes','dropdown',40,false,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('fluids','Fluid levels (oil, coolant, washer)','dropdown',50,false,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('wipers','Wipers & windshield','dropdown',60,false,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('horn_mirrors','Horn & mirrors','dropdown',70,false,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('seatbelts','Seatbelts','dropdown',80,false,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('registration','Registration & insurance in vehicle','dropdown',90,false,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('cleanliness','Interior / exterior cleanliness','dropdown',100,false,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('odometer','Odometer reading photo','dropdown',110,true,true,'[{\"label\":\"OK\",\"color\":\"green\"},{\"label\":\"Needs attention\",\"color\":\"yellow\"},{\"label\":\"Fail\",\"color\":\"red\"},{\"label\":\"N/A\",\"color\":\"gray\"}]')," +
      "  ('concerns','Other concerns / notes','text',120,false,true,NULL) " +
      ') AS s(item_key,label,type,sort_order,requires_photo,active,options) ' +
      'WHERE NOT EXISTS (SELECT 1 FROM inspection_checklist);'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS suggestions (' +
      '  id SERIAL PRIMARY KEY,' +
      '  category VARCHAR(100) NOT NULL,' +
      '  suggestion TEXT NOT NULL,' +
      '  anonymous BOOLEAN NOT NULL DEFAULT false,' +
      '  submitter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  submitter_name VARCHAR(255),' +
      "  status VARCHAR(50) NOT NULL DEFAULT 'open'," +
      '  admin_notes TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Account lockout + password reset
    await client.query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS lockout_until TIMESTAMPTZ;'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS password_resets (' +
      '  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,' +
      '  token VARCHAR(64) NOT NULL,' +
      '  expires_at TIMESTAMPTZ NOT NULL,' +
      '  used BOOLEAN NOT NULL DEFAULT false,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS two_factor_codes (' +
      '  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,' +
      '  code VARCHAR(64) NOT NULL,' +
      '  expires_at TIMESTAMPTZ NOT NULL,' +
      '  used BOOLEAN NOT NULL DEFAULT false,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'ALTER TABLE two_factor_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;'
    );
    await client.query(
      'ALTER TABLE two_factor_codes ALTER COLUMN code TYPE VARCHAR(64);'
    );
    // Trusted devices — remembered-device tokens ("don't challenge for 30 days")
    await client.query(
      'CREATE TABLE IF NOT EXISTS trusted_devices (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  token_hash VARCHAR(64) NOT NULL,' +
      '  label VARCHAR(255),' +
      '  ip VARCHAR(64),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  last_used_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  expires_at TIMESTAMPTZ NOT NULL' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_trusted_devices_hash ON trusted_devices(token_hash);'
    );
    // Parts catalog — master list of parts (item number is vendor-specific)
    await client.query(
      'CREATE TABLE IF NOT EXISTS parts (' +
      '  id SERIAL PRIMARY KEY,' +
      '  item_number VARCHAR(150),' +
      '  alias VARCHAR(150),' +
      '  description VARCHAR(500) NOT NULL,' +
      '  price DECIMAL(10,2),' +
      '  preferred_vendor VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_parts_item_number ON parts(item_number);' +
      'CREATE INDEX IF NOT EXISTS idx_parts_alias ON parts(alias);'
    );
    // Running list (monthly accumulating items that get rolled into a PO per city)
    await client.query(
      'CREATE TABLE IF NOT EXISTS running_list_items (' +
      '  id SERIAL PRIMARY KEY,' +
      '  requester_id INTEGER REFERENCES users(id) ON DELETE CASCADE,' +
      '  city_code CHAR(3),' +
      '  description VARCHAR(500) NOT NULL,' +
      '  quantity DECIMAL(10,2) DEFAULT 1,' +
      '  unit_price DECIMAL(10,2),' +
      '  vendor_name VARCHAR(255),' +
      '  part_number VARCHAR(120),' +
      '  link TEXT,' +
      '  notes TEXT,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'active'," +
      '  po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,' +
      '  created_at TIMESTAMP DEFAULT NOW(),' +
      '  updated_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    // Widen the part-number fields to 255. A running-list Part # rolls into
    // po_line_items.item_number when pushed to a PO; if either column is shorter
    // than the pasted value, the push aborts with a raw "value too long" 500.
    await client.query(
      'ALTER TABLE po_line_items ALTER COLUMN item_number TYPE VARCHAR(255);' +
      'ALTER TABLE running_list_items ALTER COLUMN part_number TYPE VARCHAR(255);'
    );
    // One-time backfill of po_line_items.requested_by for POs built before the push
    // started carrying it. The consumed running_list_items still point at their po_id,
    // so recover the tech by matching each PO line back to its running-list source on
    // po_id + description + part # + qty + price. Only fill where the match is
    // unambiguous (a single tech for that group) so attribution is never guessed wrong;
    // guarded by requested_by IS NULL so it is idempotent and never overwrites a value.
    await client.query(
      'UPDATE po_line_items li SET requested_by = sub.requester_id FROM (' +
        'SELECT r.po_id, r.description, r.part_number, r.quantity, r.unit_price, ' +
               'MAX(r.requester_id) AS requester_id, COUNT(DISTINCT r.requester_id) AS tech_count ' +
        'FROM running_list_items r ' +
        'WHERE r.po_id IS NOT NULL AND r.requester_id IS NOT NULL ' +
        'GROUP BY r.po_id, r.description, r.part_number, r.quantity, r.unit_price' +
      ') sub ' +
      'WHERE li.requested_by IS NULL ' +
        'AND li.po_id = sub.po_id ' +
        'AND li.description = sub.description ' +
        'AND li.item_number IS NOT DISTINCT FROM sub.part_number ' +
        'AND li.quantity = COALESCE(sub.quantity, 1) ' +
        'AND li.unit_price = COALESCE(sub.unit_price, 0) ' +
        'AND sub.tech_count = 1'
    );
    // Geico ERS survey history + city attribution
    await client.query(
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS city_code CHAR(3);'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS geico_surveys (' +
      '  id SERIAL PRIMARY KEY,' +
      '  po_number VARCHAR(100) UNIQUE NOT NULL,' +
      '  account_number VARCHAR(50),' +
      '  city_code CHAR(3),' +
      '  service VARCHAR(100),' +
      '  loss_state VARCHAR(4),' +
      '  date_of_dispatch DATE,' +
      '  arrived_on_time VARCHAR(20),' +
      '  time_to_arrive VARCHAR(50),' +
      '  rating VARCHAR(50),' +
      '  date_received DATE,' +
      '  internet_message_id VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_geico_received ON geico_surveys(date_received);' +
      'CREATE INDEX IF NOT EXISTS idx_geico_city ON geico_surveys(city_code);' +
      'CREATE INDEX IF NOT EXISTS idx_geico_rating ON geico_surveys(rating);'
    );
    await client.query(
      'ALTER TABLE geico_surveys ADD COLUMN IF NOT EXISTS employee_name VARCHAR(120);'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS signoff_forms (' +
      '  id SERIAL PRIMARY KEY,' +
      '  form_number VARCHAR(50) UNIQUE NOT NULL,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'pending'," +
      '  wo_number VARCHAR(100),' +
      '  po_number VARCHAR(100),' +
      '  invoice_number VARCHAR(100),' +
      '  account VARCHAR(255),' +
      '  store_name VARCHAR(255),' +
      '  store_number VARCHAR(100),' +
      '  address VARCHAR(255),' +
      '  city_state_zip VARCHAR(255),' +
      '  service_requested_by VARCHAR(255),' +
      '  start_time VARCHAR(100),' +
      '  end_time VARCHAR(100),' +
      '  work_complete BOOLEAN,' +
      '  num_technicians INTEGER,' +
      '  manager_name VARCHAR(255),' +
      '  technician_names TEXT,' +
      '  work_description TEXT,' +
      '  signature_data TEXT,' +
      '  notes TEXT,' +
      '  created_by INTEGER REFERENCES users(id),' +
      '  completed_by INTEGER REFERENCES users(id),' +
      '  completed_at TIMESTAMPTZ,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS signoff_photos (' +
      '  id SERIAL PRIMARY KEY,' +
      '  form_id INTEGER REFERENCES signoff_forms(id) ON DELETE CASCADE,' +
      '  image_data TEXT,' +
      '  caption VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_signoff_status ON signoff_forms(status);' +
      'CREATE INDEX IF NOT EXISTS idx_signoff_photos_form ON signoff_photos(form_id);'
    );
    await client.query(
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS gps_lat DECIMAL(10,7);' +
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS gps_lon DECIMAL(10,7);' +
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS gps_accuracy DECIMAL(10,2);' +
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS gps_error TEXT;' +
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;' +
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;'
    );
    // Trip series: one job can need several visits, each with its own sheet + signature.
    // trip_group_id is the id of the first sheet in the series (self-referencing on trip 1).
    // Intentionally NOT a foreign key — an FK would drag the whole series when trip 1 is deleted.
    // trip_base_number is trip 1's form_number, stored so -T2/-T3 suffixes survive a year rollover.
    await client.query(
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS trip_group_id INTEGER;' +
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS trip_number INTEGER NOT NULL DEFAULT 1;' +
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS trip_base_number VARCHAR(50);' +
      'ALTER TABLE signoff_forms ADD COLUMN IF NOT EXISTS trip_reason TEXT;' +
      'CREATE INDEX IF NOT EXISTS idx_signoff_trip_group ON signoff_forms(trip_group_id);'
    );
    // Backfill: every existing sheet becomes a one-trip series. Safe to re-run.
    await client.query('UPDATE signoff_forms SET trip_group_id = id WHERE trip_group_id IS NULL;');
    await client.query('UPDATE signoff_forms SET trip_base_number = form_number WHERE trip_base_number IS NULL AND trip_number = 1;');
    // NOTE: the deposits period_start/period_end ALTERs were moved to run AFTER
    // the deposits table is created (see the deposits block below) — on a fresh
    // DB they used to run here before the table existed and aborted migrations.
    await client.query(
      'CREATE TABLE IF NOT EXISTS scheduled_messages (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  enabled BOOLEAN NOT NULL DEFAULT true,' +
      "  channel VARCHAR(10) NOT NULL DEFAULT 'sms'," +
      "  audience_roles TEXT NOT NULL DEFAULT '[]'," +
      '  ignore_opt_out BOOLEAN NOT NULL DEFAULT false,' +
      '  day_of_week INTEGER NOT NULL DEFAULT 1,' +
      "  send_time VARCHAR(5) NOT NULL DEFAULT '09:00'," +
      '  subject VARCHAR(255),' +
      '  message TEXT NOT NULL,' +
      '  last_run_on DATE,' +
      '  created_by INTEGER REFERENCES users(id),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    const _smSeed = await client.query("SELECT value FROM settings WHERE key = 'scheduled_seed_v1'");
    if (!_smSeed.rows.length) {
      await client.query(
        'INSERT INTO scheduled_messages (name, enabled, channel, audience_roles, ignore_opt_out, day_of_week, send_time, subject, message) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          'Monday deposit reminder',
          true,
          'sms',
          JSON.stringify(['locksmith', 'roadside_technician']),
          true,
          1,
          '09:00',
          'Deposit day reminder',
          'Reminder: today is deposit day for last week. Please make your cash deposit and upload the receipt photo in Nova.'
        ]
      );
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('scheduled_seed_v1', 'done', NOW()) ON CONFLICT (key) DO NOTHING");
    }
    await client.query(
      'CREATE TABLE IF NOT EXISTS tasks (' +
      '  id SERIAL PRIMARY KEY,' +
      '  title VARCHAR(255) NOT NULL,' +
      '  description TEXT,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'todo'," +
      "  priority VARCHAR(10) NOT NULL DEFAULT 'medium'," +
      '  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  due_date DATE,' +
      '  completed_at TIMESTAMPTZ,' +
      '  completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  position INTEGER DEFAULT 0,' +
      '  recurrence VARCHAR(10),' +
      '  recurrence_day INTEGER,' +
      '  reminded_day_before BOOLEAN NOT NULL DEFAULT false,' +
      '  reminded_due BOOLEAN NOT NULL DEFAULT false,' +
      '  last_overdue_on DATE,' +
      '  cc_overdue_notified BOOLEAN NOT NULL DEFAULT false,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS order_task_id INTEGER;'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS task_subtasks (' +
      '  id SERIAL PRIMARY KEY,' +
      '  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,' +
      '  title VARCHAR(500) NOT NULL,' +
      '  done BOOLEAN NOT NULL DEFAULT false,' +
      '  position INTEGER DEFAULT 0,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS task_activity (' +
      '  id SERIAL PRIMARY KEY,' +
      '  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,' +
      '  user_id INTEGER,' +
      '  user_name VARCHAR(255),' +
      "  type VARCHAR(20) NOT NULL DEFAULT 'event'," +
      '  body TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Tasks column migrations — CREATE TABLE IF NOT EXISTS won't add columns to a pre-existing table,
    // so backfill any columns added after the tables were first created (idempotent).
    await client.query(
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'todo';" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'medium';" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to INTEGER;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by INTEGER;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by INTEGER;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence VARCHAR(10);" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_day INTEGER;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_start_day INTEGER;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_run_on DATE;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS series_id INTEGER;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminded_day_before BOOLEAN NOT NULL DEFAULT false;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminded_due BOOLEAN NOT NULL DEFAULT false;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_overdue_on DATE;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source VARCHAR(20);" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS secondary_assignee_id INTEGER;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_by INTEGER;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_locked BOOLEAN NOT NULL DEFAULT false;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS require_due_to_close BOOLEAN NOT NULL DEFAULT false;" +
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_id INTEGER;" +
      "ALTER TABLE task_subtasks ADD COLUMN IF NOT EXISTS done BOOLEAN NOT NULL DEFAULT false;" +
      "ALTER TABLE task_subtasks ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;" +
      "ALTER TABLE task_subtasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS user_id INTEGER;" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS user_name VARCHAR(255);" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'event';" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS body TEXT;" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();"
    );
    // FYI-overdue flag: add the column and, in the SAME one-time step, mark every
    // task that is ALREADY overdue as notified - so turning this feature on does not
    // fire a retroactive burst of "task overdue" emails to copied (FYI) people.
    // Guarded on the column not existing yet, so it runs exactly once; tasks that go
    // overdue AFTER deploy are left false and handled by the daily sweep.
    await client.query(
      "DO $do$ BEGIN " +
      "IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'cc_overdue_notified') THEN " +
      "ALTER TABLE tasks ADD COLUMN cc_overdue_notified BOOLEAN NOT NULL DEFAULT false; " +
      "UPDATE tasks SET cc_overdue_notified = true WHERE due_date IS NOT NULL AND due_date < CURRENT_DATE AND status <> 'done'; " +
      "END IF; END $do$;"
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assigned_to);' +
      'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);' +
      'CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);' +
      'CREATE INDEX IF NOT EXISTS idx_task_sub ON task_subtasks(task_id);' +
      'CREATE INDEX IF NOT EXISTS idx_task_act ON task_activity(task_id);'
    );
    // Task attachments (files stored base64 in Postgres) + CC recipients (Nova users copied for awareness)
    await client.query(
      'CREATE TABLE IF NOT EXISTS task_attachments (' +
      '  id SERIAL PRIMARY KEY,' +
      '  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,' +
      '  filename VARCHAR(255),' +
      '  mime_type VARCHAR(100),' +
      '  image_data TEXT,' +
      '  size_bytes INTEGER,' +
      '  uploaded_by INTEGER,' +
      '  uploaded_by_name VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS task_cc (' +
      '  id SERIAL PRIMARY KEY,' +
      '  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,' +
      '  user_id INTEGER,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  UNIQUE (task_id, user_id)' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_task_att ON task_attachments(task_id);' +
      'CREATE INDEX IF NOT EXISTS idx_task_cc ON task_cc(task_id);'
    );

    // Task Templates — reusable workflows (onboarding/offboarding) that prefill a task + assignable subtasks
    await client.query(
      "ALTER TABLE task_subtasks ADD COLUMN IF NOT EXISTS assigned_to INTEGER;"
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS task_templates (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  description TEXT,' +
      "  priority VARCHAR(10) NOT NULL DEFAULT 'medium'," +
      '  category VARCHAR(50),' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  created_by INTEGER,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS task_template_steps (' +
      '  id SERIAL PRIMARY KEY,' +
      '  template_id INTEGER REFERENCES task_templates(id) ON DELETE CASCADE,' +
      '  title VARCHAR(500) NOT NULL,' +
      '  position INTEGER DEFAULT 0,' +
      '  default_assignee_id INTEGER,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_tts_tpl ON task_template_steps(template_id);');
    // Seed default Onboarding / Offboarding templates once (idempotent via settings flag)
    {
      const _tplSeeded = await client.query("SELECT value FROM settings WHERE key = 'task_templates_seed_v1'");
      if (!_tplSeeded.rows.length) {
        const _seedTpl = async function (name, category, steps) {
          const r = await client.query(
            "INSERT INTO task_templates (name, description, priority, category) VALUES ($1,$2,'high',$3) RETURNING id",
            [name, 'Standard ' + name.toLowerCase() + ' checklist. Edit steps and default assignees to fit your team.', category]
          );
          const tid = r.rows[0].id;
          for (let i = 0; i < steps.length; i++) {
            await client.query('INSERT INTO task_template_steps (template_id, title, position) VALUES ($1,$2,$3)', [tid, steps[i], i]);
          }
        };
        await _seedTpl('Onboarding', 'onboarding', [
          'Collect signed offer letter and I-9 / W-4 paperwork',
          'Run background check and MVR (driving record)',
          'Create Nova user account and assign role',
          'Set up company email and phone extension',
          'Order uniforms and name badge',
          'Issue keys, fobs, and building access',
          'Assign vehicle (if applicable) and add to fleet insurance',
          'Add to payroll and enroll in benefits',
          'Schedule first-week training / ride-along',
          'Complete required SOP sign-offs and safety training',
          'Add to schedule and introduce to the team'
        ]);
        await _seedTpl('Offboarding', 'offboarding', [
          'Confirm last day and reason (resignation / termination)',
          'Disable Nova account and rotate shared Vault passwords',
          'Revoke email, phone, and building access',
          'Collect keys, fobs, uniforms, and equipment',
          'Recover company vehicle and remove from insurance',
          'Process final paycheck and unused PTO payout',
          'Remove from payroll and benefits',
          'Remove from schedule and reassign open tasks',
          'Conduct exit interview',
          'Complete company-property return inventory',
          'Update org chart and notify the team'
        ]);
        await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('task_templates_seed_v1', 'done', NOW()) ON CONFLICT (key) DO NOTHING");
      }
    }
    // Work Orders — inbound work-order intake (email + manual). Own module, separate from Tasks.
    await client.query(
      'CREATE TABLE IF NOT EXISTS work_orders (' +
      '  id SERIAL PRIMARY KEY,' +
      '  wo_ref VARCHAR(50) UNIQUE,' +
      "  source VARCHAR(20) NOT NULL DEFAULT 'email'," +
      "  status VARCHAR(20) NOT NULL DEFAULT 'received'," +
      "  priority VARCHAR(10) NOT NULL DEFAULT 'normal'," +
      '  account_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,' +
      '  account_name VARCHAR(255),' +
      '  account_number VARCHAR(255),' +
      '  city_code CHAR(3),' +
      '  po_number VARCHAR(100),' +
      '  wo_number VARCHAR(100),' +
      '  store_name VARCHAR(255),' +
      '  store_number VARCHAR(100),' +
      '  address VARCHAR(255),' +
      '  city_state_zip VARCHAR(255),' +
      '  service_requested TEXT,' +
      '  service_requested_by VARCHAR(255),' +
      '  contact_name VARCHAR(255),' +
      '  contact_phone VARCHAR(50),' +
      '  needed_by DATE,' +
      '  notes TEXT,' +
      '  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  signoff_id INTEGER REFERENCES signoff_forms(id) ON DELETE SET NULL,' +
      '  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  reviewed_at TIMESTAMPTZ,' +
      '  email_message_id VARCHAR(998) UNIQUE,' +
      '  email_from VARCHAR(255),' +
      '  email_subject TEXT,' +
      '  email_received_at TIMESTAMPTZ,' +
      '  email_body TEXT,' +
      '  parsed JSONB,' +
      '  confidence VARCHAR(10),' +
      '  parse_error TEXT,' +
      '  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS work_order_attachments (' +
      '  id SERIAL PRIMARY KEY,' +
      '  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE CASCADE,' +
      '  filename VARCHAR(255),' +
      '  mime_type VARCHAR(100),' +
      '  image_data TEXT,' +
      '  size_bytes INTEGER,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS work_order_activity (' +
      '  id SERIAL PRIMARY KEY,' +
      '  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE CASCADE,' +
      '  user_id INTEGER,' +
      '  user_name VARCHAR(255),' +
      "  type VARCHAR(20) NOT NULL DEFAULT 'event'," +
      '  body TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);' +
      'CREATE INDEX IF NOT EXISTS idx_wo_account ON work_orders(account_id);' +
      'CREATE INDEX IF NOT EXISTS idx_wo_assigned ON work_orders(assigned_to);' +
      'CREATE INDEX IF NOT EXISTS idx_wo_needed ON work_orders(needed_by);' +
      'CREATE INDEX IF NOT EXISTS idx_wo_created ON work_orders(created_at);' +
      'CREATE INDEX IF NOT EXISTS idx_wo_att ON work_order_attachments(work_order_id);' +
      'CREATE INDEX IF NOT EXISTS idx_wo_act ON work_order_activity(work_order_id);'
    );
    // Work Orders — vehicle jobs (Fenkell / VEHI-TRAC port work). The module was
    // originally shaped for SITE jobs (rekey a retail store: account + store # +
    // address) and had nowhere to put a VIN, so vehicle details were being dropped
    // and the railyard was landing in store_name. These are additive + nullable;
    // existing site work orders are unaffected. NOTE: CREATE TABLE IF NOT EXISTS
    // above will NOT add these to the existing prod table — they need explicit ALTERs.
    await client.query(
      "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS job_type VARCHAR(10) NOT NULL DEFAULT 'site';" +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS claim_id VARCHAR(100);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS vin VARCHAR(20);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS vehicle_year VARCHAR(10);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS vehicle_make VARCHAR(60);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR(60);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS vehicle_mileage VARCHAR(20);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS repair_code VARCHAR(80);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS yard_name VARCHAR(255);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS bay_location VARCHAR(100);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS special_instructions TEXT;' +
      'CREATE INDEX IF NOT EXISTS idx_wo_vin ON work_orders(vin);' +
      'CREATE INDEX IF NOT EXISTS idx_wo_job_type ON work_orders(job_type);'
    );
    // Work Orders — NTE (not-to-exceed) + revisions. A dispatcher raises the NTE by
    // sending a REVISED work order carrying the SAME wo_number. That email used to land
    // as a brand-new work order (dedup is on email_message_id, which is unique per
    // email), so the raised limit sat in a second row nobody linked to the job. Now the
    // ingest matches on wo_number + account and UPDATES the original: nte_amount moves,
    // the new PDF is attached to the original, and every change is kept in
    // work_order_nte_history. The revision email itself is kept as a 'superseded' stub
    // row — it still owns the email_message_id, which is what keeps re-polling idempotent.
    await client.query(
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS nte_amount NUMERIC(12,2);' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS revision_count INTEGER NOT NULL DEFAULT 0;' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS last_revision_at TIMESTAMPTZ;' +
      'ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS revision_of_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL;' +
      'CREATE INDEX IF NOT EXISTS idx_wo_wo_number ON work_orders(UPPER(wo_number));' +
      'CREATE INDEX IF NOT EXISTS idx_wo_revision_of ON work_orders(revision_of_id);'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS work_order_nte_history (' +
      '  id SERIAL PRIMARY KEY,' +
      '  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE CASCADE,' +
      '  old_amount NUMERIC(12,2),' +
      '  new_amount NUMERIC(12,2),' +
      "  source VARCHAR(20) NOT NULL DEFAULT 'email'," +
      '  revision_wo_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,' +
      '  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  changed_by_name VARCHAR(255),' +
      '  note TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_wo_nte_hist ON work_order_nte_history(work_order_id);'
    );
    // Scheduling — manager-built weekly shift schedule (Sling-style). Wall-clock
    // times (shift_date + start/end time) keep the grid DST-proof for the local day.
    await client.query(
      'CREATE TABLE IF NOT EXISTS shift_positions (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(100) NOT NULL,' +
      "  color VARCHAR(20) NOT NULL DEFAULT '#f97316'," +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS shifts (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,' +
      '  user_name VARCHAR(255),' +
      '  city_code CHAR(3),' +
      '  position_id INTEGER REFERENCES shift_positions(id) ON DELETE SET NULL,' +
      '  shift_date DATE NOT NULL,' +
      '  start_time VARCHAR(5) NOT NULL,' +
      '  end_time VARCHAR(5) NOT NULL,' +
      '  break_minutes INTEGER NOT NULL DEFAULT 0,' +
      '  notes TEXT,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'draft'," +
      '  published_at TIMESTAMPTZ,' +
      '  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS user_cities (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  city_code CHAR(3) NOT NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  UNIQUE(user_id, city_code)' +
      ');'
    );
    await client.query(
      "ALTER TABLE shifts ADD COLUMN IF NOT EXISTS position_id INTEGER;" +
      "ALTER TABLE shifts ADD COLUMN IF NOT EXISTS break_minutes INTEGER NOT NULL DEFAULT 0;" +
      "ALTER TABLE shifts ADD COLUMN IF NOT EXISTS notes TEXT;" +
      "ALTER TABLE shifts ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;" +
      "ALTER TABLE shifts ADD COLUMN IF NOT EXISTS user_name VARCHAR(255);" +
      "ALTER TABLE shifts ADD COLUMN IF NOT EXISTS city_code CHAR(3);"
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date);' +
      'CREATE INDEX IF NOT EXISTS idx_shifts_city ON shifts(city_code);' +
      'CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);' +
      'CREATE INDEX IF NOT EXISTS idx_user_cities_user ON user_cities(user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_user_cities_city ON user_cities(city_code);'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS push_subscriptions (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  endpoint TEXT NOT NULL UNIQUE,' +
      '  p256dh TEXT NOT NULL,' +
      '  auth TEXT NOT NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);');
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pulsar_name VARCHAR(255);");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(255);");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_from_schedule BOOLEAN NOT NULL DEFAULT false;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_from_org BOOLEAN NOT NULL DEFAULT false;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS org_x INTEGER;");
    // Home city — the employee's base city; used as the default city when creating a shift (separate from user_cities, which are the cities they can view/manage).
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS home_city CHAR(3);");
    // Onboarding approvers — who clears each phase for a hire. Named per hire so
    // the person who reviews the paperwork does not have to be the person who
    // runs training. NULL falls back to the supervisor chain (the old behavior).
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_phase1_approver_id INTEGER REFERENCES users(id) ON DELETE SET NULL;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_phase2_approver_id INTEGER REFERENCES users(id) ON DELETE SET NULL;");
    // ---- PTO module ----
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS hire_date DATE;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pto_balance_hours NUMERIC(8,2) NOT NULL DEFAULT 0;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pto_exempt BOOLEAN NOT NULL DEFAULT false;");
    // Employment status: full_time | part_time | contractor. Only full_time accrues PTO.
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type TEXT NOT NULL DEFAULT 'full_time';");
    await client.query(
      'CREATE TABLE IF NOT EXISTS pto_requests (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER REFERENCES users(id),' +
      '  start_date DATE NOT NULL,' +
      '  end_date DATE NOT NULL,' +
      '  business_days INTEGER NOT NULL DEFAULT 0,' +
      '  hours NUMERIC(8,2) NOT NULL DEFAULT 0,' +
      "  type VARCHAR(40) NOT NULL DEFAULT 'Vacation'," +
      '  paid BOOLEAN NOT NULL DEFAULT true,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'pending'," +
      '  required_level INTEGER,' +
      '  approver_id INTEGER REFERENCES users(id),' +
      '  decided_at TIMESTAMP,' +
      '  decision_reason TEXT,' +
      '  coverage_override BOOLEAN NOT NULL DEFAULT false,' +
      '  override_reason TEXT,' +
      '  retroactive BOOLEAN NOT NULL DEFAULT false,' +
      '  created_at TIMESTAMP DEFAULT NOW(),' +
      '  updated_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS pto_ledger (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER REFERENCES users(id),' +
      '  entry_date DATE NOT NULL,' +
      '  kind VARCHAR(20) NOT NULL,' +
      '  amount_hours NUMERIC(8,2) NOT NULL,' +
      '  description TEXT,' +
      '  accrual_period CHAR(7),' +
      '  request_id INTEGER REFERENCES pto_requests(id) ON DELETE SET NULL,' +
      '  created_by INTEGER REFERENCES users(id),' +
      '  created_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_pto_ledger_user ON pto_ledger(user_id);');
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_pto_accrual_month ON pto_ledger(user_id, accrual_period) WHERE kind = 'accrual';");
    // ---- PTO manager-initiated cancellation (employee must approve) ----
    await client.query("ALTER TABLE pto_requests ADD COLUMN IF NOT EXISTS cancel_memo TEXT;");
    await client.query("ALTER TABLE pto_requests ADD COLUMN IF NOT EXISTS cancel_initiated_by INTEGER REFERENCES users(id);");
    await client.query("ALTER TABLE pto_requests ADD COLUMN IF NOT EXISTS cancel_initiated_at TIMESTAMP;");
    // Remember a shift's position before PTO overwrote it, so cancel can restore it exactly.
    await client.query("ALTER TABLE shifts ADD COLUMN IF NOT EXISTS prev_position_id INTEGER;");
    // Marks a shift that PTO approval auto-created solely to show time off on the grid,
    // so cancelling the PTO deletes it (whereas flipped real shifts are restored).
    await client.query("ALTER TABLE shifts ADD COLUMN IF NOT EXISTS pto_generated BOOLEAN NOT NULL DEFAULT false;");
    await client.query(
      'CREATE TABLE IF NOT EXISTS pto_cancellations (' +
      '  id SERIAL PRIMARY KEY,' +
      '  request_id INTEGER REFERENCES pto_requests(id) ON DELETE SET NULL,' +
      '  user_id INTEGER REFERENCES users(id),' +
      '  start_date DATE NOT NULL,' +
      '  end_date DATE NOT NULL,' +
      '  business_days INTEGER NOT NULL DEFAULT 0,' +
      '  hours NUMERIC(8,2) NOT NULL DEFAULT 0,' +
      '  paid BOOLEAN NOT NULL DEFAULT true,' +
      '  type VARCHAR(40),' +
      '  source VARCHAR(40),' +
      '  memo TEXT,' +
      '  initiated_by INTEGER REFERENCES users(id),' +
      '  decided_by INTEGER REFERENCES users(id),' +
      '  created_at TIMESTAMP DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_pto_cancellations_user ON pto_cancellations(user_id);');
    // ---- PTO per-day designation (paid / unpaid / regular scheduled day off) ----
    // A request is now a SET of tagged days, not one paid/unpaid flag for a range.
    // Balance impact (hours) = paid days x 8. Unpaid and scheduled-off never touch it.
    await client.query("ALTER TABLE pto_requests ADD COLUMN IF NOT EXISTS paid_days INTEGER NOT NULL DEFAULT 0;");
    await client.query("ALTER TABLE pto_requests ADD COLUMN IF NOT EXISTS unpaid_days INTEGER NOT NULL DEFAULT 0;");
    await client.query("ALTER TABLE pto_requests ADD COLUMN IF NOT EXISTS off_days INTEGER NOT NULL DEFAULT 0;");
    // kind is one of: 'paid' | 'unpaid' | 'off'
    await client.query(
      'CREATE TABLE IF NOT EXISTS pto_request_days (' +
      '  id SERIAL PRIMARY KEY,' +
      '  request_id INTEGER NOT NULL REFERENCES pto_requests(id) ON DELETE CASCADE,' +
      '  day_date DATE NOT NULL,' +
      "  kind VARCHAR(12) NOT NULL DEFAULT 'paid'," +
      '  UNIQUE(request_id, day_date)' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_pto_request_days_request ON pto_request_days(request_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_pto_request_days_date ON pto_request_days(day_date);');
    // Neutral schedule marker for a regular scheduled day off (NOT PTO). Ensured by
    // name so we never depend on a hardcoded id; pto.js resolves the id by name.
    await client.query("INSERT INTO shift_positions (name, color) SELECT 'Scheduled Off', '#6b7280' WHERE NOT EXISTS (SELECT 1 FROM shift_positions WHERE name = 'Scheduled Off');");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_perms TEXT[] NOT NULL DEFAULT '{}';");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS title VARCHAR(120);");
    const _spSeed = await client.query("SELECT value FROM settings WHERE key = 'schedule_seed_v1'");
    if (!_spSeed.rows.length) {
      await client.query(
        "INSERT INTO shift_positions (name, color) VALUES " +
        "('Locksmith', '#f97316'), ('Roadside', '#3b82f6'), ('Counter', '#22c55e'), ('On Call', '#a855f7')"
      );
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('schedule_seed_v1', 'done', NOW()) ON CONFLICT (key) DO NOTHING");
    }
    const _v4 = await client.query("SELECT value FROM settings WHERE key = 'perm_matrix_v4_backfilled'");
    if (!_v4.rows.length) {
      const _rp4 = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rp4.rows.length && _rp4.rows[0].value) {
        try {
          const obj = JSON.parse(_rp4.rows[0].value);
          if (obj && typeof obj === 'object') {
            ['locksmith', 'locksmith_coordinator', 'roadside_technician', 'manager'].forEach(function(r) {
              if (Array.isArray(obj[r]) && obj[r].indexOf('view_schedule') === -1) obj[r].push('view_schedule');
            });
            if (Array.isArray(obj.manager) && obj.manager.indexOf('manage_schedule') === -1) obj.manager.push('manage_schedule');
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('perm matrix v4 backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('perm_matrix_v4_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }
    await client.query(
      "UPDATE users SET role = 'locksmith' WHERE role = 'requester';" +
      "UPDATE users SET role = 'manager' WHERE role = 'approver';" +
      "ALTER TABLE users ALTER COLUMN role SET DEFAULT 'locksmith';"
    );
    // Weekly cash deposits — employees upload deposit receipts; managers export to CSV
    await client.query(
      'CREATE TABLE IF NOT EXISTS deposits (' +
      '  id SERIAL PRIMARY KEY,' +
      '  deposit_number VARCHAR(50) UNIQUE,' +
      '  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  user_name VARCHAR(255),' +
      '  city_code CHAR(3),' +
      '  amount DECIMAL(10,2) NOT NULL DEFAULT 0,' +
      '  deposit_date DATE NOT NULL,' +
      '  notes TEXT,' +
      '  receipt_image TEXT,' +
      '  receipt_filename VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Moved here from the signoff_forms migration above: these depend on the
    // deposits table existing, so on a fresh DB they must run AFTER it is created.
    await client.query(
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS period_start DATE;' +
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS period_end DATE;'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_deposits_date ON deposits(deposit_date);' +
      'CREATE INDEX IF NOT EXISTS idx_deposits_city ON deposits(city_code);'
    );
    // Cash deposit reconciliation: Pulsar-owed figure + multiple receipts + expense lines
    await client.query(
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS pulsar_owed DECIMAL(10,2);'
    );
    // Duplicate-submission guards: idempotency key (hard block on resubmits) + content index (soft warn)
    await client.query(
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);'
    );
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_idempotency ON deposits(idempotency_key) WHERE idempotency_key IS NOT NULL;'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_deposits_dupcheck ON deposits(user_id, deposit_date, amount);'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS deposit_receipts (' +
      '  id SERIAL PRIMARY KEY,' +
      '  deposit_id INTEGER REFERENCES deposits(id) ON DELETE CASCADE,' +
      '  image TEXT,' +
      '  filename VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS deposit_expenses (' +
      '  id SERIAL PRIMARY KEY,' +
      '  deposit_id INTEGER REFERENCES deposits(id) ON DELETE CASCADE,' +
      '  description VARCHAR(500),' +
      '  amount DECIMAL(10,2) NOT NULL DEFAULT 0,' +
      '  receipt_image TEXT,' +
      '  receipt_filename VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_deposit_receipts_dep ON deposit_receipts(deposit_id);' +
      'CREATE INDEX IF NOT EXISTS idx_deposit_expenses_dep ON deposit_expenses(deposit_id);'
    );
    // Cash-deposit receipt policy: every expense line needs a photo, or an explicit
    // "no receipt" override with a written reason.  Also track what the AI read off the
    // deposit slip so the reviewer can see if the tech changed the amount/date afterwards.
    await client.query(
      'ALTER TABLE deposit_expenses ADD COLUMN IF NOT EXISTS no_receipt BOOLEAN DEFAULT FALSE;' +
      'ALTER TABLE deposit_expenses ADD COLUMN IF NOT EXISTS no_receipt_reason TEXT;'
    );
    await client.query(
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS ai_amount DECIMAL(10,2);' +
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS ai_deposit_date DATE;' +
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS ai_edited BOOLEAN DEFAULT FALSE;'
    );
    // Indexes on frequently-filtered columns for the main list views
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_po_requester ON purchase_orders(requester_id);' +
      'CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);' +
      'CREATE INDEX IF NOT EXISTS idx_po_created ON purchase_orders(created_at);' +
      'CREATE INDEX IF NOT EXISTS idx_quotes_requester ON quotes(requester_id);' +
      'CREATE INDEX IF NOT EXISTS idx_vr_requester ON vehicle_repairs(requester_id);' +
      'CREATE INDEX IF NOT EXISTS idx_vr_status ON vehicle_repairs(status);' +
      'CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);' +
      'CREATE INDEX IF NOT EXISTS idx_ai_conv_created ON ai_conversations(created_at);'
    );
    // One-time backfill: grant the new module-view permissions to existing saved
    // role configs so nobody loses access. Guarded by a flag so it runs once and
    // never undoes an admin's later choices.
    const _vb = await client.query("SELECT value FROM settings WHERE key = 'perm_matrix_v3_backfilled'");
    if (!_vb.rows.length) {
      const _newPerms = [
        'view_pos', 'create_po', 'edit_po', 'delete_po', 'submit_po',
        'view_quotes', 'create_quote', 'edit_quote', 'delete_quote', 'push_quote_po',
        'view_vr', 'create_vr', 'edit_vr', 'delete_vr', 'submit_vr',
        'view_deposits', 'create_deposit', 'delete_deposit', 'export_deposits',
        'view_signoffs', 'create_signoff', 'edit_signoff', 'complete_signoff', 'delete_signoff'
      ];
      const _rp = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rp.rows.length && _rp.rows[0].value) {
        try {
          const obj = JSON.parse(_rp.rows[0].value);
          if (obj && typeof obj === 'object') {
            ['locksmith', 'locksmith_coordinator', 'roadside_technician', 'manager'].forEach(function(r) {
              if (Array.isArray(obj[r])) {
                _newPerms.forEach(function(p) { if (obj[r].indexOf(p) === -1) obj[r].push(p); });
              }
            });
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('perm matrix v2 backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('perm_matrix_v3_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }
    // SOP documents - admin-uploaded PDFs (extracted text) that Nova AI references
    await client.query(
      'CREATE TABLE IF NOT EXISTS sop_documents (' +
      '  id SERIAL PRIMARY KEY,' +
      '  title VARCHAR(255) NOT NULL,' +
      '  filename VARCHAR(255),' +
      '  content TEXT NOT NULL,' +
      '  char_count INTEGER DEFAULT 0,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  uploaded_by INTEGER REFERENCES users(id),' +
      '  uploaded_by_name VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // SOP chunks - searchable segments of each SOP for full-text retrieval by Nova AI
    await client.query(
      'CREATE TABLE IF NOT EXISTS sop_chunks (' +
      '  id SERIAL PRIMARY KEY,' +
      '  sop_id INTEGER NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,' +
      '  chunk_index INTEGER NOT NULL,' +
      '  content TEXT NOT NULL,' +
      "  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED" +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS sop_chunks_tsv_idx ON sop_chunks USING GIN (tsv);');
    await client.query('CREATE INDEX IF NOT EXISTS sop_chunks_sop_idx ON sop_chunks (sop_id);');
    // Backfill chunks for any SOP documents uploaded before retrieval existed
    try {
      const { reindexSop } = require('./utils/sopIndex');
      const missingChunks = await client.query(
        'SELECT d.id, d.content FROM sop_documents d WHERE NOT EXISTS (SELECT 1 FROM sop_chunks c WHERE c.sop_id = d.id)'
      );
      for (const row of missingChunks.rows) {
        await reindexSop(client, row.id, row.content);
      }
      if (missingChunks.rows.length) console.log('Backfilled SOP chunks for ' + missingChunks.rows.length + ' document(s)');
    } catch (e) { console.error('SOP chunk backfill failed:', e.message); }
    // ===== Document Vault =====
    // Folders form a tree (parent_id NULL = root). Files live in a folder or root.
    // Actual file bytes live in Cloudflare R2; we only store metadata + the R2 key.
    await client.query(
      'CREATE TABLE IF NOT EXISTS document_folders (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  parent_id INTEGER REFERENCES document_folders(id) ON DELETE CASCADE,' +
      '  owner_id INTEGER REFERENCES users(id),' +
      '  owner_name VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS documents (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  folder_id INTEGER REFERENCES document_folders(id) ON DELETE CASCADE,' +
      '  r2_key VARCHAR(512) UNIQUE NOT NULL,' +
      '  mime_type VARCHAR(255),' +
      '  size_bytes BIGINT DEFAULT 0,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'pending'," +
      '  owner_id INTEGER REFERENCES users(id),' +
      '  owner_name VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Drive-style sharing. A share grants a user OR a whole role access to a file
    // or folder. Folder shares cascade to everything inside (resolved in the route).
    await client.query(
      'CREATE TABLE IF NOT EXISTS document_shares (' +
      '  id SERIAL PRIMARY KEY,' +
      '  resource_type VARCHAR(10) NOT NULL,' +
      '  resource_id INTEGER NOT NULL,' +
      '  grantee_type VARCHAR(10) NOT NULL,' +
      '  grantee_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,' +
      '  grantee_role VARCHAR(50),' +
      '  can_edit BOOLEAN NOT NULL DEFAULT false,' +
      '  created_by INTEGER REFERENCES users(id),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS document_folders_parent_idx ON document_folders (parent_id);');
    await client.query('CREATE INDEX IF NOT EXISTS documents_folder_idx ON documents (folder_id);');
    await client.query('CREATE INDEX IF NOT EXISTS document_shares_resource_idx ON document_shares (resource_type, resource_id);');
    await client.query('CREATE INDEX IF NOT EXISTS document_shares_user_idx ON document_shares (grantee_user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS document_shares_role_idx ON document_shares (grantee_role);');
    await client.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS emailable BOOLEAN NOT NULL DEFAULT false;');
    // Document expiration + reminder lead time (number + unit days/weeks/months).
    await client.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS expires_on DATE;');
    await client.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS reminder_lead_num INTEGER;');
    await client.query("ALTER TABLE documents ADD COLUMN IF NOT EXISTS reminder_lead_unit VARCHAR(10);");
    await client.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;');
    await client.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS expiry_notice_sent_at TIMESTAMPTZ;');
    // ===== Quote photos (R2-backed reference images attached to a quote) =====
    // Like documents, only metadata + the R2 key live here; bytes live in R2.
    await client.query(
      'CREATE TABLE IF NOT EXISTS quote_photos (' +
      '  id SERIAL PRIMARY KEY,' +
      '  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  r2_key VARCHAR(512) UNIQUE NOT NULL,' +
      '  mime_type VARCHAR(255),' +
      '  size_bytes BIGINT DEFAULT 0,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'pending'," +
      '  uploaded_by INTEGER REFERENCES users(id),' +
      '  uploaded_by_name VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS quote_photos_quote_idx ON quote_photos (quote_id);');
    // ===== Invoices (field invoicing) =====
    const DEFAULT_AGREEMENT = [
      "I, {customer}, confirm that the information given by me is correct, I have the authority to authorize these services, and I indemnify and hold harmless the locksmith and Pop-A-Lock against liability. Also I authorize Pop-A-Lock to perform the above described service and agree to pay (or authorize my motor club to pay) all applicable charges.",
      "I, {customer}, understand that all electronic keys or remotes must be present when the locksmith programs new keys or remotes to my vehicle. I understand that keys or remotes that are not present during the service will no longer work the vehicle. Furthermore, the attempted use of non-working keys may cause my vehicle to become inoperative and require dealer service.",
      "I, {customer}, accept the work as satisfactory and that the vehicle and/or property has been left in good working condition and that no damage occurred as a result of the performance of service. Furthermore, I understand Pop-A-Lock will warranty all parts and labor for 90 days from the date of this invoice. Pop-A-Lock will facilitate the exchange of any parts warrantied past 90 days by the manufacturer, however I will be responsible for the labor cost associated with the warranty replacement."
    ].join("\n\n");
    await client.query(
      'CREATE TABLE IF NOT EXISTS invoices (' +
      '  id SERIAL PRIMARY KEY,' +
      '  invoice_number BIGINT UNIQUE NOT NULL,' +
      '  locksmith_id INTEGER REFERENCES users(id),' +
      '  locksmith_name VARCHAR(255),' +
      '  invoice_date DATE DEFAULT CURRENT_DATE,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'draft'," +
      '  account_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,' +
      '  account_name VARCHAR(255),' +
      '  customer_po_wo VARCHAR(255),' +
      '  pay_type VARCHAR(50),' +
      '  card_last4 VARCHAR(4),' +
      '  cc_online BOOLEAN DEFAULT false,' +
      '  time_in VARCHAR(20),' +
      '  time_out VARCHAR(20),' +
      '  customer_name VARCHAR(255),' +
      '  dl_number VARCHAR(100),' +
      '  dl_state VARCHAR(4),' +
      '  street_address VARCHAR(255),' +
      '  city VARCHAR(120),' +
      '  state VARCHAR(4),' +
      '  zip VARCHAR(12),' +
      '  phone VARCHAR(50),' +
      '  email VARCHAR(255),' +
      '  vehicle_year VARCHAR(8),' +
      '  vehicle_make VARCHAR(100),' +
      '  vehicle_model VARCHAR(100),' +
      '  license_tag VARCHAR(40),' +
      '  tag_state VARCHAR(4),' +
      '  vin VARCHAR(20),' +
      '  mileage VARCHAR(20),' +
      '  ent_registration BOOLEAN DEFAULT false,' +
      '  ent_insurance BOOLEAN DEFAULT false,' +
      '  ent_title BOOLEAN DEFAULT false,' +
      '  ent_rental BOOLEAN DEFAULT false,' +
      '  tax_rate DECIMAL(5,2) DEFAULT 0,' +
      '  labor_amount DECIMAL(10,2) DEFAULT 0,' +
      '  parts_amount DECIMAL(10,2) DEFAULT 0,' +
      '  subtotal DECIMAL(10,2) DEFAULT 0,' +
      '  tax_amount DECIMAL(10,2) DEFAULT 0,' +
      '  tip_amount DECIMAL(10,2) DEFAULT 0,' +
      '  grand_total DECIMAL(10,2) DEFAULT 0,' +
      '  notes TEXT,' +
      '  payments_note TEXT,' +
      '  agreement_text TEXT,' +
      '  signature_image TEXT,' +
      '  signed_name VARCHAR(255),' +
      '  signed_at TIMESTAMPTZ,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS invoice_line_items (' +
      '  id SERIAL PRIMARY KEY,' +
      '  invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,' +
      "  line_type VARCHAR(10) NOT NULL DEFAULT 'part'," +
      '  part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,' +
      '  item_number VARCHAR(150),' +
      '  description VARCHAR(500) NOT NULL,' +
      '  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,' +
      '  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,' +
      '  taxable BOOLEAN DEFAULT false,' +
      '  position INTEGER DEFAULT 0' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date);' +
      'CREATE INDEX IF NOT EXISTS idx_invoices_locksmith ON invoices(locksmith_id);' +
      'CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);' +
      'CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_line_items(invoice_id);' +
      'CREATE INDEX IF NOT EXISTS idx_invoice_items_part ON invoice_line_items(part_id);'
    );
    // Per-account (vendor) config for the invoice account dropdown
    await client.query(
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS show_in_invoice BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS invoice_notes TEXT;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS auto_line_items JSONB;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS agreement_text TEXT;'
    );
    // Default authorization/agreement text (used when an account has none)
    const _invAgr = await client.query("SELECT value FROM settings WHERE key = 'invoice_default_agreement'");
    if (!_invAgr.rows.length) {
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('invoice_default_agreement', $1, NOW()) ON CONFLICT (key) DO NOTHING", [DEFAULT_AGREEMENT]);
    }
    // Starting invoice number (numeric, incrementing). Configurable later via settings.
    const _invStart = await client.query("SELECT value FROM settings WHERE key = 'invoice_start_number'");
    if (!_invStart.rows.length) {
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('invoice_start_number', '100001', NOW()) ON CONFLICT (key) DO NOTHING");
    }
    // Invoice: approval code + tax-exempt columns
    await client.query(
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approval_code VARCHAR(50);' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN DEFAULT false;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS signature_required BOOLEAN DEFAULT false;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS city_code CHAR(3);'
    );
    // Invoice photos (stored in Cloudflare R2, like the document vault). show_in_print
    // controls whether a photo appears on the printed / emailed PDF version.
    await client.query(
      'CREATE TABLE IF NOT EXISTS invoice_photos (' +
      '  id SERIAL PRIMARY KEY,' +
      '  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,' +
      '  r2_key TEXT NOT NULL,' +
      '  filename TEXT,' +
      '  mime_type TEXT,' +
      '  caption TEXT,' +
      '  show_in_print BOOLEAN DEFAULT true,' +
      '  position INTEGER DEFAULT 0,' +
      '  size_bytes BIGINT DEFAULT 0,' +
      '  status VARCHAR(20) DEFAULT \'pending\',' +
      '  uploaded_by INTEGER,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_invoice_photos_invoice ON invoice_photos(invoice_id);'
    );
    // Editable pay-type list for invoices
    const _invPay = await client.query("SELECT value FROM settings WHERE key = 'invoice_pay_types'");
    if (!_invPay.rows.length) {
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('invoice_pay_types', $1, NOW()) ON CONFLICT (key) DO NOTHING", [JSON.stringify(['Cash', 'Check', 'Visa', 'Mastercard', 'Amex', 'Discover', 'Debit', 'Motor Club', 'Account / Invoice', 'Other'])]);
    }
    // Seed standard Core Market accounts into the invoice dropdown (once)
    const _invAcctSeed = await client.query("SELECT value FROM settings WHERE key = 'invoice_core_accounts_seed_v1'");
    if (!_invAcctSeed.rows.length) {
      const _coreAccts = ['Core Market - Commercial', 'Core Market - Residential', 'Core Market - Automotive'];
      for (const _an of _coreAccts) {
        const _ex = await client.query('SELECT id FROM vendors WHERE name = $1', [_an]);
        if (!_ex.rows.length) await client.query('INSERT INTO vendors (name, show_in_invoice) VALUES ($1, true)', [_an]);
        else await client.query('UPDATE vendors SET show_in_invoice = true WHERE id = $1', [_ex.rows[0].id]);
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('invoice_core_accounts_seed_v1', 'done') ON CONFLICT (key) DO NOTHING");
    }
    // Backfill invoice permissions into saved role configs (run once)
    const _v5 = await client.query("SELECT value FROM settings WHERE key = 'perm_matrix_v5_backfilled'");
    if (!_v5.rows.length) {
      const _rp5 = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rp5.rows.length && _rp5.rows[0].value) {
        try {
          const obj = JSON.parse(_rp5.rows[0].value);
          if (obj && typeof obj === 'object') {
            ['locksmith', 'locksmith_coordinator', 'roadside_technician', 'manager'].forEach(function(r) {
              if (Array.isArray(obj[r])) {
                ['view_invoices', 'create_invoice', 'edit_invoice', 'delete_invoice'].forEach(function(p) { if (obj[r].indexOf(p) === -1) obj[r].push(p); });
              }
            });
            if (Array.isArray(obj.manager) && obj.manager.indexOf('manage_invoice_setup') === -1) obj.manager.push('manage_invoice_setup');
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('perm matrix v5 backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('perm_matrix_v5_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }
    // Onboarding is now an editable row in the Roles & Access matrix. Make sure
    // manager keeps manage_onboarding in any saved config (run once).
    const _onbPerm = await client.query("SELECT value FROM settings WHERE key = 'perm_onboarding_matrix_backfilled'");
    if (!_onbPerm.rows.length) {
      const _rpOnb = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rpOnb.rows.length && _rpOnb.rows[0].value) {
        try {
          const obj = JSON.parse(_rpOnb.rows[0].value);
          if (obj && typeof obj === 'object' && Array.isArray(obj.manager) && obj.manager.indexOf('manage_onboarding') === -1) {
            obj.manager.push('manage_onboarding');
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('perm onboarding backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('perm_onboarding_matrix_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }
    await client.query(
      'CREATE TABLE IF NOT EXISTS review_rating_snapshots (' +
      '  location_name TEXT PRIMARY KEY,' +
      '  displayed_rating NUMERIC(3,1) NOT NULL,' +
      '  avg_rating NUMERIC(4,2),' +
      '  review_count INTEGER,' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ')'
    );
    // Who a Google review is credited to. The reviews themselves live in the
    // review-bot's SEPARATE database (read-only); assignments are owned by Nova
    // and keyed on Google's stable review_id so they survive a re-sync.
    // source: 'ai' (filled by the tech tally) or 'manual' (set by a person);
    // the AI tally never overwrites a 'manual' row.
    await client.query(
      'CREATE TABLE IF NOT EXISTS review_assignments (' +
      '  review_id TEXT PRIMARY KEY,' +
      '  assignee TEXT NOT NULL,' +
      "  source TEXT NOT NULL DEFAULT 'manual'," +
      '  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ')'
    );
    // Link an assignment to a real Nova user (AI match or manual pick) plus the
    // AI's 0-100 match confidence. user_id NULL = an unmatched AI guess — the UI
    // shows it as an estimate but never offers it as a selectable choice.
    await client.query('ALTER TABLE review_assignments ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;');
    await client.query('ALTER TABLE review_assignments ADD COLUMN IF NOT EXISTS confidence INTEGER;');
    // Backfill: link existing text-only assignments whose name exactly equals a
    // user's full name, dispatch (pulsar) name, or one of their nicknames
    // (case-insensitive). A bare first name links when every user with that
    // first name shares the SAME full name (i.e. duplicate accounts of one
    // person) — the active account wins. Two genuinely different people with
    // the same first name stay unlinked. Idempotent — only touches rows that
    // are not linked yet. Guarded by a fire-once settings flag so it does not
    // re-run this scan on every boot; routes/reviews.js re-runs the same
    // name-match (backfillAssignmentLinks) before each tally to pick up newly
    // added nicknames, so nothing is lost by only doing it once here.
    const _raBackfill = await client.query("SELECT value FROM settings WHERE key = 'review_assignments_namematch_backfilled'");
    if (!_raBackfill.rows.length) {
      await client.query(
        "UPDATE review_assignments ra SET user_id = u.id FROM users u WHERE ra.user_id IS NULL AND TRIM(ra.assignee) <> '' AND (" +
        " LOWER(TRIM(ra.assignee)) = LOWER(TRIM(u.name))" +
        " OR LOWER(TRIM(ra.assignee)) = LOWER(TRIM(COALESCE(u.pulsar_name, '')))" +
        " OR LOWER(TRIM(ra.assignee)) IN (SELECT LOWER(TRIM(x)) FROM unnest(string_to_array(COALESCE(u.nickname, ''), ',')) AS x)" +
        ")"
      );
      await client.query(
        "UPDATE review_assignments ra SET user_id = (" +
        "SELECT u.id FROM users u WHERE LOWER(split_part(TRIM(u.name), ' ', 1)) = LOWER(TRIM(ra.assignee)) " +
        "ORDER BY u.active DESC, u.id DESC LIMIT 1) " +
        "WHERE ra.user_id IS NULL AND TRIM(ra.assignee) <> '' " +
        "AND (SELECT COUNT(DISTINCT LOWER(TRIM(u2.name))) FROM users u2 " +
        "WHERE LOWER(split_part(TRIM(u2.name), ' ', 1)) = LOWER(TRIM(ra.assignee))) = 1"
      );
      await client.query("INSERT INTO settings (key, value) VALUES ('review_assignments_namematch_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }
    await client.query(
      'CREATE TABLE IF NOT EXISTS oauth_clients (' +
      '  client_id TEXT PRIMARY KEY,' +
      '  client_secret TEXT,' +
      '  client_name TEXT,' +
      '  redirect_uris TEXT NOT NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS oauth_codes (' +
      '  code TEXT PRIMARY KEY,' +
      '  client_id TEXT NOT NULL,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  redirect_uri TEXT NOT NULL,' +
      '  code_challenge TEXT NOT NULL,' +
      '  scope TEXT,' +
      '  used BOOLEAN DEFAULT false,' +
      '  expires_at TIMESTAMPTZ NOT NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (' +
      '  token_hash TEXT PRIMARY KEY,' +
      '  client_id TEXT NOT NULL,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  scope TEXT,' +
      '  revoked BOOLEAN DEFAULT false,' +
      '  expires_at TIMESTAMPTZ NOT NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);' +
      'CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens(user_id);'
    );

    // Customer Feedback module - Pulsar tech-conduct emails land here, plus a
    // full resolution lifecycle (status, tech-at-fault, damages, refund, followup).
    await client.query(
      'CREATE TABLE IF NOT EXISTS customer_feedback (' +
      '  id SERIAL PRIMARY KEY,' +
      "  source VARCHAR(30) NOT NULL DEFAULT 'pulsar'," +
      '  external_ref VARCHAR(255),' +
      '  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),' +
      '  raw_email TEXT,' +
      '  raw_subject VARCHAR(500),' +
      '  customer_name VARCHAR(255),' +
      '  customer_phone VARCHAR(50),' +
      '  customer_email VARCHAR(255),' +
      '  vehicle_make VARCHAR(100),' +
      '  vehicle_model VARCHAR(100),' +
      '  vehicle_year VARCHAR(10),' +
      '  service_task VARCHAR(100),' +
      '  job_location VARCHAR(255),' +
      '  location_raw VARCHAR(255),' +
      '  city_code CHAR(3),' +
      '  tech_name_raw VARCHAR(255),' +
      '  tech_user_id INTEGER REFERENCES users(id),' +
      '  incident_text TEXT,' +
      '  invoice_ref VARCHAR(100),' +
      '  category VARCHAR(40),' +
      '  sentiment VARCHAR(20),' +
      '  severity VARCHAR(20),' +
      '  ai_summary VARCHAR(500),' +
      '  ai_processed BOOLEAN DEFAULT false,' +
      "  status VARCHAR(30) NOT NULL DEFAULT 'new'," +
      '  status_notes VARCHAR(255),' +
      '  assigned_to INTEGER REFERENCES users(id),' +
      '  task_id INTEGER,' +
      '  tech_at_fault BOOLEAN,' +
      '  total_damages DECIMAL(10,2) DEFAULT 0,' +
      '  refunded BOOLEAN DEFAULT false,' +
      '  refunded_amount DECIMAL(10,2) DEFAULT 0,' +
      '  followup_needed BOOLEAN DEFAULT false,' +
      '  followup_at TIMESTAMPTZ,' +
      '  followup_notes VARCHAR(255),' +
      '  followup_sent_at TIMESTAMPTZ,' +
      '  is_resolved BOOLEAN DEFAULT false,' +
      '  resolved_at TIMESTAMPTZ,' +
      '  resolved_notes VARCHAR(255),' +
      '  needs_review BOOLEAN DEFAULT false,' +
      '  last_interaction_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS customer_feedback_activity (' +
      '  id SERIAL PRIMARY KEY,' +
      '  feedback_id INTEGER NOT NULL REFERENCES customer_feedback(id) ON DELETE CASCADE,' +
      '  user_id INTEGER REFERENCES users(id),' +
      '  user_name VARCHAR(255),' +
      "  type VARCHAR(20) NOT NULL DEFAULT 'note'," +
      '  channel VARCHAR(20),' +
      '  body TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_dedupe ON customer_feedback(source, external_ref) WHERE external_ref IS NOT NULL;' +
      'CREATE INDEX IF NOT EXISTS idx_feedback_city ON customer_feedback(city_code);' +
      'CREATE INDEX IF NOT EXISTS idx_feedback_tech ON customer_feedback(tech_user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_feedback_status ON customer_feedback(status);' +
      'CREATE INDEX IF NOT EXISTS idx_feedback_severity ON customer_feedback(severity);' +
      'CREATE INDEX IF NOT EXISTS idx_feedback_last ON customer_feedback(last_interaction_at);' +
      'CREATE INDEX IF NOT EXISTS idx_feedback_followup ON customer_feedback(followup_at) WHERE followup_needed = true AND followup_sent_at IS NULL;' +
      'CREATE INDEX IF NOT EXISTS idx_feedback_act_fid ON customer_feedback_activity(feedback_id);'
    );
    // Feedback attachments - metadata only; bytes live in Cloudflare R2 (like documents).
    await client.query(
      'CREATE TABLE IF NOT EXISTS customer_feedback_attachments (' +
      '  id SERIAL PRIMARY KEY,' +
      '  feedback_id INTEGER NOT NULL REFERENCES customer_feedback(id) ON DELETE CASCADE,' +
      '  r2_key VARCHAR(512) UNIQUE NOT NULL,' +
      '  file_name VARCHAR(255) NOT NULL,' +
      '  mime_type VARCHAR(255),' +
      '  size_bytes BIGINT DEFAULT 0,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'pending'," +
      '  uploaded_by INTEGER REFERENCES users(id),' +
      '  uploaded_by_name VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_feedback_att_fid ON customer_feedback_attachments(feedback_id);'
    );

    // ===== Signatures module (Adobe Sign style) =====
    // E-signature requests. Source + flattened PDFs and signature images live in
    // Cloudflare R2; only metadata + R2 keys are stored here. page_dimensions holds
    // per-page width/height in PDF points (source of truth for normalized->point mapping).
    await client.query(
      'CREATE TABLE IF NOT EXISTS signature_requests (' +
      '  id SERIAL PRIMARY KEY,' +
      '  request_number VARCHAR(50) UNIQUE NOT NULL,' +
      '  title VARCHAR(255) NOT NULL,' +
      '  created_by INTEGER REFERENCES users(id),' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'draft'," +
      '  source_r2_key VARCHAR(512),' +
      '  signed_r2_key VARCHAR(512),' +
      '  page_count INTEGER DEFAULT 0,' +
      '  page_dimensions JSONB,' +
      '  message TEXT,' +
      '  expires_at TIMESTAMPTZ,' +
      '  sent_at TIMESTAMPTZ,' +
      '  completed_at TIMESTAMPTZ,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Each signer of a request. token gives no-login access to the public signing page.
    await client.query(
      'CREATE TABLE IF NOT EXISTS signature_signers (' +
      '  id SERIAL PRIMARY KEY,' +
      '  request_id INTEGER NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  email VARCHAR(255),' +
      '  phone VARCHAR(50),' +
      '  role_label VARCHAR(100),' +
      '  sign_order INTEGER,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'pending'," +
      '  token VARCHAR(128) UNIQUE,' +
      '  token_expires_at TIMESTAMPTZ,' +
      '  signed_at TIMESTAMPTZ,' +
      '  declined_reason TEXT,' +
      '  consent_accepted BOOLEAN NOT NULL DEFAULT false,' +
      '  user_id INTEGER REFERENCES users(id),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Field boxes. Position stored normalized 0-1 of page w/h, top-left origin
    // (render-resolution independent); the top-left->bottom-left flip happens at flatten time.
    await client.query(
      'CREATE TABLE IF NOT EXISTS signature_fields (' +
      '  id SERIAL PRIMARY KEY,' +
      '  request_id INTEGER NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,' +
      '  signer_id INTEGER REFERENCES signature_signers(id) ON DELETE CASCADE,' +
      '  field_type VARCHAR(20) NOT NULL,' +
      '  page INTEGER NOT NULL DEFAULT 0,' +
      '  x NUMERIC(8,6) NOT NULL,' +
      '  y NUMERIC(8,6) NOT NULL,' +
      '  w NUMERIC(8,6) NOT NULL,' +
      '  h NUMERIC(8,6) NOT NULL,' +
      '  required BOOLEAN NOT NULL DEFAULT true,' +
      '  label VARCHAR(255),' +
      '  ai_detected BOOLEAN NOT NULL DEFAULT false,' +
      '  ai_confidence NUMERIC(4,3),' +
      '  value TEXT,' +
      '  value_r2_key VARCHAR(512),' +
      '  font_size NUMERIC(5,2),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Tamper-evident audit trail: one row per lifecycle event (who/when/IP/UA).
    await client.query(
      'CREATE TABLE IF NOT EXISTS signature_events (' +
      '  id SERIAL PRIMARY KEY,' +
      '  request_id INTEGER NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,' +
      '  signer_id INTEGER REFERENCES signature_signers(id) ON DELETE SET NULL,' +
      '  event_type VARCHAR(30) NOT NULL,' +
      '  actor VARCHAR(255),' +
      '  ip VARCHAR(64),' +
      '  user_agent TEXT,' +
      '  detail JSONB,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS signature_signers_request_idx ON signature_signers (request_id);');
    await client.query('CREATE INDEX IF NOT EXISTS signature_fields_request_idx ON signature_fields (request_id);');
    await client.query('CREATE INDEX IF NOT EXISTS signature_fields_signer_idx ON signature_fields (signer_id);');
    await client.query('CREATE INDEX IF NOT EXISTS signature_events_request_idx ON signature_events (request_id);');
    await client.query('ALTER TABLE signature_fields ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false;');
    // Reusable signature templates: a saved form (PDF in R2) + its field layout and
    // signer role slots, stored as JSON. 'Use template' clones these into a new request.
    await client.query(
      'CREATE TABLE IF NOT EXISTS signature_templates (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  source_r2_key VARCHAR(512),' +
      '  page_count INTEGER DEFAULT 0,' +
      '  page_dimensions JSONB,' +
      '  roles JSONB,' +
      '  fields JSONB,' +
      '  created_by INTEGER REFERENCES users(id),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );

    // --- Secure Vault (owner-only, SHARED credential store) -------------------
    // Zero-knowledge: the server stores ONLY salts, public keys and ciphertext.
    // One shared data key (DEK) encrypts every entry. Each owner has a personal
    // keypair; their private key is encrypted under their own master password
    // (and their own recovery key), and the shared DEK is wrapped to each owner's
    // PUBLIC key. So master passwords, recovery keys, private keys and the DEK
    // itself never reach the server. A new owner is admitted by an existing
    // owner wrapping the DEK to the newcomer's public key — entirely client-side.
    await client.query(
      'CREATE TABLE IF NOT EXISTS vault_members (' +
      "  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE," +
      "  status VARCHAR(20) NOT NULL DEFAULT 'pending'," +   // 'active' | 'pending'
      '  public_key TEXT NOT NULL,' +                 // RSA-OAEP public key (SPKI, base64)
      '  kdf_salt VARCHAR(128) NOT NULL,' +           // hex salt for master-password KDF
      '  kdf_iterations INTEGER NOT NULL,' +          // PBKDF2 iteration count
      '  enc_private_key TEXT NOT NULL,' +            // private key encrypted under master key (JSON {iv,ct})
      '  wrapped_dek TEXT,' +                         // shared DEK encrypted to THIS owner key (base64); NULL while pending
      '  recovery_salt VARCHAR(128),' +              // hex salt for recovery-key KDF
      '  enc_private_key_recovery TEXT,' +            // private key encrypted under recovery key (JSON {iv,ct})
      '  approved_by INTEGER,' +
      '  approved_at TIMESTAMPTZ,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS vault_entries (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  iv VARCHAR(64) NOT NULL,' +                   // per-entry AES-GCM IV (hex)
      '  ciphertext TEXT NOT NULL,' +                  // encrypted JSON {title,url,username,password,notes,totp}
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_vault_entries_user ON vault_entries(user_id);');
    await client.query(
      'CREATE TABLE IF NOT EXISTS vault_challenges (' +
      '  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,' +
      '  code VARCHAR(6) NOT NULL,' +
      '  attempts INTEGER NOT NULL DEFAULT 0,' +
      '  expires_at TIMESTAMPTZ NOT NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );

    // Time Clock — one row per work session (punch in -> punch out)
    await client.query(
      'CREATE TABLE IF NOT EXISTS time_entries (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,' +
      '  user_name VARCHAR(255),' +
      '  city_code CHAR(3),' +
      '  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,' +
      '  clock_in_at TIMESTAMPTZ NOT NULL,' +
      '  clock_out_at TIMESTAMPTZ,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'open'," +   // open | closed | auto_closed | flagged
      '  worked_minutes INTEGER,' +
      '  late_minutes INTEGER,' +
      "  source VARCHAR(20) DEFAULT 'pwa'," +
      '  edited_by INTEGER,' +
      '  edited_at TIMESTAMPTZ,' +
      '  edit_reason TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Breaks within an entry. Unpaid (lunch) is subtracted from worked time; paid counts.
    await client.query(
      'CREATE TABLE IF NOT EXISTS time_breaks (' +
      '  id SERIAL PRIMARY KEY,' +
      '  entry_id INTEGER REFERENCES time_entries(id) ON DELETE CASCADE,' +
      "  type VARCHAR(10) NOT NULL," +                    // paid | unpaid
      '  break_start_at TIMESTAMPTZ NOT NULL,' +
      '  break_end_at TIMESTAMPTZ,' +
      '  minutes INTEGER,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // One approval row per user per pay week (Mon).
    await client.query(
      'CREATE TABLE IF NOT EXISTS time_week_approvals (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,' +
      '  week_start DATE NOT NULL,' +
      '  employee_approved_at TIMESTAMPTZ,' +
      '  manager_approved_by INTEGER,' +
      '  manager_approved_at TIMESTAMPTZ,' +
      '  submitted_at TIMESTAMPTZ,' +
      "  status VARCHAR(20) DEFAULT 'open'," +            // open | emp_approved | mgr_approved | submitted | reopened
      '  UNIQUE(user_id, week_start)' +
      ');'
    );
    // New user columns: pay structure + supervisor (for coordinator late-alert routing).
    await client.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_type VARCHAR(12) NOT NULL DEFAULT 'hourly';" +   // hourly | salary | commission
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS supervisor_id INTEGER;' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS org_level INTEGER;' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS default_backup_id INTEGER;'
    );
    // Late-alert fire-once flag on the matched shift.
    await client.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS late_alerted_at TIMESTAMPTZ;');
    // De-dupe before adding the partial UNIQUE index below: if any user already has
    // more than one OPEN entry (the very race the index prevents), the CREATE UNIQUE
    // would throw and abort the rest of initDB. Keep each user's newest open entry and
    // auto-close the older ones (zero duration) so the unique index can be built safely.
    await client.query(
      "UPDATE time_entries t SET status = 'auto_closed', " +
      "  clock_out_at = COALESCE(t.clock_out_at, t.clock_in_at), " +
      "  worked_minutes = COALESCE(t.worked_minutes, 0), updated_at = NOW() " +
      "WHERE t.status = 'open' AND t.id NOT IN (" +
      "  SELECT DISTINCT ON (user_id) id FROM time_entries WHERE status = 'open' " +
      "  ORDER BY user_id, clock_in_at DESC, id DESC" +
      ");"
    );
    // Indexes
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_time_entries_user_open ON time_entries(user_id) WHERE status = 'open';" +
      // At most one OPEN time entry per user (prevents double clock-in races).
      "CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_time_entry ON time_entries(user_id) WHERE status = 'open';" +
      'CREATE INDEX IF NOT EXISTS idx_time_entries_user_date ON time_entries(user_id, clock_in_at);' +
      'CREATE INDEX IF NOT EXISTS idx_time_breaks_entry ON time_breaks(entry_id);' +
      'CREATE INDEX IF NOT EXISTS idx_time_week_appr ON time_week_approvals(user_id, week_start);'
    );
    // Default settings (only inserted once)
    await client.query(
      "INSERT INTO settings (key, value) VALUES " +
      "('timeclock_overtime_threshold','40')," +
      "('timeclock_late_grace_min','10')," +
      "('timeclock_max_shift_hours','16')," +
      "('timeclock_late_target','both')," +
      "('timeclock_payroll_email','') " +
      "ON CONFLICT (key) DO NOTHING;"
    );
    // Holidays list (editable) — hours WORKED on these dates are categorized as holiday hours on the timesheet.
    await client.query(
      'CREATE TABLE IF NOT EXISTS holidays (' +
      '  id SERIAL PRIMARY KEY,' +
      '  holiday_date DATE NOT NULL UNIQUE,' +
      '  name VARCHAR(120) NOT NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Seed the 2026 U.S. federal holidays once. Admins can add/edit/remove afterward;
    // the fire-once flag means deletions are never re-added on the next restart.
    const _holSeed = await client.query("SELECT value FROM settings WHERE key = 'holidays_seeded_2026'");
    if (!_holSeed.rows.length) {
      await client.query(
        "INSERT INTO holidays (holiday_date, name) VALUES " +
        "('2026-01-01','New Year''s Day')," +
        "('2026-01-19','Martin Luther King Jr. Day')," +
        "('2026-02-16','Presidents'' Day')," +
        "('2026-05-25','Memorial Day')," +
        "('2026-06-19','Juneteenth')," +
        "('2026-07-04','Independence Day')," +
        "('2026-09-07','Labor Day')," +
        "('2026-10-12','Columbus Day')," +
        "('2026-11-11','Veterans Day')," +
        "('2026-11-26','Thanksgiving Day')," +
        "('2026-12-25','Christmas Day') " +
        "ON CONFLICT (holiday_date) DO NOTHING;"
      );
      await client.query("INSERT INTO settings (key, value) VALUES ('holidays_seeded_2026','1') ON CONFLICT (key) DO NOTHING;");
    }
    // Grant the new permissions to existing saved role matrices (fire once).
    const _tcPerm = await client.query("SELECT value FROM settings WHERE key = 'perm_timeclock_backfilled'");
    if (!_tcPerm.rows.length) {
      const _rpT = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rpT.rows.length && _rpT.rows[0].value) {
        try {
          const obj = JSON.parse(_rpT.rows[0].value);
          if (obj && typeof obj === 'object') {
            ['locksmith', 'locksmith_coordinator', 'roadside_technician', 'manager'].forEach(function (r) {
              if (Array.isArray(obj[r]) && obj[r].indexOf('view_timeclock') === -1) obj[r].push('view_timeclock');
            });
            if (Array.isArray(obj.manager) && obj.manager.indexOf('manage_timeclock') === -1) obj.manager.push('manage_timeclock');
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('timeclock perm backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('perm_timeclock_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }

    // ---- Onboarding module (gated new-hire track) ----
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_status VARCHAR(20) NOT NULL DEFAULT 'complete';");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_enrolled_at TIMESTAMPTZ;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completion_override JSONB;");
    await client.query(
      'CREATE TABLE IF NOT EXISTS onboarding_steps (' +
      '  id SERIAL PRIMARY KEY,' +
      '  position INTEGER NOT NULL DEFAULT 0,' +
      "  type VARCHAR(20) NOT NULL," +
      '  title VARCHAR(200) NOT NULL,' +
      '  description TEXT,' +
      '  sop_id INTEGER REFERENCES sop_documents(id) ON DELETE SET NULL,' +
      '  video_key TEXT,' +
      '  config JSONB,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS onboarding_progress (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  step_id INTEGER NOT NULL REFERENCES onboarding_steps(id) ON DELETE CASCADE,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'pending'," +
      '  score INTEGER,' +
      '  attempts INTEGER NOT NULL DEFAULT 0,' +
      '  started_at TIMESTAMPTZ,' +
      '  completed_at TIMESTAMPTZ,' +
      '  UNIQUE (user_id, step_id)' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS onboarding_quiz_attempts (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  step_id INTEGER NOT NULL REFERENCES onboarding_steps(id) ON DELETE CASCADE,' +
      '  questions JSONB NOT NULL,' +
      '  answers JSONB,' +
      '  score INTEGER,' +
      '  passed BOOLEAN,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  submitted_at TIMESTAMPTZ' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_onboarding_progress_user ON onboarding_progress(user_id);');
    // ---- Onboarding v3: phases, encrypted docs, packet, event log ----
    // Phase tag per step (1 = paperwork/no clock-in, 2 = training/clock-in).
    await client.query("ALTER TABLE onboarding_steps ADD COLUMN IF NOT EXISTS phase INTEGER NOT NULL DEFAULT 1;");
    // Role-based onboarding paths: a step may be scoped to one or more Nova
    // roles. NULL / empty means every hire gets it. A hire only ever sees the
    // steps whose roles match the role they were assigned.
    await client.query("ALTER TABLE onboarding_steps ADD COLUMN IF NOT EXISTS roles TEXT[];");
    // Which phase a new hire is currently in (drives the clock-in gate).
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_phase INTEGER NOT NULL DEFAULT 1;");
    // Approving Phase 1 and opening Phase 2 are two deliberate manager actions.
    // Approval clears the paperwork; the hire still waits until the manager sits
    // down with them and starts training.
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_phase1_approved_at TIMESTAMPTZ;');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_phase1_approved_by INTEGER REFERENCES users(id);');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_phase1_approved_name VARCHAR(255);');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_phase2_started_at TIMESTAMPTZ;');
    // Anyone already sitting in Phase 2 was approved under the old one-step flow.
    await client.query('UPDATE users SET onboarding_phase1_approved_at = NOW(), onboarding_phase2_started_at = NOW() WHERE onboarding_phase = 2 AND onboarding_phase1_approved_at IS NULL;');
    // Reuse the quiz-attempt table for the cumulative final exam.
    await client.query("ALTER TABLE onboarding_quiz_attempts ADD COLUMN IF NOT EXISTS is_final_exam BOOLEAN NOT NULL DEFAULT false;");
    // Encrypted personnel-document store. Serves BOTH the Phase 1 required
    // uploads and the living Employee File. Bytes in R2 under hr/ are AES-256-GCM
    // ciphertext; only manage_hr_documents roles can decrypt. Categories:
    // identity | license | insurance | registration | packet | acknowledgment |
    // review | disciplinary | tax | certification | other.
    await client.query(
      'CREATE TABLE IF NOT EXISTS hr_documents (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id),' +
      '  category VARCHAR(40) NOT NULL,' +
      '  slot_key VARCHAR(40),' +
      '  r2_key VARCHAR(512) UNIQUE NOT NULL,' +
      '  name VARCHAR(255),' +
      '  mime_type VARCHAR(255),' +
      '  size_bytes BIGINT DEFAULT 0,' +
      '  expires_at DATE,' +
      '  extracted JSONB,' +
      "  verify_status VARCHAR(20) NOT NULL DEFAULT 'unverified'," +
      '  verify_notes TEXT,' +
      "  review_status VARCHAR(20) NOT NULL DEFAULT 'pending'," +
      '  reject_reason TEXT,' +
      "  source VARCHAR(20) NOT NULL DEFAULT 'onboarding'," +
      '  uploaded_by INTEGER REFERENCES users(id),' +
      '  uploaded_by_name VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_hr_documents_user ON hr_documents(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_hr_documents_expires ON hr_documents(expires_at) WHERE expires_at IS NOT NULL;');
    // An expired document blocks the hire from moving past its upload step. A
    // manager can override that (Nova misread the date, a renewal is in hand,
    // etc.) — expiry_override records who accepted it and when.
    await client.query('ALTER TABLE hr_documents ADD COLUMN IF NOT EXISTS expiry_override BOOLEAN NOT NULL DEFAULT false;');
    await client.query('ALTER TABLE hr_documents ADD COLUMN IF NOT EXISTS expiry_override_by INTEGER REFERENCES users(id);');
    await client.query('ALTER TABLE hr_documents ADD COLUMN IF NOT EXISTS expiry_override_name VARCHAR(255);');
    await client.query('ALTER TABLE hr_documents ADD COLUMN IF NOT EXISTS expiry_override_at TIMESTAMPTZ;');
    // New Hire Packet responses (native form). One row per hire; field data in
    // JSONB so we need no column per packet field. field_flags holds any
    // per-field reject reasons a reviewer set on reopen.
    await client.query(
      'CREATE TABLE IF NOT EXISTS onboarding_packet_responses (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      "  data JSONB NOT NULL DEFAULT '{}'," +
      "  status VARCHAR(20) NOT NULL DEFAULT 'draft'," +
      '  field_flags JSONB,' +
      '  submitted_at TIMESTAMPTZ,' +
      '  reviewed_by INTEGER REFERENCES users(id),' +
      '  reviewed_by_name VARCHAR(255),' +
      '  reviewed_at TIMESTAMPTZ,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  UNIQUE (user_id)' +
      ');'
    );
    // Section 7 completion-event log: every event, dated, tied to the tech and
    // (where relevant) the document version. Exportable. Not cascade-deleted so
    // the training-evidence record survives.
    await client.query(
      'CREATE TABLE IF NOT EXISTS onboarding_events (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id),' +
      '  event_type VARCHAR(40) NOT NULL,' +
      '  step_id INTEGER,' +
      '  document_id INTEGER,' +
      '  document_version VARCHAR(40),' +
      '  score INTEGER,' +
      '  passed BOOLEAN,' +
      '  detail JSONB,' +
      '  actor_id INTEGER REFERENCES users(id),' +
      '  actor_name VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_onboarding_events_user ON onboarding_events(user_id);');

    // ---- Dispatcher role (mirror of Locksmith Coordinator) ----
    // Copy the coordinator's saved permission set to the new role, and include
    // dispatchers in the weekly SOP quiz audience if coordinators are in it (fire once).
    const _dsp = await client.query("SELECT value FROM settings WHERE key = 'dispatcher_role_backfilled'");
    if (!_dsp.rows.length) {
      const _rpD = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rpD.rows.length && _rpD.rows[0].value) {
        try {
          const obj = JSON.parse(_rpD.rows[0].value);
          if (obj && typeof obj === 'object' && !Array.isArray(obj.dispatcher) && Array.isArray(obj.locksmith_coordinator)) {
            obj.dispatcher = obj.locksmith_coordinator.slice();
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('dispatcher perm backfill failed:', e.message); }
      }
      const _qrD = await client.query("SELECT value FROM settings WHERE key = 'quiz_roles'");
      if (_qrD.rows.length && _qrD.rows[0].value) {
        try {
          const qr = JSON.parse(_qrD.rows[0].value);
          if (Array.isArray(qr) && qr.indexOf('locksmith_coordinator') !== -1 && qr.indexOf('dispatcher') === -1) {
            qr.push('dispatcher');
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('quiz_roles', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(qr)]);
          }
        } catch (e) { console.error('dispatcher quiz backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('dispatcher_role_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }

    // ---- Royalty statements (Pop-A-Lock monthly royalty & advertising fund) ----
    // One stored statement per city per month. Holds the raw Pulsar CSV (re-download),
    // the computed statement cells, the rate/motor-club settings snapshot, and the
    // headline totals for the history list. UNIQUE(city_id, period) => re-import replaces.
    await client.query(
      'CREATE TABLE IF NOT EXISTS royalty_statements (' +
      '  id SERIAL PRIMARY KEY,' +
      '  city_id INTEGER REFERENCES cities(id),' +
      '  city_code VARCHAR(8),' +
      '  city_name VARCHAR(255),' +
      '  owner_name VARCHAR(255),' +
      '  period VARCHAR(7) NOT NULL,' +
      '  csv_data TEXT,' +
      '  csv_filename VARCHAR(255),' +
      '  cells JSONB,' +
      '  settings JSONB,' +
      '  royalty_fee NUMERIC(14,2) DEFAULT 0,' +
      '  ad_fee NUMERIC(14,2) DEFAULT 0,' +
      '  gross_sales NUMERIC(14,2) DEFAULT 0,' +
      '  row_count INTEGER DEFAULT 0,' +
      '  completed_count INTEGER DEFAULT 0,' +
      '  unmapped JSONB,' +
      '  created_by INTEGER REFERENCES users(id),' +
      '  created_by_name VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  UNIQUE (city_id, period)' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_royalty_period ON royalty_statements(period);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_royalty_city ON royalty_statements(city_id);');

    // ---- Offboarding module (P1-P5) ----
    // User separation tracking columns
    await client.query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS separation_date DATE;' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS eligible_for_rehire BOOLEAN;' +
      // Offboarding limited-access flag: true = keep only time clock + PTO
      // (see the offboarding gate in middleware/auth.js). Full lockout is active=false.
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS offboarding_restricted BOOLEAN NOT NULL DEFAULT false;'
    );

    // Main offboarding record: one per departure
    await client.query(
      'CREATE TABLE IF NOT EXISTS offboardings (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  type VARCHAR(20) NOT NULL,' +
      '  status VARCHAR(20) NOT NULL DEFAULT ' + "'draft'" + ',' +
      '  notice_date DATE,' +
      '  last_day DATE NOT NULL,' +
      '  deactivate_mode VARCHAR(20) NOT NULL DEFAULT ' + "'end_of_last_day'" + ',' +
      '  reason_category VARCHAR(40),' +
      '  reason_notes TEXT,' +
      '  eligible_for_rehire BOOLEAN,' +
      '  rehire_notes TEXT,' +
      '  pto_balance_snapshot NUMERIC(8,2),' +
      '  template_id INTEGER,' +
      '  initiated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  finalized_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  finalized_at TIMESTAMPTZ,' +
      '  cancelled_reason TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_offboarding_open ON offboardings(user_id) WHERE status IN (' + "'draft'" + ', ' + "'active'" + ', ' + "'pending_finalize'" + ');');
    await client.query('ALTER TABLE offboardings ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;');

    // Offboarding templates: Core + role add-ons, role-scoped like P5 onboarding_steps
    await client.query(
      'CREATE TABLE IF NOT EXISTS offboarding_templates (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(120) NOT NULL,' +
      '  roles TEXT[],' +
      '  employment_types TEXT[],' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  position INTEGER NOT NULL DEFAULT 0' +
      ');'
    );

    // Template steps: frozen blueprint for composing a user&rsquo;s checklist
    await client.query(
      'CREATE TABLE IF NOT EXISTS offboarding_template_steps (' +
      '  id SERIAL PRIMARY KEY,' +
      '  template_id INTEGER NOT NULL REFERENCES offboarding_templates(id) ON DELETE CASCADE,' +
      '  title VARCHAR(500) NOT NULL,' +
      '  description TEXT,' +
      '  category VARCHAR(20) NOT NULL DEFAULT ' + "'access'" + ',' +
      '  assignee_kind VARCHAR(20) NOT NULL DEFAULT ' + "'manager'" + ',' +
      '  default_assignee_id INTEGER,' +
      '  due_offset_days INTEGER NOT NULL DEFAULT 0,' +
      '  required BOOLEAN NOT NULL DEFAULT false,' +
      '  wants_evidence BOOLEAN NOT NULL DEFAULT false,' +
      '  auto_key VARCHAR(40),' +
      '  applies_to TEXT[],' +
      '  position INTEGER NOT NULL DEFAULT 0' +
      ');'
    );

    // Instantiated steps: frozen copy at offboarding start (template edits never mutate live offboardings)
    await client.query(
      'CREATE TABLE IF NOT EXISTS offboarding_steps (' +
      '  id SERIAL PRIMARY KEY,' +
      '  offboarding_id INTEGER NOT NULL REFERENCES offboardings(id) ON DELETE CASCADE,' +
      '  template_step_id INTEGER,' +
      '  title VARCHAR(500) NOT NULL,' +
      '  description TEXT,' +
      '  category VARCHAR(20) NOT NULL,' +
      '  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  due_date DATE,' +
      '  required BOOLEAN NOT NULL DEFAULT false,' +
      '  wants_evidence BOOLEAN NOT NULL DEFAULT false,' +
      '  auto_key VARCHAR(40),' +
      '  status VARCHAR(20) NOT NULL DEFAULT ' + "'pending'" + ',' +
      '  skip_reason TEXT,' +
      '  evidence JSONB,' +
      '  completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  completed_at TIMESTAMPTZ,' +
      '  position INTEGER NOT NULL DEFAULT 0' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_offb_steps ON offboarding_steps(offboarding_id);');

    // Exit interview questions: global question bank (editable by admin)
    await client.query(
      'CREATE TABLE IF NOT EXISTS exit_interview_questions (' +
      '  id SERIAL PRIMARY KEY,' +
      '  prompt TEXT NOT NULL,' +
      '  qtype VARCHAR(12) NOT NULL,' +
      '  options JSONB,' +
      '  applies_to TEXT[],' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  position INTEGER NOT NULL DEFAULT 0' +
      ');'
    );

    // Exit interviews: one per offboarding
    await client.query(
      'CREATE TABLE IF NOT EXISTS exit_interviews (' +
      '  id SERIAL PRIMARY KEY,' +
      '  offboarding_id INTEGER NOT NULL UNIQUE REFERENCES offboardings(id) ON DELETE CASCADE,' +
      '  user_id INTEGER NOT NULL,' +
      '  mode VARCHAR(15) NOT NULL DEFAULT ' + "'self_serve'" + ',' +
      '  status VARCHAR(15) NOT NULL DEFAULT ' + "'draft'" + ',' +
      '  token VARCHAR(64) UNIQUE,' +
      '  token_expires_at TIMESTAMPTZ,' +
      '  waive_reason TEXT,' +
      '  would_return VARCHAR(8),' +
      '  sent_at TIMESTAMPTZ,' +
      '  submitted_at TIMESTAMPTZ' +
      ');'
    );

    // Exit interview answers: per question per interview
    await client.query(
      'CREATE TABLE IF NOT EXISTS exit_interview_answers (' +
      '  id SERIAL PRIMARY KEY,' +
      '  interview_id INTEGER NOT NULL REFERENCES exit_interviews(id) ON DELETE CASCADE,' +
      '  question_id INTEGER,' +
      '  question_snapshot JSONB NOT NULL,' +
      '  value_num INTEGER,' +
      '  value_text TEXT,' +
      '  answered_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );

    // Offboarding event log: mirrors onboarding_events
    await client.query(
      'CREATE TABLE IF NOT EXISTS offboarding_events (' +
      '  id SERIAL PRIMARY KEY,' +
      '  offboarding_id INTEGER NOT NULL REFERENCES offboardings(id) ON DELETE CASCADE,' +
      '  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  kind VARCHAR(40) NOT NULL,' +
      '  detail JSONB,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_offboarding_events_ob ON offboarding_events(offboarding_id);');

    // Seed default templates/steps/questions ONCE (only when the tables are empty),
    // so a server restart never duplicates them. After the first run, admins manage
    // these in Settings → Offboarding and their edits are preserved.
    const _obTplCount = await client.query('SELECT COUNT(*)::int AS n FROM offboarding_templates');
    if (_obTplCount.rows[0].n === 0) {
      await client.query(`
        INSERT INTO offboarding_templates (name, roles, employment_types, active, position)
        VALUES
          ('Core', NULL, NULL, true, 0),
          ('Field Tech Add-on', ARRAY['roadside_technician'], NULL, true, 10),
          ('Coordinator Add-on', ARRAY['locksmith_coordinator'], NULL, true, 20),
          ('Manager Add-on', ARRAY['manager'], NULL, true, 30),
          ('Admin Add-on', ARRAY['admin'], NULL, true, 40);
      `);

    // Seed core template steps (21 steps across 8 categories)
    const coreTemplate = await client.query('SELECT id FROM offboarding_templates WHERE name = $1', ['Core']);
    const templateId = coreTemplate.rows[0]?.id;
    if (templateId) {
      const coreSteps = [
        // Access (4 steps)
        { title: 'Revoke system logins', category: 'access', assignee_kind: 'manager', required: true, auto_key: null, position: 0 },
        { title: 'Disable VPN & email', category: 'access', assignee_kind: 'manager', required: true, auto_key: null, position: 1 },
        { title: 'Retrieve laptop & mobile', category: 'access', assignee_kind: 'manager', required: true, wants_evidence: true, position: 2 },
        { title: 'Deactivate access badges', category: 'access', assignee_kind: 'manager', required: true, auto_key: null, position: 3 },
        // Property (3 steps)
        { title: 'Collect company credit cards', category: 'property', assignee_kind: 'manager', required: true, wants_evidence: true, position: 4 },
        { title: 'Inventory assigned tools', category: 'property', assignee_kind: 'manager', required: true, wants_evidence: true, position: 5 },
        { title: 'Vehicle handoff (if assigned)', category: 'property', assignee_kind: 'manager', required: false, wants_evidence: true, position: 6 },
        // Payroll (3 steps)
        { title: 'Process final paycheck', category: 'payroll', assignee_kind: 'manager', required: true, auto_key: null, position: 7 },
        { title: 'Calculate PTO payout', category: 'payroll', assignee_kind: 'manager', required: true, auto_key: 'pto_payout_note', position: 8 },
        { title: 'Cancel future pay schedules', category: 'payroll', assignee_kind: 'manager', required: true, auto_key: 'clear_future_shifts', position: 9 },
        // Knowledge (3 steps)
        { title: 'Document knowledge transfer', category: 'knowledge', assignee_kind: 'manager', required: true, wants_evidence: true, position: 10 },
        { title: 'Collect project handover', category: 'knowledge', assignee_kind: 'manager', required: false, wants_evidence: true, position: 11 },
        { title: 'Review open tasks reassignment', category: 'knowledge', assignee_kind: 'manager', required: true, auto_key: 'reassign_open_tasks', position: 12 },
        // Interview (2 steps)
        { title: 'Send exit interview form', category: 'interview', assignee_kind: 'manager', required: true, auto_key: null, position: 13 },
        { title: 'Schedule exit interview (optional)', category: 'interview', assignee_kind: 'manager', required: false, position: 14 },
        // Communications (2 steps)
        { title: 'Notify team of departure', category: 'comms', assignee_kind: 'manager', required: true, auto_key: null, position: 15 },
        { title: 'Update directory & org chart', category: 'comms', assignee_kind: 'manager', required: true, auto_key: null, position: 16 },
        // HR (2 steps)
        { title: 'Collect signed exit documentation', category: 'hr', assignee_kind: 'manager', required: true, wants_evidence: true, position: 17 },
        { title: 'File final records', category: 'hr', assignee_kind: 'manager', required: true, auto_key: null, position: 18 },
        // Final (2 steps)
        { title: 'Vault security sweep', category: 'final', assignee_kind: 'admin', required: true, auto_key: 'vault_sweep', position: 19 },
        { title: 'Generate completion packet', category: 'final', assignee_kind: 'admin', required: true, auto_key: null, position: 20 }
      ];

      for (const step of coreSteps) {
        await client.query(
          'INSERT INTO offboarding_template_steps (template_id, title, category, assignee_kind, required, wants_evidence, auto_key, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING',
          [templateId, step.title, step.category, step.assignee_kind, step.required, step.wants_evidence || false, step.auto_key, step.position]
        );
      }
    }
    }

    // Seed exit interview questions ONCE (only when empty), same idempotency rule.
    const _obQCount = await client.query('SELECT COUNT(*)::int AS n FROM exit_interview_questions');
    if (_obQCount.rows[0].n === 0) {
      await client.query(`
        INSERT INTO exit_interview_questions (prompt, qtype, options, active, position)
        VALUES
          ('Would you consider working for us again in the future?', 'radio', '{"options": ["Yes, definitely", "Maybe", "Probably not", "No"]}', true, 0),
          ('What was the primary reason for your departure?', 'select', '{"options": ["Pay/compensation", "Schedule/hours", "Management/leadership", "Better opportunity", "Personal/family", "Other"]}', true, 1),
          ('How would you rate your overall experience working here?', 'radio', '{"options": ["Excellent", "Good", "Fair", "Poor"]}', true, 2),
          ('What could we have done better?', 'text', NULL, true, 3),
          ('Any additional feedback for leadership?', 'text', NULL, true, 4);
      `);
    }

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
