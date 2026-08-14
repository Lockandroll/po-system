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
      '  unit_price DECIMAL(10,2) NOT NULL,' +
      "  line_type VARCHAR(10) NOT NULL DEFAULT 'part'" +
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
      // A quote line is either work we perform (labor) or a thing we buy (part).
      // Without this, push-to-invoice had to guess and always guessed 'part', which
      // dropped the labor charge into parts COGS and wrecked the gross margin.
      "ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS line_type VARCHAR(10) NOT NULL DEFAULT 'part';" +
      'ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS orderer_id INTEGER REFERENCES users(id);' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS receive_emails BOOLEAN NOT NULL DEFAULT true;' +
      'ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS shipping_address_id INTEGER;' +
      'ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS url TEXT;' +
      // Customer contact details captured on the quote so they carry over when a
      // quote is pushed to an invoice (map to invoices.street_address/city/state/zip/phone/email).
      'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_street VARCHAR(255);' +
      'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_city VARCHAR(120);' +
      'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_state VARCHAR(4);' +
      'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_zip VARCHAR(12);' +
      'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50);' +
      'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);'
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
    // Security logging. The IP used to live only inside the free-text details
    // JSON, which meant it could not be filtered, indexed or shown as a column.
    // Promote it to a real column; utils/audit.js still mirrors it into details
    // so the ~90 days of historical rows keep rendering the same way.
    await client.query(
      'ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip VARCHAR(64);'
    );
    // The audit log is now the intrusion-detection record, so it gets queried by
    // (entity_type, time) and by action far more than it used to.
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_audit_entity_created ON audit_logs(entity_type, created_at DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_logs(action, created_at DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);'
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
    // Two-price model: price stays as our (wholesale) cost; retail_price is the
    // customer-facing, marked-up price that flows onto invoices and quote list prices.
    // The default markup multiplier lives in settings and is editable in the UI.
    await client.query('ALTER TABLE parts ADD COLUMN IF NOT EXISTS retail_price DECIMAL(10,2);');
    await client.query("INSERT INTO settings (key, value) VALUES ('parts_default_markup', '2.3') ON CONFLICT (key) DO NOTHING;");
    // One-time backfill: seed retail from the 2.3x default so existing parts aren't
    // blank. Only touches rows with no retail yet, so it never clobbers manual edits.
    await client.query('UPDATE parts SET retail_price = ROUND(price * 2.3, 2) WHERE retail_price IS NULL AND price IS NOT NULL;');
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
    // Who gets credit for the survey. employee_name is the display string
    // (a copy of users.name once linked, otherwise the raw Geico "Tech ID"
    // text); employee_user_id is the real Nova user behind it, set by the
    // Employee dropdown on the survey table or by the CSV import when the
    // imported name matched somebody on the roster. employee_source records
    // which of the two put it there - 'manual' rows are never overwritten by a
    // later CSV import.
    await client.query(
      'ALTER TABLE geico_surveys ADD COLUMN IF NOT EXISTS employee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;'
    );
    await client.query(
      'ALTER TABLE geico_surveys ADD COLUMN IF NOT EXISTS employee_source VARCHAR(10);'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_geico_employee_user ON geico_surveys(employee_user_id);'
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
    // Per-shift change history (schedule audit trail). No FK on shift_id on purpose:
    // a 'deleted' event must survive the shift row it describes. employee_id is a
    // denormalized convenience; the editor timeline queries by shift_id. details is a
    // JSON blob ({changes:{field:{from,to}}} for edits, or a small context object).
    await client.query(
      'CREATE TABLE IF NOT EXISTS shift_events (' +
      '  id SERIAL PRIMARY KEY,' +
      '  shift_id INTEGER,' +
      '  employee_id INTEGER,' +
      '  action VARCHAR(30) NOT NULL,' +
      '  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  actor_name VARCHAR(255),' +
      '  details JSONB,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_shift_events_shift ON shift_events(shift_id);');
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
    // Cash-deposit expense review: a manager approves or denies each expense
    // line one at a time. A DENIED line is money the company is not taking off
    // what the tech owes, so it drops out of every Over/Short total - which is
    // why the decision has to live on the row rather than be inferred.
    // Existing rows land on 'pending', and pending still COUNTS: nothing about
    // a deposit filed before this shipped changes until someone reviews it.
    await client.query(
      "ALTER TABLE deposit_expenses ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) DEFAULT 'pending';" +
      'ALTER TABLE deposit_expenses ADD COLUMN IF NOT EXISTS review_reason TEXT;' +
      'ALTER TABLE deposit_expenses ADD COLUMN IF NOT EXISTS reviewed_by INTEGER;' +
      'ALTER TABLE deposit_expenses ADD COLUMN IF NOT EXISTS reviewed_by_name VARCHAR(255);' +
      'ALTER TABLE deposit_expenses ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;'
    );
    await client.query("UPDATE deposit_expenses SET review_status = 'pending' WHERE review_status IS NULL;");
    await client.query(
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS ai_amount DECIMAL(10,2);' +
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS ai_deposit_date DATE;' +
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS ai_edited BOOLEAN DEFAULT FALSE;'
    );
    // ---- Deposit edit permission backfill --------------------------------
    // edit_deposit is new. A saved role_permissions matrix was rebuilt from the
    // checkboxes that existed when it was last saved, so it cannot contain the
    // new key and hasPermission() would read the SAVED array (not DEFAULTS) and
    // deny every manager. Seed it onto manager once. Guarded by a flag so it
    // never undoes an admin who later unticks the box. Deliberately NOT seeded
    // onto the technician roles - editing a submitted deposit is supervisory.
    const _rpDepEdit = await client.query("SELECT value FROM settings WHERE key = 'perm_deposit_edit_backfilled'");
    if (!_rpDepEdit.rows.length) {
      const _rpDE = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rpDE.rows.length && _rpDE.rows[0].value) {
        try {
          const obj = JSON.parse(_rpDE.rows[0].value);
          if (obj && typeof obj === 'object' && Array.isArray(obj.manager)) {
            if (obj.manager.indexOf('edit_deposit') === -1) obj.manager.push('edit_deposit');
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('deposit edit perm backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('perm_deposit_edit_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }
    // ---- Pulsar cash reconciliation -------------------------------------
    // A manager drops the Pulsar "Call Search" CSV for a pay week; every call
    // where the tech collected CASH lands in pulsar_cash_calls, and the Cash
    // Deposits page reconciles that against the deposit the tech submitted.
    // call_uid is Pulsar's own per-call key (verified unique with zero blanks
    // across a 1,403-row export) and is UNIQUE here so re-importing an
    // overlapping export can never double-count a call.
    await client.query(
      'CREATE TABLE IF NOT EXISTS pulsar_imports (' +
      '  id SERIAL PRIMARY KEY,' +
      '  period_start DATE NOT NULL,' +
      '  period_end DATE NOT NULL,' +
      '  filename VARCHAR(255),' +
      '  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  uploaded_by_name VARCHAR(255),' +
      '  total_rows INTEGER DEFAULT 0,' +
      '  cash_rows INTEGER DEFAULT 0,' +
      '  cash_total DECIMAL(12,2) DEFAULT 0,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS pulsar_cash_calls (' +
      '  id SERIAL PRIMARY KEY,' +
      '  import_id INTEGER REFERENCES pulsar_imports(id) ON DELETE CASCADE,' +
      '  call_uid VARCHAR(100) NOT NULL,' +
      '  invoice VARCHAR(50),' +
      '  call_date DATE NOT NULL,' +
      '  period_start DATE NOT NULL,' +
      '  period_end DATE NOT NULL,' +
      '  location_raw VARCHAR(255),' +
      '  city_code CHAR(3),' +
      '  tech_raw VARCHAR(255),' +
      '  tech_display VARCHAR(255),' +
      '  tech_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  task VARCHAR(100),' +
      '  status VARCHAR(30),' +
      '  account VARCHAR(255),' +
      '  cash DECIMAL(10,2) NOT NULL DEFAULT 0,' +
      '  tax DECIMAL(10,2) DEFAULT 0,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ')'
    );
    // Every column added after first release needs its own idempotent ALTER --
    // CREATE TABLE IF NOT EXISTS will not backfill a table that already exists
    // on the live database.
    await client.query(
      'ALTER TABLE pulsar_imports ADD COLUMN IF NOT EXISTS uploaded_by_name VARCHAR(255);' +
      'ALTER TABLE pulsar_imports ADD COLUMN IF NOT EXISTS total_rows INTEGER DEFAULT 0;' +
      'ALTER TABLE pulsar_imports ADD COLUMN IF NOT EXISTS cash_rows INTEGER DEFAULT 0;' +
      'ALTER TABLE pulsar_imports ADD COLUMN IF NOT EXISTS cash_total DECIMAL(12,2) DEFAULT 0;' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS invoice VARCHAR(50);' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS period_start DATE;' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS period_end DATE;' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS location_raw VARCHAR(255);' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS city_code CHAR(3);' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS tech_raw VARCHAR(255);' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS tech_display VARCHAR(255);' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS tech_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS task VARCHAR(100);' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS status VARCHAR(30);' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS account VARCHAR(255);' +
      'ALTER TABLE pulsar_cash_calls ADD COLUMN IF NOT EXISTS tax DECIMAL(10,2) DEFAULT 0;'
    );
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_pulsar_cash_uid ON pulsar_cash_calls(call_uid);' +
      'CREATE INDEX IF NOT EXISTS idx_pulsar_cash_period ON pulsar_cash_calls(period_start, period_end);' +
      'CREATE INDEX IF NOT EXISTS idx_pulsar_cash_tech ON pulsar_cash_calls(tech_user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_pulsar_cash_import ON pulsar_cash_calls(import_id);' +
      'CREATE INDEX IF NOT EXISTS idx_pulsar_cash_date ON pulsar_cash_calls(call_date);' +
      'CREATE INDEX IF NOT EXISTS idx_pulsar_imports_period ON pulsar_imports(period_start);'
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
      // parts_cost_total is the COGS figure the tech reads off the close-out card
      // and types into Pulsar. cogs_incomplete flags an invoice closed with at
      // least one part line the tech marked "no cost available".
      '  parts_cost_total DECIMAL(10,2) DEFAULT 0,' +
      '  cogs_incomplete BOOLEAN DEFAULT false,' +
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
      // unit_cost is OUR cost, snapshotted at the moment the part is added — not
      // joined live to parts.price, because the catalog gets re-priced and a live
      // join would silently rewrite the margin on every historical invoice.
      '  unit_cost DECIMAL(10,2),' +
      '  cost_unknown BOOLEAN DEFAULT false,' +
      '  cost_unknown_reason VARCHAR(255),' +
      // catalog | manual | backfill | none — lets a margin report tell a real
      // captured cost apart from one estimated by the one-time backfill below.
      '  cost_source VARCHAR(12),' +
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
    // COGS capture. CREATE TABLE IF NOT EXISTS never adds columns to a table that
    // already exists in prod, so every column above also needs an explicit ALTER.
    await client.query(
      'ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS unit_cost DECIMAL(10,2);' +
      'ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS cost_unknown BOOLEAN DEFAULT false;' +
      'ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS cost_unknown_reason VARCHAR(255);' +
      'ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS cost_source VARCHAR(12);' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS parts_cost_total DECIMAL(10,2) DEFAULT 0;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cogs_incomplete BOOLEAN DEFAULT false;'
    );
    // One-time backfill of historical invoices from the current catalog cost.
    // This is an ESTIMATE — it uses today's parts.price, not the price in force
    // on the day of sale — so every row it touches is tagged cost_source
    // 'backfill' and a margin report can footnote or exclude those. Invoices
    // written from here forward carry a real snapshot. Guarded by a settings
    // flag so it runs exactly once, the same pattern as the perm matrix backfills.
    const _cogsBf = await client.query("SELECT value FROM settings WHERE key = 'invoice_cogs_backfilled'");
    if (!_cogsBf.rows.length) {
      await client.query(
        'UPDATE invoice_line_items li SET unit_cost = p.price, ' +
        "       cost_source = CASE WHEN li.line_type = 'labor' THEN 'none' ELSE 'backfill' END " +
        '  FROM parts p ' +
        ' WHERE p.id = li.part_id AND li.unit_cost IS NULL AND p.price IS NOT NULL'
      );
      await client.query(
        'UPDATE invoices i SET parts_cost_total = COALESCE(x.c, 0) FROM (' +
        '  SELECT invoice_id, SUM(quantity * COALESCE(unit_cost, 0)) AS c ' +
        '    FROM invoice_line_items ' +
        "   WHERE line_type <> 'labor' AND cost_unknown IS NOT TRUE " +
        '   GROUP BY invoice_id) x ' +
        ' WHERE x.invoice_id = i.id'
      );
      // The backfill can only price lines that came from the catalog. A hand-typed
      // line on an old invoice has no cost anywhere, and the rollup above silently
      // counts it as zero — so mark those invoices incomplete. Without this an old
      // invoice shows a low COGS under an "all costed" tick and the tech has no
      // reason to doubt the number they are about to type into Pulsar.
      const _flagged = await client.query(
        'UPDATE invoices i SET cogs_incomplete = true ' +
        ' WHERE EXISTS (SELECT 1 FROM invoice_line_items li ' +
        "                WHERE li.invoice_id = i.id AND li.line_type <> 'labor' " +
        '                  AND li.cost_unknown IS NOT TRUE AND li.unit_cost IS NULL)'
      );
      await client.query("INSERT INTO settings (key, value) VALUES ('invoice_cogs_backfilled', '1') ON CONFLICT (key) DO NOTHING");
      console.log('Backfilled invoice COGS from the current parts catalog (estimated, tagged cost_source=backfill); ' +
        (_flagged.rowCount || 0) + ' invoice(s) flagged cogs_incomplete because some part lines have no cost on record');
    }
    // One-time typing of historical quote lines. Every existing row defaulted to
    // 'part' when line_type was added, which is wrong for the labor lines techs
    // have always hand-typed — and being wrong here is what pushed a labor charge
    // into parts COGS. Deliberately narrow: the row must read like labor AND have
    // no supplier AND no part URL, because calling a real part 'labor' would erase
    // its cost from the margin. \y is a word boundary, so 'elaborate' and
    // 'collaboration' do not match. Anything it gets wrong is one dropdown away
    // from being fixed on the quote, and the count is logged rather than assumed.
    const _qltBf = await client.query("SELECT value FROM settings WHERE key = 'quote_line_type_backfilled'");
    if (!_qltBf.rows.length) {
      const _typed = await client.query(
        "UPDATE quote_line_items SET line_type = 'labor' " +
        " WHERE line_type = 'part' " +
        "   AND COALESCE(TRIM(manufacturer), '') = '' " +
        "   AND COALESCE(TRIM(url), '') = '' " +
        "   AND (COALESCE(item_number, '') || ' ' || COALESCE(description, '')) " +
        "       ~* '\\y(labor|labour|trip charge|trip fee|service call|service charge|diagnostic|diagnosis|dispatch|call ?out|after ?hours|overtime)\\y'"
      );
      await client.query("INSERT INTO settings (key, value) VALUES ('quote_line_type_backfilled', '1') ON CONFLICT (key) DO NOTHING");
      console.log('Typed ' + (_typed.rowCount || 0) + ' historical quote line(s) as labor (no supplier, no URL, reads like labor); everything else stayed a part. Check the Type column on any quote that looks wrong.');
    }
    // Per-account (vendor) config for the invoice account dropdown
    await client.query(
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS show_in_invoice BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS invoice_notes TEXT;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS auto_line_items JSONB;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS agreement_text TEXT;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS restricted_to INTEGER[];'
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
    // Invoice: scanned driver-license / ID image. Stored privately in R2 (key only
    // in the DB) and kept OFF the customer copy. Retained as identity evidence for
    // chargeback disputes; only managers/admins can retrieve it. One image per invoice.
    await client.query(
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS id_image_r2_key TEXT;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS id_image_mime TEXT;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS id_image_uploaded_at TIMESTAMPTZ;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS id_image_uploaded_by INTEGER;'
    );
    // ---- Invoice refunds -----------------------------------------------------
    // A refund is never an edit to the invoice: the signed original stays exactly
    // as the customer agreed to it (which is what the Square dispute packet leans
    // on) and every refund is an append-only row here. Rows are immutable once
    // they land — a mistake is reversed with a void, never deleted.
    // status: requested -> approved -> processed, plus rejected / voided.
    await client.query(
      'CREATE TABLE IF NOT EXISTS invoice_refunds (' +
      '  id SERIAL PRIMARY KEY,' +
      '  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,' +
      '  refund_number VARCHAR(40),' +
      '  amount DECIMAL(10,2) NOT NULL DEFAULT 0,' +
      '  labor_refunded DECIMAL(10,2) DEFAULT 0,' +
      '  parts_refunded DECIMAL(10,2) DEFAULT 0,' +
      '  tax_refunded DECIMAL(10,2) DEFAULT 0,' +
      '  tip_refunded DECIMAL(10,2) DEFAULT 0,' +
      "  method VARCHAR(20) DEFAULT 'card'," +
      '  reason_code VARCHAR(40),' +
      '  reason_notes TEXT,' +
      '  part_returned BOOLEAN DEFAULT false,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'requested'," +
      '  external_ref VARCHAR(120),' +
      '  refund_date DATE DEFAULT CURRENT_DATE,' +
      '  requested_by INTEGER REFERENCES users(id),' +
      '  requested_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  approved_by INTEGER REFERENCES users(id),' +
      '  approved_at TIMESTAMPTZ,' +
      '  approver_note TEXT,' +
      '  rejection_reason TEXT,' +
      '  processed_by INTEGER REFERENCES users(id),' +
      '  processed_at TIMESTAMPTZ,' +
      '  voided_by INTEGER REFERENCES users(id),' +
      '  voided_at TIMESTAMPTZ,' +
      '  void_reason TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_invoice_refunds_invoice ON invoice_refunds(invoice_id);' +
      'CREATE INDEX IF NOT EXISTS idx_invoice_refunds_status ON invoice_refunds(status);' +
      'CREATE INDEX IF NOT EXISTS idx_invoice_refunds_date ON invoice_refunds(refund_date);'
    );
    // Which lines a refund gave back, when the refund was built line by line.
    // Holds a snapshot of the line as it was refunded (description, unit price,
    // taxable flag) so history stays readable even if the invoice line is later
    // corrected by an admin, plus restock: TRUE means the part went back on the
    // shelf and should drop out of the month-end reorder.
    await client.query(
      'CREATE TABLE IF NOT EXISTS invoice_refund_lines (' +
      '  id SERIAL PRIMARY KEY,' +
      '  refund_id INTEGER NOT NULL REFERENCES invoice_refunds(id) ON DELETE CASCADE,' +
      '  invoice_line_item_id INTEGER REFERENCES invoice_line_items(id) ON DELETE SET NULL,' +
      "  line_type VARCHAR(10) DEFAULT 'part'," +
      '  item_number VARCHAR(100),' +
      '  description TEXT,' +
      '  quantity DECIMAL(10,2) DEFAULT 0,' +
      '  unit_price DECIMAL(10,2) DEFAULT 0,' +
      '  amount DECIMAL(10,2) DEFAULT 0,' +
      '  taxable BOOLEAN DEFAULT false,' +
      '  restock BOOLEAN DEFAULT false,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_invoice_refund_lines_refund ON invoice_refund_lines(refund_id);' +
      'CREATE INDEX IF NOT EXISTS idx_invoice_refund_lines_item ON invoice_refund_lines(invoice_line_item_id);'
    );
    // How the refund was built: 'line' (specific invoice lines), 'category'
    // (labor and/or parts as buckets) or 'flat' (one figure split proportionally).
    await client.query(
      "ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS mode VARCHAR(12) DEFAULT 'flat';"
    );
    // refunded_total is the running sum of approved + processed refunds; the
    // customer-facing net is grand_total - refunded_total. status_before_refund
    // remembers what the invoice was before its first refund so a void restores
    // it exactly instead of guessing 'paid'.
    await client.query(
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS refunded_total DECIMAL(10,2) DEFAULT 0;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status_before_refund VARCHAR(20);'
    );
    // ---- Real refunds pushed to Square ---------------------------------
    // Everything below tracks a refund that ACTUALLY MOVED MONEY through the
    // Square Refunds API, as opposed to one somebody typed in by hand. The two
    // live side by side on purpose: cash, checks, and any refund Square rejects
    // still go through the manual paste-the-reference path.
    //
    // square_status is Square's word, not Nova's: PENDING (accepted, settling
    // over the next few days), COMPLETED, REJECTED, FAILED, or the local
    // 'SENDING' while a request is in flight. A refund that Square accepts is
    // recorded as issued immediately, because the money is gone the moment
    // Square says PENDING — waiting for COMPLETED would leave the ledger
    // claiming the customer had not been paid back when they had.
    //
    // square_idempotency_key is written BEFORE the call to Square and reused on
    // every retry, so a double tap, a crashed request, or a browser refresh can
    // never produce two refunds against one payment.
    //
    // square_amount_cents is what Nova actually asked Square for, kept separately
    // from invoice_refunds.amount so a later edit to the ledger can never make
    // it look like a different sum was refunded than the one that left the bank.
    await client.query(
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_payment_id VARCHAR(255);' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_refund_id VARCHAR(255);' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_order_id VARCHAR(255);' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_status VARCHAR(20);' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_idempotency_key VARCHAR(45);' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_amount_cents INTEGER;' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_processing_fee_cents INTEGER;' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_sent_at TIMESTAMPTZ;' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_settled_at TIMESTAMPTZ;' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_sent_by INTEGER;' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_error_code VARCHAR(60);' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_error TEXT;' +
      // Square publishes ONE receipt per payment and shows the refund on it, so
      // this is the PAYMENT's receipt_url, not a refund-specific one. Stored on
      // the refund row anyway so the link survives even if the payment row is
      // later scrubbed, and so nothing has to guess a URL shape.
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_receipt_url TEXT;' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS square_attempts INTEGER DEFAULT 0;' +
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS raw_refund JSONB;'
    );
    // ---- Square identifiers are long. Widen every one of them. -------------
    // This cost real money once. A Square PaymentRefund id is the payment id, an
    // underscore, and a token: about 90 characters, and Square documents the
    // field as up to 255. The columns were created at VARCHAR(64), so the write
    // that records the refund threw "value too long for type character
    // varying(64)" AFTER Square had already moved the money, and Nova ended up
    // with no record of a refund the customer had been paid.
    //
    // Every Square-issued identifier is widened to 255 here, not just the refund
    // id, because they all come from the same place and none of them are ours to
    // bound. ALTER TYPE on a varchar widening is a metadata-only change in
    // Postgres, so this is instant even on a large table, and the UNIQUE indexes
    // on square_payment_id survive it.
    await client.query(
      'ALTER TABLE invoice_refunds ALTER COLUMN square_payment_id TYPE VARCHAR(255);' +
      'ALTER TABLE invoice_refunds ALTER COLUMN square_refund_id TYPE VARCHAR(255);' +
      'ALTER TABLE invoice_refunds ALTER COLUMN square_order_id TYPE VARCHAR(255);' +
      // external_ref holds the Square refund id too (it is what a human would
      // have pasted in by hand), so it has to be at least as wide.
      'ALTER TABLE invoice_refunds ALTER COLUMN external_ref TYPE VARCHAR(255);'
    );
    // UNIQUE, not just indexed: two Nova rows pointing at one Square refund would
    // mean the same money was counted against the invoice twice. The partial
    // index keeps every not-yet-sent refund out of the constraint.
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_refunds_sq_refund ON invoice_refunds(square_refund_id) WHERE square_refund_id IS NOT NULL;' +
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_refunds_sq_idem ON invoice_refunds(square_idempotency_key) WHERE square_idempotency_key IS NOT NULL;' +
      'CREATE INDEX IF NOT EXISTS idx_invoice_refunds_sq_status ON invoice_refunds(square_status);'
    );
    // ---- Square payment collection -------------------------------------
    // A tech taps Collect Payment, Square Point of Sale runs the card, and Nova
    // fills in the pay type / last 4 / approval code from Square instead of the
    // tech's thumbs. Kept in its own table rather than columns on invoices for
    // three reasons: the invoice row gets frozen at 'paid', one invoice may need
    // split tenders later, and the raw Square payload is worth keeping because
    // it is what the chargeback packet is built from.
    await client.query(
      'CREATE TABLE IF NOT EXISTS invoice_payments (' +
      '  id SERIAL PRIMARY KEY,' +
      '  invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,' +
      '  state_nonce VARCHAR(64) NOT NULL UNIQUE,' +
      // initiated | returned | reconciled | offline_pending | mismatch | failed | canceled | unconfirmed
      "  status VARCHAR(24) NOT NULL DEFAULT 'initiated'," +
      '  amount_requested_cents INTEGER NOT NULL DEFAULT 0,' +
      '  square_location_id VARCHAR(64),' +
      '  platform VARCHAR(10),' +
      '  initiated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  initiated_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  returned_at TIMESTAMPTZ,' +
      '  square_transaction_id VARCHAR(255),' +
      '  square_client_transaction_id VARCHAR(255),' +
      '  square_order_id VARCHAR(255),' +
      '  square_payment_id VARCHAR(255) UNIQUE,' +
      '  card_brand VARCHAR(40),' +
      '  card_last4 VARCHAR(4),' +
      '  auth_result_code VARCHAR(20),' +
      '  entry_method VARCHAR(20),' +
      '  avs_status VARCHAR(20),' +
      '  cvv_status VARCHAR(20),' +
      '  tip_cents INTEGER DEFAULT 0,' +
      '  total_cents INTEGER,' +
      '  processing_fee_cents INTEGER,' +
      '  receipt_url TEXT,' +
      '  receipt_number VARCHAR(20),' +
      '  square_status VARCHAR(20),' +
      '  square_team_member_id VARCHAR(64),' +
      '  team_member_mismatch BOOLEAN DEFAULT false,' +
      '  square_created_at TIMESTAMPTZ,' +
      '  error_code VARCHAR(60),' +
      '  error_description TEXT,' +
      '  mismatch_reason TEXT,' +
      '  raw_payment JSONB,' +
      '  reconciled_at TIMESTAMPTZ,' +
      '  reconcile_attempts INTEGER DEFAULT 0,' +
      '  last_error TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_invpay_invoice ON invoice_payments(invoice_id);' +
      'CREATE INDEX IF NOT EXISTS idx_invpay_status ON invoice_payments(status);' +
      'CREATE INDEX IF NOT EXISTS idx_invpay_order ON invoice_payments(square_order_id);' +
      // A card run in the Square app with no Nova invoice behind it. Not an
      // error, but it is the single most interesting line on the daily
      // reconciliation report, so it gets recorded rather than dropped.
      'CREATE TABLE IF NOT EXISTS square_orphan_payments (' +
      '  id SERIAL PRIMARY KEY,' +
      '  square_payment_id VARCHAR(255) NOT NULL UNIQUE,' +
      '  square_order_id VARCHAR(255),' +
      '  location_id VARCHAR(255),' +
      '  amount_cents INTEGER,' +
      '  note TEXT,' +
      '  team_member_id VARCHAR(255),' +
      '  taken_at TIMESTAMPTZ,' +
      '  resolved BOOLEAN DEFAULT false,' +
      '  raw_payment JSONB,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // CREATE TABLE IF NOT EXISTS never adds columns to a table that already
    // exists, so every column above also needs an explicit ALTER once this
    // ships and the table is live.
    await client.query(
      'ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS square_team_member_id VARCHAR(255);' +
      'ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS team_member_mismatch BOOLEAN DEFAULT false;' +
      'ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS mismatch_reason TEXT;' +
      'ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS platform VARCHAR(10);'
    );
    // Widen the Square identifiers on tables that already exist at VARCHAR(64).
    // See the note above invoice_refunds: a Square PaymentRefund id runs to about
    // 90 characters and Square documents these fields as up to 255, so a 64-wide
    // column throws "value too long for type character varying(64)" on a real id.
    // None of these identifiers are Nova's to bound. ALTER TYPE widening a varchar
    // is metadata-only in Postgres, so this is instant and the UNIQUE index on
    // square_payment_id survives it.
    await client.query(
      'ALTER TABLE invoice_payments ALTER COLUMN square_transaction_id TYPE VARCHAR(255);' +
      'ALTER TABLE invoice_payments ALTER COLUMN square_client_transaction_id TYPE VARCHAR(255);' +
      'ALTER TABLE invoice_payments ALTER COLUMN square_order_id TYPE VARCHAR(255);' +
      'ALTER TABLE invoice_payments ALTER COLUMN square_payment_id TYPE VARCHAR(255);' +
      'ALTER TABLE invoice_payments ALTER COLUMN square_location_id TYPE VARCHAR(255);' +
      'ALTER TABLE invoice_payments ALTER COLUMN square_team_member_id TYPE VARCHAR(255);' +
      'ALTER TABLE square_orphan_payments ALTER COLUMN square_payment_id TYPE VARCHAR(255);' +
      'ALTER TABLE square_orphan_payments ALTER COLUMN square_order_id TYPE VARCHAR(255);' +
      'ALTER TABLE square_orphan_payments ALTER COLUMN location_id TYPE VARCHAR(255);' +
      'ALTER TABLE square_orphan_payments ALTER COLUMN team_member_id TYPE VARCHAR(255);'
    );
    // authorized_total is what the customer SIGNED for, before any tip added
    // inside the Square app. Without it the signed agreement says one number and
    // the invoice says another, and that discrepancy is what loses a chargeback.
    // Every screen that shows a total after a Square tip must show both.
    await client.query(
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS authorized_total DECIMAL(10,2);' +
      // Which Square team member this employee signs in as. Lets Nova flag a
      // payment run by a different tech than the one on the invoice. Soft flag,
      // never a block — running a card for someone else's job is a real thing.
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS square_team_member_id VARCHAR(64);'
    );
    // Backfill: every already-signed invoice was authorized for exactly what it
    // totals today, because there was no way to add a tip after the fact. Safe to
    // re-run; it only ever fills NULLs.
    await client.query(
      'UPDATE invoices SET authorized_total = grand_total WHERE authorized_total IS NULL AND signature_image IS NOT NULL;'
    );
    // ---- Invoice process rework -----------------------------------------
    // Field feedback was that "Completed" and "Paid" both read as a finish line,
    // so techs used them interchangeably and the reports stopped meaning
    // anything. There is now exactly ONE finish line plus a named branch:
    //
    //   Active  -> Completed              paid on the spot, or billed to an account
    //   Active  -> Waiting for Payment -> Completed
    //
    // ⚠️ The STORED values deliberately do NOT change. 'draft' displays as
    // "Active" and 'paid' displays as "Completed". LOCKED_STATUSES,
    // refunds.status_before_refund (values already sitting in live rows), the
    // Square narrow writer, the Square reconciliation query and the AI tool
    // enums all key on 'paid'. Renaming would be two ordered, non-repeatable
    // migrations across live money records for a cosmetic gain. The labels live
    // in INV_STATUS_LABELS in public/js/app.js.
    await client.query(
      // When the invoice reached the finish line, and who put it there. Drives the
      // 15-minute reopen grace period; NULL means no grace (old invoices).
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;' +
      // When it entered Waiting for Payment, so the list can age it.
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS waiting_since TIMESTAMPTZ;' +
      // The chase task. Closed automatically when the invoice reaches Completed,
      // otherwise you build a graveyard of stale follow-ups nobody trusts.
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS followup_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;' +
      // Split billing (GEICO covers $100 of a key make, customer owes the rest).
      // Both halves carry the same split_group_id; the generated invoice also
      // points at the one it came from.
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS split_group_id INTEGER;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS split_parent_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;' +
      'CREATE INDEX IF NOT EXISTS idx_invoices_split_group ON invoices(split_group_id);' +
      'CREATE INDEX IF NOT EXISTS idx_invoices_followup ON invoices(followup_task_id);'
    );
    // Pay types that are BILLED rather than collected in the field. An invoice on
    // one of these completes straight away instead of going to Waiting for
    // Payment, because nobody is going to chase the customer for it. A setting,
    // not a hardcoded list, so it can change without a deploy.
    await client.query(
      "INSERT INTO settings (key, value) VALUES ('invoice_billed_pay_types', $1) ON CONFLICT (key) DO NOTHING",
      [JSON.stringify(['Account / Invoice', 'Motor Club'])]
    );
    // ONE-TIME: the old 'completed' status meant the work was done but the money
    // was not in, which is exactly what Waiting for Payment means now. Guarded by
    // a settings flag so it can never run twice and re-capture invoices that a
    // human has since moved on purpose. No follow-up tasks are created
    // retroactively; these are historical.
    const _invProc = await client.query("SELECT value FROM settings WHERE key = 'invoice_status_rework_migrated'");
    if (!_invProc.rows.length) {
      const _moved = await client.query("UPDATE invoices SET status = 'awaiting_payment' WHERE status = 'completed' RETURNING id");
      if (_moved.rowCount) {
        console.log('Invoice status rework: moved ' + _moved.rowCount + " invoice(s) from 'completed' to 'awaiting_payment'");
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('invoice_status_rework_migrated', '1') ON CONFLICT (key) DO NOTHING");
    }
    // Refund permissions: anyone who can create an invoice may REQUEST a refund
    // (that is the tech who wrote it, standing in front of the customer); only a
    // manager and up may approve one. Backfilled into any saved role matrix once,
    // because DEFAULTS in permissions.js do nothing for a role that already has a
    // saved entry.
    const _rpRef = await client.query("SELECT value FROM settings WHERE key = 'perm_refund_matrix_backfilled'");
    if (!_rpRef.rows.length) {
      const _rpR = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rpR.rows.length && _rpR.rows[0].value) {
        try {
          const obj = JSON.parse(_rpR.rows[0].value);
          if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach(function (r) {
              if (!Array.isArray(obj[r])) return;
              if (obj[r].indexOf('create_invoice') !== -1 && obj[r].indexOf('request_refund') === -1) obj[r].push('request_refund');
            });
            if (Array.isArray(obj.manager) && obj.manager.indexOf('approve_refund') === -1) obj.manager.push('approve_refund');
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('refund perm backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('perm_refund_matrix_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }
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
    // Which requirement slot a photo fills (dl / entitlement / plate / after_service,
    // or an admin-defined key). NULL means the tech attached it as an extra photo and
    // it counts toward nothing.
    await client.query('ALTER TABLE invoice_photos ADD COLUMN IF NOT EXISTS photo_type VARCHAR(40);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_invoice_photos_type ON invoice_photos(invoice_id, photo_type);');
    // Per-account override of the required-photo list. NULL means "use the global
    // list from Invoice Setup". An empty array means "this account requires none",
    // which is a real, different answer, so it must survive round-tripping.
    await client.query('ALTER TABLE vendors ADD COLUMN IF NOT EXISTS required_photos JSONB;');
    // Per-account close-out requirements (Tony, 2026-08-05). Simple booleans, all
    // default OFF: an account is flagged only when it genuinely mandates the item.
    //   require_signature   -> invoice needs a captured signature; this is also the
    //                          switch that shows the Agreement + Signature block at
    //                          all. Off -> no agreement, no signature asked for.
    //   require_entitlement -> at least one Entitlement box (reg/ins/title/rental).
    //   require_vehicle     -> Year, Make and Model present.
    //   require_photos      -> at least one photo attached.
    // Read live at close-out. Signature is ALSO snapshotted onto
    // invoices.signature_required so an old invoice keeps the rule it closed under.
    await client.query(
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS require_entitlement BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS require_vehicle BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS require_photos BOOLEAN NOT NULL DEFAULT false;'
    );
    // Signature Required is a company policy set once under Invoice Setup, not a
    // per-invoice checkbox a tech can quietly clear on the job that most needs the
    // signature. Default ON. invoices.signature_required is still written on every
    // save so an old invoice keeps the rule it was closed out under.
    const _invSigDef = await client.query("SELECT value FROM settings WHERE key = 'invoice_signature_required_default'");
    if (!_invSigDef.rows.length) {
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('invoice_signature_required_default', 'true', NOW()) ON CONFLICT (key) DO NOTHING");
    }
    // The photo slots a non-draft invoice has to fill. Entitlement is deliberately
    // ONE slot that any of insurance / registration / rental agreement satisfies —
    // the customer only ever has one of the three.
    const _invPhotoReq = await client.query("SELECT value FROM settings WHERE key = 'invoice_photo_requirements'");
    if (!_invPhotoReq.rows.length) {
      await client.query(
        "INSERT INTO settings (key, value, updated_at) VALUES ('invoice_photo_requirements', $1, NOW()) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify([
          { key: 'dl', label: "Driver's License", required: true },
          { key: 'entitlement', label: 'Entitlement (Insurance / Registration / Rental Agreement)', required: true },
          { key: 'plate', label: 'License Plate', required: true },
          { key: 'after_service', label: 'After Service', required: true }
        ])]
      );
    }
    // ---- Card surcharge --------------------------------------------------
    // The customer picks Cash or Card at close-out. Card adds a percentage of
    // (subtotal + sales tax) as a SEPARATE column.
    //
    // WARNING: surcharge_amount must NEVER be folded into subtotal, labor_amount,
    // parts_amount or tax_amount, and must never become a line item. Those are
    // what a human reads off the close-out card and types into Pulsar, and the
    // royalty CSV is downloaded FROM Pulsar. A surcharge that leaks into any of
    // them pays a 5% royalty + 1% ad fee on money that is not sales. It is also
    // deliberately outside the taxable base, so sales tax never moves.
    //
    //   grand_total = subtotal + tax_amount + surcharge_amount + tip_amount
    //
    // surcharge_rate is stored PER INVOICE so an old invoice keeps the rate it
    // closed out under even after the company setting changes.
    await client.query(
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS surcharge_amount DECIMAL(10,2) DEFAULT 0;' +
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS surcharge_rate DECIMAL(5,2) DEFAULT 0;' +
      // 'cash' | 'card' | NULL. NULL means nobody has asked yet, which is what the
      // close-out popup keys off. It is NOT the same answer as 'cash'.
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pay_method VARCHAR(10);'
    );
    // Sign-off -> invoice link. The unit is the JOB, i.e.
    // signoff_forms.trip_group_id, NOT the PO string: a PO is user-typed, can
    // be blank, and can be reused across stores, so grouping on it would merge
    // unrelated jobs onto one invoice and collapse every blank-PO sheet into a
    // single one. Deliberately NOT a foreign key, for the same reason
    // trip_group_id itself is not: deleting a sheet must not drag the invoice.
    await client.query(
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS signoff_group_id INTEGER;' +
      'CREATE INDEX IF NOT EXISTS idx_invoices_signoff_group ON invoices(signoff_group_id);'
    );
    // Every invoice that already exists was closed out before surcharging, so it
    // carries none. Safe to re-run; only ever touches NULLs.
    await client.query(
      'UPDATE invoices SET surcharge_amount = 0 WHERE surcharge_amount IS NULL;' +
      'UPDATE invoices SET surcharge_rate = 0 WHERE surcharge_rate IS NULL;'
    );
    // A refund needs a fifth bucket. Without it, refunding a surcharged invoice
    // in full spreads the surcharge across labor/parts/tax and overstates
    // refunded SALES — the very figure that nets against Pulsar and the tax
    // remittance. NULL-safe: every existing refund carries 0.
    await client.query(
      'ALTER TABLE invoice_refunds ADD COLUMN IF NOT EXISTS surcharge_refunded DECIMAL(10,2) DEFAULT 0;'
    );
    await client.query('UPDATE invoice_refunds SET surcharge_refunded = 0 WHERE surcharge_refunded IS NULL;');
    // One company-wide rate, set under Invoice Setup. 2.5 matches what Square's
    // own built-in surcharge charges on this merchant.
    const _invSurRate = await client.query("SELECT value FROM settings WHERE key = 'invoice_surcharge_rate'");
    if (!_invSurRate.rows.length) {
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('invoice_surcharge_rate', '2.5', NOW()) ON CONFLICT (key) DO NOTHING");
    }
    // Master switch, default OFF. Off means the popup never appears and every
    // invoice computes a zero surcharge, which is the safe state to fall back to.
    const _invSurOn = await client.query("SELECT value FROM settings WHERE key = 'invoice_surcharge_enabled'");
    if (!_invSurOn.rows.length) {
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('invoice_surcharge_enabled', 'false', NOW()) ON CONFLICT (key) DO NOTHING");
    }
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
    // The roster person the AI THINKS the guessed name refers to, kept even when
    // its confidence lands under the hard-link threshold. user_id stays NULL in
    // that case (nothing is credited automatically), but the Reviews page can
    // offer a one-click Confirm against a specific person instead of making a
    // manager hunt the name out of the dropdown. Cleared on a manual assignment.
    await client.query('ALTER TABLE review_assignments ADD COLUMN IF NOT EXISTS suggested_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;');
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
      '  no_tech BOOLEAN NOT NULL DEFAULT false,' +
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
    // no_tech: explicit "no tech to assign" so a complaint can be resolved without pinning a tech.
    await client.query("ALTER TABLE customer_feedback ADD COLUMN IF NOT EXISTS no_tech BOOLEAN NOT NULL DEFAULT false;");
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

    // ===== GoTo Connect integration =====
    // Single-row OAuth token store. GoTo has NO client_credentials grant, so an
    // admin consents once in a browser and Nova keeps the refresh token alive.
    // Tokens are AES-256-GCM encrypted by utils/goto.js before they land here -
    // a leaked GoTo refresh token reads EVERY call recording in the company,
    // because GoTo has no per-department scoping on recordings.
    await client.query(
      'CREATE TABLE IF NOT EXISTS goto_oauth (' +
      '  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),' +
      '  access_token TEXT,' +
      '  refresh_token TEXT,' +
      '  expires_at TIMESTAMPTZ,' +
      '  scope TEXT,' +
      '  account_key VARCHAR(64),' +
      '  connected_by INTEGER REFERENCES users(id),' +
      '  connected_at TIMESTAMPTZ,' +
      '  last_refresh_at TIMESTAMPTZ,' +
      '  last_error TEXT' +
      ');'
    );

    // The call index: one row per completed GoTo conversation. This exists
    // because GoTo has no "recordings for a phone number" endpoint - the join
    // from a number to a recording id is ours to own and persist.
    // raw_report keeps the untouched payload: several GoTo field names are
    // undocumented, so this lets us re-derive without re-fetching.
    await client.query(
      'CREATE TABLE IF NOT EXISTS goto_calls (' +
      '  id SERIAL PRIMARY KEY,' +
      '  conversation_space_id VARCHAR(64) UNIQUE NOT NULL,' +
      '  account_key VARCHAR(64),' +
      '  direction VARCHAR(16),' +
      '  call_started_at TIMESTAMPTZ,' +
      '  call_ended_at TIMESTAMPTZ,' +
      '  duration_sec INTEGER,' +
      '  external_number VARCHAR(32),' +
      '  external_digits VARCHAR(20),' +
      '  internal_number VARCHAR(32),' +
      '  agent_name VARCHAR(255),' +
      '  agent_user_key VARCHAR(64),' +
      '  recording_id VARCHAR(128),' +
      '  transcript_id VARCHAR(128),' +
      '  has_recording BOOLEAN NOT NULL DEFAULT false,' +
      '  r2_key VARCHAR(512),' +
      '  r2_bytes BIGINT DEFAULT 0,' +
      '  r2_mime VARCHAR(64),' +
      '  archived_at TIMESTAMPTZ,' +
      '  raw_report JSONB,' +
      '  last_seen_revision TIMESTAMPTZ,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );

    // Complaint <-> call join. A repeat customer can legitimately have one call
    // relevant to two complaints, so this is many-to-many rather than a column
    // on customer_feedback.
    //   is_primary - THE complaint call, the one a dispute packet should cite
    //   hidden     - dismissed as not relevant (shared office numbers, wrong
    //                customer) without deleting it from the index
    await client.query(
      'CREATE TABLE IF NOT EXISTS feedback_call_recordings (' +
      '  id SERIAL PRIMARY KEY,' +
      '  feedback_id INTEGER NOT NULL REFERENCES customer_feedback(id) ON DELETE CASCADE,' +
      '  call_id INTEGER NOT NULL REFERENCES goto_calls(id) ON DELETE CASCADE,' +
      "  link_type VARCHAR(16) NOT NULL DEFAULT 'auto'," +
      '  linked_by INTEGER REFERENCES users(id),' +
      '  linked_by_name VARCHAR(255),' +
      '  is_primary BOOLEAN NOT NULL DEFAULT false,' +
      '  hidden BOOLEAN NOT NULL DEFAULT false,' +
      '  note VARCHAR(255),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  UNIQUE (feedback_id, call_id)' +
      ');'
    );

    await client.query(
      // external_digits is the match key (last 10 digits). Plain equality on an
      // indexed column, never a LIKE scan.
      'CREATE INDEX IF NOT EXISTS idx_goto_calls_digits ON goto_calls(external_digits);' +
      'CREATE INDEX IF NOT EXISTS idx_goto_calls_started ON goto_calls(call_started_at DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_goto_calls_recording ON goto_calls(recording_id);' +
      // Work queue for the archiver job: recorded but not yet copied into R2.
      'CREATE INDEX IF NOT EXISTS idx_goto_calls_unarchived ON goto_calls(id) WHERE has_recording = true AND r2_key IS NULL;' +
      'CREATE INDEX IF NOT EXISTS idx_fbcall_fid ON feedback_call_recordings(feedback_id);' +
      'CREATE INDEX IF NOT EXISTS idx_fbcall_cid ON feedback_call_recordings(call_id);' +
      // At most one primary call per complaint.
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_fbcall_primary ON feedback_call_recordings(feedback_id) WHERE is_primary = true;'
    );

    // GoTo recording audio. NOTE: an earlier comment here said the media URL
    // arrives only in the recording.UPLOADED notification. That was wrong - the
    // notification carries nothing but content.recording_id. The audio comes
    // from the contact-center-reports API on api.jive.com, which needs an
    // ORGANISATION id that is not the account key and is not returned by any
    // documented endpoint. Observed in GoTo's own web portal 2026-07-28.
    await client.query("ALTER TABLE goto_calls ADD COLUMN IF NOT EXISTS media_url TEXT;");
    await client.query("ALTER TABLE goto_calls ADD COLUMN IF NOT EXISTS media_url_at TIMESTAMPTZ;");
    await client.query("ALTER TABLE goto_oauth ADD COLUMN IF NOT EXISTS org_id VARCHAR(64);");
    await client.query(
      'CREATE TABLE IF NOT EXISTS goto_webhook (' +
      '  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),' +
      '  channel_id VARCHAR(255),' +
      '  channel_nickname VARCHAR(120),' +
      '  subscription_id VARCHAR(255),' +
      '  subscribe_note TEXT,' +
      '  created_at TIMESTAMPTZ,' +
      '  last_event_at TIMESTAMPTZ,' +
      '  event_count INTEGER NOT NULL DEFAULT 0,' +
      '  matched_count INTEGER NOT NULL DEFAULT 0,' +
      '  last_payload_shape JSONB,' +
      '  last_error TEXT' +
      ');'
    );
    // Recordings we were told about but could not match to an indexed call yet
    // (the notification can beat the call report). Replayed by the sync job.
    await client.query(
      'CREATE TABLE IF NOT EXISTS goto_pending_media (' +
      '  id SERIAL PRIMARY KEY,' +
      '  recording_id VARCHAR(128) UNIQUE NOT NULL,' +
      '  media_url TEXT NOT NULL,' +
      '  received_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  attempts INTEGER NOT NULL DEFAULT 0' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_goto_calls_media ON goto_calls(id) WHERE media_url IS NOT NULL AND r2_key IS NULL;'
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

    // ---- SOP Quiz permission backfill ----
    // view_quiz / manage_quiz / view_team_quiz were enforced by the API but had no
    // row on the Roles page, so any saved matrix is missing them (saveRoles rebuilt
    // each role from the visible checkboxes only). Seed manager with what it has
    // always had in practice, otherwise removing the hardcoded manager bypass in
    // requireTeamQuiz would take SOP Quiz away from managers on deploy.
    const _rpq = await client.query("SELECT value FROM settings WHERE key = 'perm_quiz_matrix_backfilled'");
    if (!_rpq.rows.length) {
      const _rpQ = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rpQ.rows.length && _rpQ.rows[0].value) {
        try {
          const obj = JSON.parse(_rpQ.rows[0].value);
          if (obj && typeof obj === 'object' && Array.isArray(obj.manager)) {
            ['view_quiz', 'manage_quiz', 'view_team_quiz'].forEach(function (p) {
              if (obj.manager.indexOf(p) === -1) obj.manager.push(p);
            });
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('quiz perm backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('perm_quiz_matrix_backfilled', '1') ON CONFLICT (key) DO NOTHING");
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

    // ------------------------------------------------------------------
    // Asset / Equipment tracker
    //
    // Per-LOCATION inventory of company property, assigned to individual
    // technicians, who initial each line and sign once for what they hold.
    // Replacements are requested, reviewed against the tech's own history,
    // and an approval opens a draft PO.
    //
    // This is deliberately NOT the parts catalog. the parts table is customer-facing
    // stock with a retail markup that feeds quotes and invoices; equipment is
    // company property with a cost and no retail price. The two never join.
    // ------------------------------------------------------------------

    // The Equipment List: what kinds of things we issue. Company-wide.
    // vendor_name / item_number / unit_cost are this catalog's own ordering
    // details and are what a replacement PO writes itself from.
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_types (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  category VARCHAR(20) NOT NULL DEFAULT ' + "'tool'" + ',' +
      '  serialized BOOLEAN NOT NULL DEFAULT false,' +
      '  expected_life_months INTEGER,' +
      '  vendor_name VARCHAR(255),' +
      '  item_number VARCHAR(255),' +
      '  manufacturer VARCHAR(255),' +
      '  unit_cost DECIMAL(10,2),' +
      '  product_url TEXT,' +
      '  notes TEXT,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  position INTEGER NOT NULL DEFAULT 0,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_asset_types_active ON asset_types(active);');

    // Serialized units only. Counted items live in asset_stock instead.
    // city_code is the OWNING location and stays set while the unit is out
    // with a tech, so a location keeps its own property on its own books.
    await client.query(
      'CREATE TABLE IF NOT EXISTS assets (' +
      '  id SERIAL PRIMARY KEY,' +
      '  asset_type_id INTEGER NOT NULL REFERENCES asset_types(id) ON DELETE CASCADE,' +
      '  asset_tag VARCHAR(40) UNIQUE,' +
      '  serial_number VARCHAR(120),' +
      '  city_code CHAR(3),' +
      '  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  status VARCHAR(20) NOT NULL DEFAULT ' + "'in_stock'" + ',' +
      '  condition VARCHAR(20),' +
      '  purchase_date DATE,' +
      '  purchase_cost DECIMAL(10,2),' +
      '  po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,' +
      '  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,' +
      '  notes TEXT,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(assigned_user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_assets_city ON assets(city_code);' +
      'CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type_id);' +
      'CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);'
    );

    // Counted stock, per location. min_qty is THIS city's minimum, not a
    // global one: Charleston runs six trucks and Greenville runs two.
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_stock (' +
      '  id SERIAL PRIMARY KEY,' +
      '  asset_type_id INTEGER NOT NULL REFERENCES asset_types(id) ON DELETE CASCADE,' +
      '  city_code CHAR(3) NOT NULL,' +
      '  qty_on_hand INTEGER NOT NULL DEFAULT 0,' +
      '  min_qty INTEGER NOT NULL DEFAULT 0,' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  UNIQUE(asset_type_id, city_code)' +
      ');'
    );

    // Every change to a count, with a reason and a reference. Without this
    // the numbers drift and nobody can explain why.
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_stock_moves (' +
      '  id SERIAL PRIMARY KEY,' +
      '  asset_type_id INTEGER NOT NULL REFERENCES asset_types(id) ON DELETE CASCADE,' +
      '  city_code CHAR(3) NOT NULL,' +
      '  delta INTEGER NOT NULL,' +
      '  reason VARCHAR(30) NOT NULL,' +
      '  ref_type VARCHAR(20),' +
      '  ref_id INTEGER,' +
      '  qty_after INTEGER,' +
      '  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  user_name VARCHAR(255),' +
      '  note TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_asset_moves_city ON asset_stock_moves(city_code, created_at DESC);');

    // City-to-city movement. Stock sits in transit until the receiving city
    // confirms, which is what catches the box that never arrived.
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_transfers (' +
      '  id SERIAL PRIMARY KEY,' +
      '  transfer_number VARCHAR(50) UNIQUE NOT NULL,' +
      '  from_city CHAR(3) NOT NULL,' +
      '  to_city CHAR(3) NOT NULL,' +
      '  status VARCHAR(20) NOT NULL DEFAULT ' + "'in_transit'" + ',' +
      '  reason VARCHAR(30),' +
      '  notes TEXT,' +
      '  sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  sent_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  received_at TIMESTAMPTZ,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_transfer_lines (' +
      '  id SERIAL PRIMARY KEY,' +
      '  transfer_id INTEGER NOT NULL REFERENCES asset_transfers(id) ON DELETE CASCADE,' +
      '  asset_type_id INTEGER REFERENCES asset_types(id) ON DELETE SET NULL,' +
      '  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,' +
      '  label VARCHAR(255),' +
      '  qty INTEGER NOT NULL DEFAULT 1' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_asset_tr_lines ON asset_transfer_lines(transfer_id);');

    // THE SPINE. One row per time a person was given something. Open rows
    // (returned_at IS NULL) are what they hold right now; closed rows are the
    // history every replacement statistic is derived from. No counters.
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_holdings (' +
      '  id SERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  asset_type_id INTEGER NOT NULL REFERENCES asset_types(id) ON DELETE CASCADE,' +
      '  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,' +
      '  qty INTEGER NOT NULL DEFAULT 1,' +
      '  city_code CHAR(3),' +
      '  unit_cost DECIMAL(10,2),' +
      '  issued_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  ack_id INTEGER,' +
      '  returned_at TIMESTAMPTZ,' +
      '  returned_reason VARCHAR(30),' +
      '  replaced_by_holding_id INTEGER,' +
      '  status VARCHAR(20) NOT NULL DEFAULT ' + "'held'" + ',' +
      '  condition_out VARCHAR(20),' +
      '  condition_in VARCHAR(20),' +
      '  notes TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_holdings_user ON asset_holdings(user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_holdings_open ON asset_holdings(user_id) WHERE returned_at IS NULL;' +
      'CREATE INDEX IF NOT EXISTS idx_holdings_type_user ON asset_holdings(asset_type_id, user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_holdings_city ON asset_holdings(city_code);'
    );

    // Assignment templates. roles[] scopes a kit the same way offboarding
    // templates are scoped.
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_kits (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(255) NOT NULL,' +
      '  description TEXT,' +
      '  roles TEXT[] NOT NULL DEFAULT ' + "'{}'" + ',' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_kit_items (' +
      '  id SERIAL PRIMARY KEY,' +
      '  kit_id INTEGER NOT NULL REFERENCES asset_kits(id) ON DELETE CASCADE,' +
      '  asset_type_id INTEGER NOT NULL REFERENCES asset_types(id) ON DELETE CASCADE,' +
      '  qty INTEGER NOT NULL DEFAULT 1,' +
      '  required BOOLEAN NOT NULL DEFAULT true,' +
      '  position INTEGER NOT NULL DEFAULT 0' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_asset_kit_items ON asset_kit_items(kit_id);');

    // The signed document. signature_data is a base64 PNG of a drawn
    // signature, same shape as signoff_forms, with the same provenance columns.
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_acknowledgments (' +
      '  id SERIAL PRIMARY KEY,' +
      '  ack_number VARCHAR(50) UNIQUE NOT NULL,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  city_code CHAR(3),' +
      '  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  status VARCHAR(20) NOT NULL DEFAULT ' + "'pending'" + ',' +
      '  note TEXT,' +
      '  agreement_text TEXT,' +
      '  signature_data TEXT,' +
      '  signed_at TIMESTAMPTZ,' +
      '  declined_reason TEXT,' +
      '  gps_lat DECIMAL(10,7),' +
      '  gps_lon DECIMAL(10,7),' +
      '  gps_accuracy DECIMAL(10,2),' +
      '  ip VARCHAR(64),' +
      '  user_agent TEXT,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Lines are a FROZEN copy taken when the acknowledgment is sent. Renaming
    // an equipment type next year must not rewrite what somebody signed.
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_ack_lines (' +
      '  id SERIAL PRIMARY KEY,' +
      '  ack_id INTEGER NOT NULL REFERENCES asset_acknowledgments(id) ON DELETE CASCADE,' +
      '  holding_id INTEGER,' +
      '  asset_type_id INTEGER,' +
      '  asset_id INTEGER,' +
      '  label VARCHAR(255) NOT NULL,' +
      '  serial_number VARCHAR(120),' +
      '  asset_tag VARCHAR(40),' +
      '  category VARCHAR(20),' +
      '  qty INTEGER NOT NULL DEFAULT 1,' +
      '  condition VARCHAR(20),' +
      '  unit_cost DECIMAL(10,2),' +
      '  initials VARCHAR(10),' +
      '  initials_image_r2_key VARCHAR(512),' +
      '  initialed_at TIMESTAMPTZ,' +
      '  position INTEGER NOT NULL DEFAULT 0' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_ack_user ON asset_acknowledgments(user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_ack_pending ON asset_acknowledgments(user_id) WHERE status = ' + "'pending'" + ';' +
      'CREATE INDEX IF NOT EXISTS idx_ack_lines ON asset_ack_lines(ack_id);'
    );

    // Replacement / new-item requests. Header plus lines, because one approval
    // cuts one PO and a tech may ask for more than one thing at a time.
    // po_number is snapshotted next to po_id so a deleted PO still reads.
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_requests (' +
      '  id SERIAL PRIMARY KEY,' +
      '  request_number VARCHAR(50) UNIQUE NOT NULL,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  city_code CHAR(3),' +
      '  kind VARCHAR(20) NOT NULL DEFAULT ' + "'replacement'" + ',' +
      '  notes TEXT,' +
      '  status VARCHAR(20) NOT NULL DEFAULT ' + "'pending'" + ',' +
      '  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  decided_at TIMESTAMPTZ,' +
      '  decision_notes TEXT,' +
      '  po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,' +
      '  po_number VARCHAR(50),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_request_lines (' +
      '  id SERIAL PRIMARY KEY,' +
      '  request_id INTEGER NOT NULL REFERENCES asset_requests(id) ON DELETE CASCADE,' +
      '  asset_type_id INTEGER NOT NULL REFERENCES asset_types(id) ON DELETE CASCADE,' +
      '  holding_id INTEGER,' +
      '  qty INTEGER NOT NULL DEFAULT 1,' +
      '  reason VARCHAR(30),' +
      '  notes TEXT,' +
      '  issued_from_stock BOOLEAN NOT NULL DEFAULT false,' +
      '  fulfilled_holding_id INTEGER,' +
      '  position INTEGER NOT NULL DEFAULT 0' +
      ');'
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS asset_request_photos (' +
      '  id SERIAL PRIMARY KEY,' +
      '  request_id INTEGER NOT NULL REFERENCES asset_requests(id) ON DELETE CASCADE,' +
      '  request_line_id INTEGER,' +
      '  r2_key VARCHAR(512) NOT NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_areq_user ON asset_requests(user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_areq_pending ON asset_requests(city_code) WHERE status = ' + "'pending'" + ';' +
      'CREATE INDEX IF NOT EXISTS idx_areq_lines ON asset_request_lines(request_id);' +
      'CREATE INDEX IF NOT EXISTS idx_areq_photos ON asset_request_photos(request_id);'
    );

    // CREATE TABLE IF NOT EXISTS will not add columns to a table that already
    // exists, so any column added after the first deploy goes here.
    await client.query(
      'ALTER TABLE asset_types ADD COLUMN IF NOT EXISTS product_url TEXT;' +
      'ALTER TABLE asset_types ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(255);' +
      'ALTER TABLE asset_holdings ADD COLUMN IF NOT EXISTS unit_cost DECIMAL(10,2);' +
      'ALTER TABLE asset_requests ADD COLUMN IF NOT EXISTS po_number VARCHAR(50);' +
      'ALTER TABLE asset_stock ADD COLUMN IF NOT EXISTS min_qty INTEGER NOT NULL DEFAULT 0;'
    );

    // One-time backfill: grant the new asset permissions to existing saved role
    // configs so nobody loses access when the matrix gains rows. Guarded by a
    // flag so it runs once and never undoes an admin's later choices.
    const _ab = await client.query("SELECT value FROM settings WHERE key = 'perm_assets_matrix_backfilled'");
    if (!_ab.rows.length) {
      const _assetEmployeePerms = ['view_assets', 'request_asset_replacement'];
      const _assetManagerPerms = ['view_assets', 'request_asset_replacement', 'manage_assets', 'approve_asset_replacement'];
      const _arp = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_arp.rows.length && _arp.rows[0].value) {
        try {
          const obj = JSON.parse(_arp.rows[0].value);
          if (obj && typeof obj === 'object') {
            ['locksmith', 'locksmith_coordinator', 'dispatcher', 'roadside_technician'].forEach(function (r) {
              if (Array.isArray(obj[r])) {
                _assetEmployeePerms.forEach(function (p) { if (obj[r].indexOf(p) === -1) obj[r].push(p); });
              }
            });
            if (Array.isArray(obj.manager)) {
              _assetManagerPerms.forEach(function (p) { if (obj.manager.indexOf(p) === -1) obj.manager.push(p); });
            }
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('asset perm matrix backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('perm_assets_matrix_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }

    // ------------------------------------------------------------------
    //  LOCATION TRACKING (tech breadcrumbs for dispatch)
    // ------------------------------------------------------------------
    // tech_locations = ONE row per user, the current position. This is what the
    // live map reads, so it stays tiny and hot.
    // location_pings = the append-only trail, swept by jobs/locationCleanup.js.
    await client.query(
      'CREATE TABLE IF NOT EXISTS tech_locations (' +
      '  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,' +
      '  lat NUMERIC(9,6),' +
      '  lon NUMERIC(9,6),' +
      '  accuracy_m REAL,' +
      '  speed_mps REAL,' +
      '  heading_deg REAL,' +
      '  altitude_m REAL,' +
      '  battery_pct SMALLINT,' +
      '  is_moving BOOLEAN,' +
      '  time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,' +
      '  city_code CHAR(3),' +
      '  source VARCHAR(20),' +
      '  recorded_at TIMESTAMPTZ,' +
      '  received_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS location_pings (' +
      '  id BIGSERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,' +
      '  lat NUMERIC(9,6) NOT NULL,' +
      '  lon NUMERIC(9,6) NOT NULL,' +
      '  accuracy_m REAL,' +
      '  speed_mps REAL,' +
      '  heading_deg REAL,' +
      '  altitude_m REAL,' +
      '  battery_pct SMALLINT,' +
      '  is_moving BOOLEAN,' +
      '  source VARCHAR(20),' +
      '  recorded_at TIMESTAMPTZ NOT NULL,' +
      '  received_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Columns added after the first release go here (CREATE TABLE IF NOT EXISTS
    // will not backfill a table that already exists on Railway).
    await client.query(
      'ALTER TABLE tech_locations ADD COLUMN IF NOT EXISTS altitude_m REAL;' +
      'ALTER TABLE tech_locations ADD COLUMN IF NOT EXISTS battery_pct SMALLINT;' +
      'ALTER TABLE tech_locations ADD COLUMN IF NOT EXISTS is_moving BOOLEAN;' +
      'ALTER TABLE tech_locations ADD COLUMN IF NOT EXISTS time_entry_id INTEGER;' +
      'ALTER TABLE tech_locations ADD COLUMN IF NOT EXISTS city_code CHAR(3);' +
      'ALTER TABLE tech_locations ADD COLUMN IF NOT EXISTS source VARCHAR(20);' +
      'ALTER TABLE location_pings ADD COLUMN IF NOT EXISTS altitude_m REAL;' +
      'ALTER TABLE location_pings ADD COLUMN IF NOT EXISTS battery_pct SMALLINT;' +
      'ALTER TABLE location_pings ADD COLUMN IF NOT EXISTS is_moving BOOLEAN;' +
      'ALTER TABLE location_pings ADD COLUMN IF NOT EXISTS source VARCHAR(20);' +
      'ALTER TABLE location_pings ADD COLUMN IF NOT EXISTS time_entry_id INTEGER;'
    );
    // A phone that never saw the ack for a batch resends it. The unique index
    // turns that retry into a no-op instead of a doubled breadcrumb, so the
    // ingest endpoint can be safely idempotent (ON CONFLICT DO NOTHING).
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS uniq_locping_user_recorded ON location_pings(user_id, recorded_at);' +
      'CREATE INDEX IF NOT EXISTS idx_locping_user_time ON location_pings(user_id, recorded_at DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_locping_recorded ON location_pings(recorded_at);' +
      'CREATE INDEX IF NOT EXISTS idx_locping_entry ON location_pings(time_entry_id);'
    );

    // ------------------------------------------------------------------
    //  DUTY STATUS + DISPATCH
    // ------------------------------------------------------------------
    // Techs do not punch a time clock. "Ready to accept calls" is the switch
    // that gates location storage AND access to the dispatch board.
    await client.query(
      'CREATE TABLE IF NOT EXISTS tech_duty (' +
      '  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,' +
      '  ready BOOLEAN NOT NULL DEFAULT false,' +
      '  ready_since TIMESTAMPTZ,' +
      '  last_changed_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  note TEXT' +
      ');' +
      'CREATE TABLE IF NOT EXISTS tech_duty_log (' +
      '  id BIGSERIAL PRIMARY KEY,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  ready BOOLEAN NOT NULL,' +
      '  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  note TEXT,' +
      '  at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_duty_ready ON tech_duty(ready) WHERE ready = true;' +
      'CREATE INDEX IF NOT EXISTS idx_dutylog_user ON tech_duty_log(user_id, at DESC);'
    );

    // Dispatch jobs. source/source_ref exist from day one so work orders and a
    // future phone-system feed can land on the SAME board without a migration.
    await client.query(
      'CREATE TABLE IF NOT EXISTS dispatch_jobs (' +
      '  id SERIAL PRIMARY KEY,' +
      '  job_number VARCHAR(30) UNIQUE,' +
      "  source VARCHAR(20) NOT NULL DEFAULT 'manual'," +
      '  source_ref VARCHAR(120),' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'new'," +
      "  priority VARCHAR(10) NOT NULL DEFAULT 'normal'," +
      '  service_type VARCHAR(80),' +
      '  customer_name VARCHAR(255),' +
      '  customer_phone VARCHAR(50),' +
      '  address VARCHAR(255),' +
      '  city_state_zip VARCHAR(255),' +
      '  city_code CHAR(3),' +
      '  lat NUMERIC(9,6),' +
      '  lon NUMERIC(9,6),' +
      '  notes TEXT,' +
      '  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  assigned_at TIMESTAMPTZ,' +
      '  accepted_at TIMESTAMPTZ,' +
      '  enroute_at TIMESTAMPTZ,' +
      '  arrived_at TIMESTAMPTZ,' +
      '  completed_at TIMESTAMPTZ,' +
      '  cancel_reason TEXT,' +
      '  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE TABLE IF NOT EXISTS dispatch_job_events (' +
      '  id BIGSERIAL PRIMARY KEY,' +
      '  job_id INTEGER NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,' +
      '  event VARCHAR(30) NOT NULL,' +
      '  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  user_name VARCHAR(255),' +
      '  detail TEXT,' +
      '  lat NUMERIC(9,6),' +
      '  lon NUMERIC(9,6),' +
      '  at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // Who looked at a call, and when. One row per person per job so a board
    // refresh cannot spam the log; first_at is the one that matters in an
    // argument about whether the tech ever saw it.
    await client.query(
      'CREATE TABLE IF NOT EXISTS dispatch_job_views (' +
      '  job_id INTEGER NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  first_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  last_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  views INTEGER NOT NULL DEFAULT 1,' +
      '  PRIMARY KEY (job_id, user_id)' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_djv_job ON dispatch_job_views(job_id);'
    );
    await client.query(
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS source_ref VARCHAR(120);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS goa_at TIMESTAMPTZ;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS goa_note TEXT;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS accept_reminder_at TIMESTAMPTZ;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS unassigned_alert_at TIMESTAMPTZ;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS lon NUMERIC(9,6);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS cancel_reason TEXT;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;' +
      'CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_jobs(status);' +
      'CREATE INDEX IF NOT EXISTS idx_dispatch_assigned ON dispatch_jobs(assigned_to);' +
      'CREATE INDEX IF NOT EXISTS idx_dispatch_city ON dispatch_jobs(city_code);' +
      'CREATE INDEX IF NOT EXISTS idx_dispatch_events ON dispatch_job_events(job_id, at);'
    );

    // NO permission backfill for Dispatch / Live Map, on purpose.
    //
    // Every other module here backfilled its new permissions onto the saved role
    // matrix so nobody lost access on deploy. This one ships DARK: the rows
    // appear in Roles & Access unticked, so on the day this deploys the only
    // people who can see Dispatch or the Live Map are admins and the owner
    // (admin is '*' and cannot be restricted).
    //
    // That is deliberate. Tony asked to pilot this quietly before the crew sees
    // it. To let one specific tech in without opening it to their whole role,
    // use the per-person checkboxes on Edit User, which write users.extra_perms.
    // When it is ready for everyone, tick the boxes in Roles & Access.


    // -----------------------------------------------------------------------
    // DISPATCH PHASE 2A / 2B - the real call record.
    // Spec: Documents\Claude\Projects\Nova\DISPATCH_PHASE2_SPEC.md
    //
    // SHIPS DARK, same as Phase 1: none of the new permissions are backfilled
    // onto the role matrix (see the note above). The ONE table that IS
    // backfilled is user_service_categories, and only because an empty row set
    // there means "sees no calls at all" - it grants nothing by itself, it just
    // makes the later permission grant behave sanely.
    // -----------------------------------------------------------------------
    await client.query(
      'CREATE TABLE IF NOT EXISTS service_categories (' +
      '  code VARCHAR(20) PRIMARY KEY,' +
      '  name VARCHAR(80) NOT NULL,' +
      '  sort INTEGER NOT NULL DEFAULT 0,' +
      '  active BOOLEAN NOT NULL DEFAULT true' +
      ');' +
      'CREATE TABLE IF NOT EXISTS service_types (' +
      '  id SERIAL PRIMARY KEY,' +
      '  code VARCHAR(30) UNIQUE NOT NULL,' +
      '  name VARCHAR(120) NOT NULL,' +
      '  category_code VARCHAR(20) NOT NULL REFERENCES service_categories(code),' +
      '  default_eta_minutes INTEGER,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  sort INTEGER NOT NULL DEFAULT 0' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_service_types_cat ON service_types(category_code);'
    );

    // Seed the four categories. These drive THREE things - who can see a call,
    // which pay row applies, and which price sheet row matches - so a service
    // filed under the wrong one both hides work and pays it wrong. Tony
    // confirms the assignments in the UI; this is only the starting point.
    await client.query(
      "INSERT INTO service_categories (code, name, sort) VALUES " +
      "('roadside','Roadside',1)," +
      "('locksmith','Locksmith - auto',2)," +
      "('residential','Residential',3)," +
      "('commercial','Commercial',4) " +
      "ON CONFLICT (code) DO NOTHING"
    );

    // Seed the service catalog from the Pulsar service list. Grouped to match
    // how the Payroll Pro table already bundles them: the "Core" bundle
    // (CDU / Gas / Jumpstart / Trunk) is roadside work, Lock Pick and the
    // Locksmith services are not.
    await client.query(
      "INSERT INTO service_types (code, name, category_code, default_eta_minutes, sort) VALUES " +
      "('CDU','Car Door Unlocking','roadside',25,1)," +
      "('GAS','Gas Delivery','roadside',30,2)," +
      "('JS','Jumpstart','roadside',25,3)," +
      "('TRUNK','Trunk Opening','roadside',30,4)," +
      "('TIRE','Tire Change','roadside',30,5)," +
      "('AIR','Air Service','roadside',30,6)," +
      "('BATT','Battery Assist','roadside',25,7)," +
      "('MSG','Message','roadside',30,8)," +
      "('PICK','Lock Pick','locksmith',35,9)," +
      "('AUTOLS','Auto Locksmith','locksmith',45,10)," +
      "('BUSLS','Bus Locksmith','locksmith',45,11)," +
      "('RESLS','Res Locksmith','residential',45,12)," +
      "('COMLS','Com Locksmith','commercial',45,13) " +
      "ON CONFLICT (code) DO NOTHING"
    );

    // Call tags
    await client.query(
      'CREATE TABLE IF NOT EXISTS dispatch_tags (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(60) UNIQUE NOT NULL,' +
      "  color VARCHAR(7) NOT NULL DEFAULT '#f97316'," +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  sort INTEGER NOT NULL DEFAULT 0' +
      ');' +
      'CREATE TABLE IF NOT EXISTS dispatch_job_tags (' +
      '  job_id INTEGER NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,' +
      '  tag_id INTEGER NOT NULL REFERENCES dispatch_tags(id) ON DELETE CASCADE,' +
      '  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  added_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  PRIMARY KEY (job_id, tag_id)' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_djt_tag ON dispatch_job_tags(tag_id);'
    );
    await client.query(
      "INSERT INTO dispatch_tags (name, color, sort) VALUES " +
      "('Callback','#f97316',1)," +
      "('Repeat customer','#3b82f6',2)," +
      "('Prepaid','#22c55e',3)," +
      "('Insurance','#a855f7',4)," +
      "('Gate code','#eab308',5)," +
      "('Second trip','#f97316',6)," +
      "('Escalated','#ef4444',7)," +
      "('Out of area','#ef4444',8)," +
      "('Do not dispatch','#ef4444',9) " +
      "ON CONFLICT (name) DO NOTHING"
    );

    // The call record itself. Every one of these mirrors a column name that
    // already exists on invoices, so push-to-invoice stays a straight copy
    // rather than a translation layer. service_type (text) deliberately STAYS
    // alongside service_type_id - the text is the historical snapshot, and
    // renaming a service type must not rewrite last year's calls.
    await client.query(
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS service_type_id INTEGER REFERENCES service_types(id);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS account_name VARCHAR(255);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS account_po VARCHAR(255);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS business_name VARCHAR(255);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS callback_phone VARCHAR(50);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS caller_id VARCHAR(50);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS cross_street VARCHAR(255);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS zip VARCHAR(12);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS vehicle_year VARCHAR(8);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS vehicle_make VARCHAR(100);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR(100);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS vehicle_color VARCHAR(40);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS license_tag VARCHAR(40);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS tag_state VARCHAR(4);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS vin VARCHAR(20);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS vehicle_location VARCHAR(255);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS is_edu BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS eta_minutes INTEGER;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS eta_source VARCHAR(12);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS eta_promised_at TIMESTAMPTZ;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS quoted_price NUMERIC(10,2);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS quoted_price_src VARCHAR(16);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS status_since TIMESTAMPTZ;' +
      'CREATE INDEX IF NOT EXISTS idx_dispatch_stype ON dispatch_jobs(service_type_id);' +
      'CREATE INDEX IF NOT EXISTS idx_dispatch_account ON dispatch_jobs(account_id);' +
      'CREATE INDEX IF NOT EXISTS idx_dispatch_created ON dispatch_jobs(created_at);'
    );
    // status_since powers the board's "0:07 in status" line. Backfill it from
    // whatever timestamp the current status was actually set by, so existing
    // rows do not all read as if they changed status just now.
    await client.query(
      'UPDATE dispatch_jobs SET status_since = COALESCE(' +
      '  CASE status' +
      "    WHEN 'done' THEN completed_at" +
      "    WHEN 'goa' THEN goa_at" +
      "    WHEN 'onscene' THEN arrived_at" +
      "    WHEN 'enroute' THEN enroute_at" +
      "    WHEN 'accepted' THEN accepted_at" +
      "    WHEN 'assigned' THEN assigned_at" +
      '    ELSE created_at' +
      '  END, created_at, NOW()) WHERE status_since IS NULL'
    );

    // Account requirements live on the ACCOUNT, never on the call - a client
    // that posts po_required is ignored, same rule Invoice Setup already
    // enforces for signature_required.
    await client.query(
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS po_required BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vehicle_required BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS dispatch_notes TEXT;'
    );

    // Who can see / be assigned which kind of work. TWO flags, not one: a
    // coordinator may need to SEE roadside calls to run the board without ever
    // being assigned one.
    await client.query(
      'CREATE TABLE IF NOT EXISTS user_service_categories (' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  category_code VARCHAR(20) NOT NULL REFERENCES service_categories(code) ON DELETE CASCADE,' +
      '  can_view BOOLEAN NOT NULL DEFAULT true,' +
      '  can_be_assigned BOOLEAN NOT NULL DEFAULT true,' +
      '  PRIMARY KEY (user_id, category_code)' +
      ');'
    );

    // ONE-TIME backfill. This table fails CLOSED - no rows means the person
    // sees no calls at all - so every existing active user needs a starting
    // row set before Dispatch is switched on for anyone. It grants no access
    // on its own; view_dispatch is still unticked for every role.
    const _uscBf = await client.query("SELECT value FROM settings WHERE key = 'user_service_categories_backfilled'");
    if (!_uscBf.rows.length) {
      const _uscRows = await client.query(
        'INSERT INTO user_service_categories (user_id, category_code, can_view, can_be_assigned) ' +
        'SELECT u.id, c.code,' +
        '  CASE WHEN u.role = $1 AND c.code <> $2 THEN false ELSE true END,' +
        '  CASE' +
        '    WHEN u.role IN ($3, $4, $5, $6) THEN false' +
        "    WHEN u.role = $1 AND c.code <> $2 THEN false" +
        '    WHEN u.role = $7 AND c.code = $2 THEN false' +
        '    ELSE true' +
        '  END ' +
        'FROM users u CROSS JOIN service_categories c ' +
        'WHERE COALESCE(u.active, true) = true ' +
        'ON CONFLICT (user_id, category_code) DO NOTHING',
        ['roadside_technician', 'roadside', 'dispatcher', 'manager', 'admin', 'owner',
         'locksmith_coordinator']
      );
      await client.query("INSERT INTO settings (key, value) VALUES ('user_service_categories_backfilled', '1') ON CONFLICT (key) DO NOTHING");
      console.log('Dispatch: seeded ' + (_uscRows.rowCount || 0) + ' user/service-category rows (roadside techs = roadside only, locksmiths = everything, office roles = view but do not take calls).');
    }

    // Saved column choice per person per grid. The board and Call Search share
    // this - and the EXPORT reads the same list, so nobody widens their own
    // view by exporting it.
    await client.query(
      'CREATE TABLE IF NOT EXISTS user_grid_prefs (' +
      '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      '  grid VARCHAR(40) NOT NULL,' +
      '  columns TEXT[] NOT NULL,' +
      '  PRIMARY KEY (user_id, grid)' +
      ');'
    );

    // Match the free-text service_type on existing calls to the new catalog.
    // Deliberately conservative: an exact case-insensitive name or code match
    // only. Anything else stays NULL and shows an amber "Needs service type"
    // chip, because a wrong category hides the call from the people who should
    // see it AND pays it off the wrong table. Guessing is worse than blank.
    const _stBf = await client.query("SELECT value FROM settings WHERE key = 'dispatch_service_type_backfilled'");
    if (!_stBf.rows.length) {
      const _matched = await client.query(
        'UPDATE dispatch_jobs j SET service_type_id = st.id ' +
        'FROM service_types st ' +
        'WHERE j.service_type_id IS NULL ' +
        '  AND j.service_type IS NOT NULL ' +
        '  AND (LOWER(TRIM(j.service_type)) = LOWER(st.name) OR LOWER(TRIM(j.service_type)) = LOWER(st.code))'
      );
      const _left = await client.query('SELECT COUNT(*)::int AS n FROM dispatch_jobs WHERE service_type_id IS NULL');
      await client.query("INSERT INTO settings (key, value) VALUES ('dispatch_service_type_backfilled', '1') ON CONFLICT (key) DO NOTHING");
      console.log('Dispatch: matched ' + (_matched.rowCount || 0) + ' call(s) to the service catalog; ' + ((_left.rows[0] && _left.rows[0].n) || 0) + ' still need a service type set by hand.');
    }


    // -----------------------------------------------------------------------
    // DISPATCH PHASE 2D - TIME CODES.
    // Each service, at each location, is carved into named windows of the week
    // that carry their own price and their own three ETAs. This is what "price
    // out the services" actually is; the account price sheet below is only the
    // exception layer on top.
    // -----------------------------------------------------------------------

    // A time code resolves in the CITY'S OWN clock. Birmingham is an hour
    // behind Orlando, and a call created at 11:58 PM has to land in Overnight
    // rather than tomorrow's Morning. Defaulting to New York keeps every
    // existing city right; Tony sets the Central ones by hand.
    await client.query(
      "ALTER TABLE cities ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'America/New_York';"
    );

    await client.query(
      'CREATE TABLE IF NOT EXISTS location_services (' +
      '  id SERIAL PRIMARY KEY,' +
      '  city_code CHAR(3) NOT NULL,' +
      '  service_type_id INTEGER NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  sort INTEGER NOT NULL DEFAULT 0,' +
      '  UNIQUE (city_code, service_type_id)' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_locsvc_city ON location_services(city_code);'
    );

    await client.query(
      'CREATE TABLE IF NOT EXISTS service_time_codes (' +
      '  id SERIAL PRIMARY KEY,' +
      '  location_service_id INTEGER NOT NULL REFERENCES location_services(id) ON DELETE CASCADE,' +
      '  code_id SMALLINT NOT NULL,' +
      '  title VARCHAR(60) NOT NULL,' +
      '  start_minute SMALLINT NOT NULL,' +
      '  end_minute SMALLINT NOT NULL,' +
      '  days SMALLINT NOT NULL DEFAULT 127,' +
      '  full_charge NUMERIC(10,2),' +
      '  additional_charge NUMERIC(10,2) NOT NULL DEFAULT 0,' +
      '  eta_core_low SMALLINT,' +
      '  eta_core_high SMALLINT,' +
      '  eta_account SMALLINT,' +
      '  eta_edu SMALLINT,' +
      '  schedule_slots SMALLINT NOT NULL DEFAULT 0,' +
      '  shutdown_message TEXT,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  UNIQUE (location_service_id, code_id)' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_stc_locsvc ON service_time_codes(location_service_id);'
    );

    // Accounts that do not pay the retail time-code price. An account with NO
    // row here simply pays the time code, which is exactly what "Retail" means,
    // so there is no separate retail table to keep in step.
    await client.query(
      'CREATE TABLE IF NOT EXISTS account_service_prices (' +
      '  id SERIAL PRIMARY KEY,' +
      '  account_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,' +
      '  service_type_id INTEGER NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,' +
      '  city_code CHAR(3),' +
      '  code_id SMALLINT,' +
      '  full_charge NUMERIC(10,2) NOT NULL,' +
      '  additional_charge NUMERIC(10,2) NOT NULL DEFAULT 0,' +
      '  eta_minutes SMALLINT,' +
      '  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,' +
      '  effective_to DATE,' +
      '  active BOOLEAN NOT NULL DEFAULT true' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_asp_lookup ON account_service_prices(account_id, service_type_id);'
    );

    await client.query(
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS time_code_id INTEGER REFERENCES service_time_codes(id) ON DELETE SET NULL;'
    );

    // Seed: every active city offers every active service, with the five
    // standard windows. The WINDOWS and the ETAs are seeded because their shape
    // is the same everywhere; the PRICES are left NULL on purpose - a seeded
    // price would be a wrong price quoted to a real customer, and NULL renders
    // as an amber "Price not set" that warns at close-out instead.
    const _tcSeed = await client.query("SELECT value FROM settings WHERE key = 'dispatch_time_codes_seeded'");
    if (!_tcSeed.rows.length) {
      await client.query(
        'INSERT INTO location_services (city_code, service_type_id, sort) ' +
        'SELECT TRIM(c.code), st.id, st.sort FROM cities c CROSS JOIN service_types st ' +
        'WHERE c.active = true AND st.active = true ' +
        'ON CONFLICT (city_code, service_type_id) DO NOTHING'
      );
      const _windows = [
        [1, 'Daytime', 8 * 60, 16 * 60 + 59, 25, 45, 40, 20],
        [2, 'Evening', 17 * 60, 21 * 60 + 29, 30, 50, 45, 20],
        [5, 'Late night', 21 * 60 + 30, 21 * 60 + 59, 35, 55, 50, 20],
        [3, 'Overnight', 22 * 60, 5 * 60 + 59, 35, 60, 50, 20],
        [4, 'Morning', 6 * 60, 7 * 60 + 59, 30, 50, 45, 20]
      ];
      for (var _w = 0; _w < _windows.length; _w++) {
        const _x = _windows[_w];
        await client.query(
          'INSERT INTO service_time_codes (location_service_id, code_id, title, start_minute, end_minute, ' +
          ' days, eta_core_low, eta_core_high, eta_account, eta_edu) ' +
          'SELECT ls.id, $1, $2, $3, $4, 127, $5, $6, $7, $8 FROM location_services ls ' +
          'ON CONFLICT (location_service_id, code_id) DO NOTHING',
          [_x[0], _x[1], _x[2], _x[3], _x[4], _x[5], _x[6], _x[7]]
        );
      }
      const _n = await client.query('SELECT COUNT(*)::int AS n FROM service_time_codes');
      await client.query("INSERT INTO settings (key, value) VALUES ('dispatch_time_codes_seeded', '1') ON CONFLICT (key) DO NOTHING");
      console.log('Dispatch: seeded ' + ((_n.rows[0] && _n.rows[0].n) || 0) + ' time-code windows across every city and service. PRICES ARE BLANK on purpose - set them under Location Settings before quoting.');
    }

    // EDU is a free public service: a child or a pet locked in a vehicle. The
    // tech is still paid for it from their own pay table, which is why the pay
    // engine must never derive pay from price.
    await client.query(
      "INSERT INTO settings (key, value) VALUES ('dispatch_edu_free', '1') ON CONFLICT (key) DO NOTHING"
    );


    // -----------------------------------------------------------------------
    // DISPATCH PHASE 2C - COVERAGE ZONES, and the geocode cache.
    // Zones are matched by ZIP first and by drawn shape second. Zip is exact
    // and free; a shape needs a geocode that can fail, and a bad geocode moving
    // a call into the wrong market means the wrong pay rule and the wrong
    // royalty bucket.
    // -----------------------------------------------------------------------
    await client.query(
      'CREATE TABLE IF NOT EXISTS coverage_zones (' +
      '  id SERIAL PRIMARY KEY,' +
      '  city_code CHAR(3) NOT NULL,' +
      '  name VARCHAR(120) NOT NULL,' +
      "  kind VARCHAR(10) NOT NULL DEFAULT 'zip'," +   // 'zip' | 'polygon'
      '  polygon JSONB,' +
      '  eta_adjust_minutes INTEGER NOT NULL DEFAULT 0,' +
      '  price_adjust_type VARCHAR(10),' +             // NULL | 'flat' | 'percent'
      '  price_adjust_value NUMERIC(10,2),' +
      '  is_primary BOOLEAN NOT NULL DEFAULT true,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      '  sort INTEGER NOT NULL DEFAULT 0' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_zone_city ON coverage_zones(city_code);' +
      'CREATE TABLE IF NOT EXISTS coverage_zone_zips (' +
      '  zone_id INTEGER NOT NULL REFERENCES coverage_zones(id) ON DELETE CASCADE,' +
      '  zip VARCHAR(10) NOT NULL,' +
      '  PRIMARY KEY (zone_id, zip)' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_zone_zip ON coverage_zone_zips(zip);'
    );
    // Tony: "there is no overlap really." A zip therefore belongs to exactly ONE
    // ACTIVE zone, and that is what makes a zone match unique - which in turn is
    // the only reason the ETA and price overrides can be applied without a
    // tiebreak rule nobody would remember.
    //
    // The guard is in routes/coverage.js, not here: Postgres will not accept a
    // subquery inside an index predicate, and "unique across ACTIVE zones only"
    // needs one. A plain unique index would also block moving a zip out of a
    // zone you had just switched off, which is a normal thing to want to do.

    await client.query(
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS zone_id INTEGER REFERENCES coverage_zones(id) ON DELETE SET NULL;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS zone_price_adj NUMERIC(10,2);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS geocode_accuracy VARCHAR(30);'
    );

    // The geocode cache. The same address is never paid for twice, and the
    // provider's licence decides how long a row may live - Geocodio permits
    // keeping coordinates, Google allows 30 days and then requires deletion.
    // The TTL lives in utils/geocode.js so nobody has to remember it.
    await client.query(
      'CREATE TABLE IF NOT EXISTS geocode_cache (' +
      '  address_key TEXT NOT NULL,' +
      '  provider VARCHAR(20) NOT NULL,' +
      '  formatted TEXT,' +
      '  lat NUMERIC(9,6),' +
      '  lon NUMERIC(9,6),' +
      '  accuracy NUMERIC(4,2),' +
      '  accuracy_type VARCHAR(30),' +
      '  hits INTEGER NOT NULL DEFAULT 1,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  PRIMARY KEY (address_key, provider)' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_geocache_age ON geocode_cache(provider, created_at);'
    );


    // -----------------------------------------------------------------------
    // DISPATCH PHASE 2E - TECH PAY.
    // A pay table is rows of: title, amount, labor type, call source, time
    // codes, services - the shape of the Payroll Pro screen. A GRADE is simply
    // a saved table. Same grade names company-wide, a separate set of rows per
    // city, so a transfer keeps their grade instead of needing a new one.
    // -----------------------------------------------------------------------
    await client.query(
      'CREATE TABLE IF NOT EXISTS pay_grades (' +
      '  id SERIAL PRIMARY KEY,' +
      '  name VARCHAR(80) NOT NULL,' +
      '  sort INTEGER NOT NULL DEFAULT 0,' +
      '  active BOOLEAN NOT NULL DEFAULT true' +
      ');'
    );

    await client.query(
      'CREATE TABLE IF NOT EXISTS pay_rows (' +
      '  id SERIAL PRIMARY KEY,' +
      '  grade_id INTEGER REFERENCES pay_grades(id) ON DELETE CASCADE,' +
      '  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,' +
      '  city_code CHAR(3) NOT NULL,' +
      '  title VARCHAR(80) NOT NULL,' +
      '  labor_type VARCHAR(24) NOT NULL,' +
      '  amount NUMERIC(10,2) NOT NULL,' +
      '  applies_public BOOLEAN NOT NULL DEFAULT true,' +
      '  applies_accounts BOOLEAN NOT NULL DEFAULT true,' +
      '  account_id INTEGER REFERENCES vendors(id) ON DELETE CASCADE,' +
      '  code_ids SMALLINT[],' +
      '  service_type_ids INTEGER[],' +
      '  edu_only BOOLEAN NOT NULL DEFAULT false,' +
      '  note TEXT,' +
      '  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,' +
      '  effective_to DATE,' +
      '  active BOOLEAN NOT NULL DEFAULT true,' +
      // Exactly one of the two: a row belongs to a grade OR to one person as an
      // override. A row that is both would be applied twice; a row that is
      // neither would never be found.
      '  CONSTRAINT pay_rows_owner CHECK ((grade_id IS NULL) <> (user_id IS NULL))' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_payrows_grade ON pay_rows(grade_id, city_code);' +
      'CREATE INDEX IF NOT EXISTS idx_payrows_user ON pay_rows(user_id, city_code);'
    );

    await client.query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_grade_id INTEGER REFERENCES pay_grades(id) ON DELETE SET NULL;' +
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_arrangement VARCHAR(20) NOT NULL DEFAULT 'none';" +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_split_pct NUMERIC(5,2) NOT NULL DEFAULT 0;'
    );

    // The pay snapshot. Computed ONCE, when the call reaches done or goa, and
    // stored with the TITLE of the row that produced it - so a grade edit next
    // month cannot restate last month's payroll, and a tech querying their
    // cheque gets an answer instead of an argument.
    await client.query(
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_row_id INTEGER REFERENCES pay_rows(id) ON DELETE SET NULL;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_row_title VARCHAR(80);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_labor_type VARCHAR(24);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_basis_amount NUMERIC(10,2);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_total NUMERIC(10,2);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_job_amount NUMERIC(10,2);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_vehicle_amount NUMERIC(10,2);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_split_pct NUMERIC(5,2);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_tip_amount NUMERIC(10,2);' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_locked_at TIMESTAMPTZ;' +
      'ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pay_note TEXT;' +
      'CREATE INDEX IF NOT EXISTS idx_dispatch_pay ON dispatch_jobs(assigned_to, pay_locked_at);'
    );

    // Three grades to start from, empty. Deliberately no seeded RATES: a seeded
    // rate is a wrong number on somebody's paycheck, and unlike a wrong price it
    // is not something a customer will query for you.
    const _pgSeed = await client.query("SELECT value FROM settings WHERE key = 'pay_grades_seeded'");
    if (!_pgSeed.rows.length) {
      await client.query(
        "INSERT INTO pay_grades (name, sort) VALUES " +
        "('Grade 1 - Apprentice',1),('Grade 2 - Technician',2),('Grade 3 - Senior',3)"
      );
      await client.query("INSERT INTO settings (key, value) VALUES ('pay_grades_seeded', '1') ON CONFLICT (key) DO NOTHING");
      console.log('Dispatch: created three empty pay grades. No rates are seeded on purpose - set them under Personnel before any call is closed out.');
    }


    // -----------------------------------------------------------------------
    // DISPATCH PHASE 2F - ACCOUNTS RECEIVABLE.
    // Independent of the board. Everything it needs already sits on invoices;
    // the account itself stays defined in ONE place - the Accounts tab - for
    // dispatch, invoicing and A/R alike.
    // -----------------------------------------------------------------------
    await client.query(
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS ar_enabled BOOLEAN NOT NULL DEFAULT false;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS net_days INTEGER NOT NULL DEFAULT 30;' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(12,2);' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS ar_contact_name VARCHAR(255);' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS ar_contact_email VARCHAR(255);' +
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS ar_statement_day INTEGER;' +
      // The column mapping for this account's remittance file, learned once and
      // reused. Without it somebody re-maps the same six columns every month and
      // eventually maps one of them wrong.
      'ALTER TABLE vendors ADD COLUMN IF NOT EXISTS ar_import_map JSONB;'
    );

    // Batches first: a payment can point at the batch it arrived in, so the
    // table has to exist before the foreign key does.
    await client.query(
      'CREATE TABLE IF NOT EXISTS ar_import_batches (' +
      '  id SERIAL PRIMARY KEY,' +
      '  account_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,' +
      '  filename VARCHAR(255) NOT NULL,' +
      // The hash, not the name. Files get renamed; the money inside does not.
      '  file_hash CHAR(64) NOT NULL,' +
      '  line_count INTEGER NOT NULL DEFAULT 0,' +
      '  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,' +
      "  status VARCHAR(20) NOT NULL DEFAULT 'staged'," +
      '  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  uploaded_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  posted_at TIMESTAMPTZ,' +
      '  posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  note TEXT' +
      ');' +
      // Posting the same remittance twice is the single most common way A/R
      // imports go wrong, and it is silent: the account simply reads as paid
      // ahead until somebody reconciles three months later.
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_ar_batch_file ON ar_import_batches(account_id, file_hash);'
    );

    await client.query(
      'CREATE TABLE IF NOT EXISTS ar_payments (' +
      '  id SERIAL PRIMARY KEY,' +
      '  account_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,' +
      '  received_on DATE NOT NULL DEFAULT CURRENT_DATE,' +
      '  amount NUMERIC(12,2) NOT NULL,' +
      '  method VARCHAR(20),' +
      '  reference VARCHAR(120),' +
      '  import_batch_id INTEGER REFERENCES ar_import_batches(id) ON DELETE SET NULL,' +
      '  notes TEXT,' +
      '  voided_at TIMESTAMPTZ,' +
      '  void_reason TEXT,' +
      '  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_ar_pay_acct ON ar_payments(account_id, received_on);' +
      'CREATE TABLE IF NOT EXISTS ar_payment_lines (' +
      '  payment_id INTEGER NOT NULL REFERENCES ar_payments(id) ON DELETE CASCADE,' +
      '  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,' +
      '  amount NUMERIC(12,2) NOT NULL,' +
      '  PRIMARY KEY (payment_id, invoice_id)' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_ar_payline_inv ON ar_payment_lines(invoice_id);'
    );

    await client.query(
      'CREATE TABLE IF NOT EXISTS ar_adjustments (' +
      '  id SERIAL PRIMARY KEY,' +
      '  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,' +
      '  kind VARCHAR(20) NOT NULL,' +
      '  amount NUMERIC(12,2) NOT NULL,' +
      // NOT NULL on purpose. A write-off with no stated reason is the line item
      // an auditor asks about and nobody can answer.
      '  reason TEXT NOT NULL,' +
      '  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_ar_adj_inv ON ar_adjustments(invoice_id);'
    );

    await client.query(
      'CREATE TABLE IF NOT EXISTS ar_import_lines (' +
      '  id SERIAL PRIMARY KEY,' +
      '  batch_id INTEGER NOT NULL REFERENCES ar_import_batches(id) ON DELETE CASCADE,' +
      '  line_no INTEGER NOT NULL DEFAULT 0,' +
      '  raw JSONB NOT NULL,' +
      '  invoice_number VARCHAR(60),' +
      '  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,' +
      '  amount NUMERIC(12,2) NOT NULL DEFAULT 0,' +
      // matched | review | unmatched | resolved. A line that did not match
      // cleanly can never be auto-applied - an importer that guesses is worse
      // than no importer.
      "  match_state VARCHAR(10) NOT NULL DEFAULT 'unmatched'," +
      '  match_note TEXT' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_ar_lines_batch ON ar_import_lines(batch_id);'
    );

    // Balance is DERIVED, never stored. This view is the one definition of it,
    // so the ledger, the aging report and the credit-limit warning can never
    // disagree about what an account owes.
    await client.query(
      'CREATE OR REPLACE VIEW ar_invoice_balances AS ' +
      'SELECT i.id AS invoice_id, i.invoice_number, i.account_id, i.account_name, ' +
      '       i.invoice_date, i.status, TRIM(i.city_code) AS city_code, ' +
      '       COALESCE(i.grand_total,0) AS total, ' +
      '       COALESCE(i.refunded_total,0) AS refunded, ' +
      '       COALESCE(p.applied,0) AS applied, ' +
      '       COALESCE(a.adjusted,0) AS adjusted, ' +
      '       ROUND(COALESCE(i.grand_total,0) - COALESCE(i.refunded_total,0) ' +
      '             - COALESCE(p.applied,0) - COALESCE(a.adjusted,0), 2) AS balance, ' +
      '       (i.invoice_date + (COALESCE(v.net_days,30) || \' days\')::interval)::date AS due_on ' +
      'FROM invoices i ' +
      'LEFT JOIN vendors v ON v.id = i.account_id ' +
      'LEFT JOIN (SELECT l.invoice_id, SUM(l.amount) AS applied FROM ar_payment_lines l ' +
      '           JOIN ar_payments pm ON pm.id = l.payment_id AND pm.voided_at IS NULL ' +
      '           GROUP BY l.invoice_id) p ON p.invoice_id = i.id ' +
      'LEFT JOIN (SELECT invoice_id, SUM(amount) AS adjusted FROM ar_adjustments GROUP BY invoice_id) a ' +
      '  ON a.invoice_id = i.id ' +
      "WHERE i.account_id IS NOT NULL AND i.status <> 'draft'"
    );

    console.log('A/R: tables ready. No account is A/R-enabled until somebody ticks it on the Accounts tab.');

    // -----------------------------------------------------------------------
    //  Accounts Payable
    // -----------------------------------------------------------------------
    // Bills WE owe. Unlike A/R, the balance here is NOT derived from other
    // tables - a bill is entered, tracked to a due date, and marked paid, so
    // its status lives on the row. Everything below ships dark behind view_ap /
    // manage_ap (see utils/permissions.js): the tables are created on every
    // boot, but no role can reach them until an admin ticks the box.
    //
    // These are brand-new tables, so a single CREATE ... IF NOT EXISTS with all
    // columns is correct. If you add a column LATER, it must come with its own
    // ALTER TABLE ... ADD COLUMN IF NOT EXISTS (see the note at the top of this
    // file): CREATE IF NOT EXISTS will not touch a table that already exists.
    await client.query(
      'CREATE TABLE IF NOT EXISTS ap_bills (' +
      '  id SERIAL PRIMARY KEY,' +
      '  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,' +
      '  payee VARCHAR(255),' +
      '  bill_number VARCHAR(120),' +
      '  category VARCHAR(40),' +
      '  description TEXT,' +
      '  amount NUMERIC(12,2) NOT NULL DEFAULT 0,' +
      '  bill_date DATE,' +
      '  due_date DATE,' +
      "  status VARCHAR(16) NOT NULL DEFAULT 'unpaid'," +
      '  paid_on DATE,' +
      '  paid_amount NUMERIC(12,2),' +
      '  paid_method VARCHAR(20),' +
      '  paid_reference VARCHAR(120),' +
      '  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  recurring BOOLEAN NOT NULL DEFAULT false,' +
      '  recurrence VARCHAR(10),' +
      '  recurrence_day INTEGER,' +
      '  series_id INTEGER,' +
      '  spawned_next BOOLEAN NOT NULL DEFAULT false,' +
      '  reminder_task_id INTEGER,' +
      '  reminded_on DATE,' +
      "  source VARCHAR(16) NOT NULL DEFAULT 'manual'," +
      '  source_ref VARCHAR(255),' +
      '  raw_email TEXT,' +
      '  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    // status+due drives both the bills list and the reminder job; the other two
    // cover the vendor filter and walking a recurring chain.
    await client.query('CREATE INDEX IF NOT EXISTS idx_ap_bills_status_due ON ap_bills(status, due_date);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ap_bills_vendor ON ap_bills(vendor_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ap_bills_series ON ap_bills(series_id);');

    // Copies of the actual bill (PDF/photo), stored in R2 exactly like every
    // other upload - bytes go browser<->R2 via presigned URLs, never through us.
    await client.query(
      'CREATE TABLE IF NOT EXISTS ap_bill_attachments (' +
      '  id SERIAL PRIMARY KEY,' +
      '  bill_id INTEGER REFERENCES ap_bills(id) ON DELETE CASCADE,' +
      '  r2_key VARCHAR(500) NOT NULL,' +
      '  filename VARCHAR(255),' +
      '  content_type VARCHAR(120),' +
      '  size_bytes BIGINT,' +
      '  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_ap_attach_bill ON ap_bill_attachments(bill_id);');

    console.log('A/P: tables ready. Bills are off until an admin grants view_ap / manage_ap.');


    // -----------------------------------------------------------------------
    // Inbound sync receiver (generic webhooks) - see utils/webhookIngest.js
    // -----------------------------------------------------------------------
    // One row per partner that POSTs JSON at Nova. The shared secret is stored
    // as a SHA-256 hash and never in plaintext: it is generated, shown to the
    // admin exactly once, and after that only the hash and the last 4
    // characters (so you can tell which token is live) exist anywhere.
    await client.query(
      'CREATE TABLE IF NOT EXISTS webhook_sources (' +
      '  id SERIAL PRIMARY KEY,' +
      '  slug VARCHAR(64) UNIQUE NOT NULL,' +
      '  name VARCHAR(160) NOT NULL,' +
      '  secret_hash VARCHAR(128) NOT NULL,' +
      '  secret_hint VARCHAR(16),' +
      '  handler VARCHAR(64),' +
      '  enabled BOOLEAN NOT NULL DEFAULT true,' +
      '  dedupe_path VARCHAR(200),' +
      '  event_type_path VARCHAR(200),' +
      '  last_event_at TIMESTAMPTZ,' +
      '  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  updated_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );

    // Every delivery, stored verbatim BEFORE anything interprets it.
    //
    // raw_body is kept alongside the parsed payload on purpose. The parsed JSON
    // is what handlers read, but when a partner swears they sent a field and we
    // do not have it, the only thing that settles the argument is the exact
    // bytes that arrived.
    //
    // status:  pending    stored, waiting to be processed
    //          processing claimed by a worker
    //          done       handler succeeded
    //          skipped    handler understood it and deliberately ignored it
    //          parked     no handler registered yet - replay once one exists
    //          failed     handler threw; retried on a backoff, then dead-lettered
    await client.query(
      'CREATE TABLE IF NOT EXISTS webhook_events (' +
      '  id BIGSERIAL PRIMARY KEY,' +
      '  source_slug VARCHAR(64) NOT NULL,' +
      '  event_type VARCHAR(120),' +
      '  external_id VARCHAR(200),' +
      '  body_hash CHAR(64) NOT NULL,' +
      '  payload JSONB,' +
      '  raw_body TEXT,' +
      '  headers JSONB,' +
      '  ip VARCHAR(64),' +
      "  status VARCHAR(16) NOT NULL DEFAULT 'pending'," +
      '  attempts INTEGER NOT NULL DEFAULT 0,' +
      '  last_error TEXT,' +
      '  next_attempt_at TIMESTAMPTZ,' +
      '  received_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  processed_at TIMESTAMPTZ' +
      ');'
    );

    // NOTE: the unique dedupe index used to be created HERE, on
    // (source_slug, external_id). It moved further down, onto dedupe_key.
    //
    // It must not be recreated here, and this comment exists so nobody puts it
    // back. external_id is now the PARTNER's id - recorded on every row and
    // deliberately allowed to repeat, because duplicate checking can be turned
    // off, and because a sentinel like "0" is a perfectly normal value for a
    // partner to send on thousands of records.
    //
    // Leaving the old CREATE in place cost a production outage: the migration
    // below drops that index, so on the NEXT boot this line tried to recreate it
    // over data that legitimately had repeats, threw 23505, and aborted initDB -
    // taking every table defined after this point down with it. A failed
    // migration that stops halfway is worse than one that never ran.
    // The retry sweep's query, once a minute, forever. Partial so it stays
    // small: on a healthy system almost every row is 'done' and not in here.
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_webhook_events_queue ' +
      "ON webhook_events(next_attempt_at) WHERE status IN ('pending','failed');"
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_webhook_events_source ON webhook_events(source_slug, id DESC);'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);'
    );

    // Which event types this source actually wants. Empty/NULL = everything.
    // Added as an ALTER so an existing deploy picks it up without a rebuild.
    await client.query('ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS accept_types TEXT;');

    // Per-source auth shape. Partners choose their own header spellings and
    // will not change them for us, so every one of these is configuration
    // rather than a code branch. Pulsar sends the token in a header literally
    // named 'auth', plus an HMAC in 'Pulsar-Signature'.
    //
    // hmac_secret_enc is ENCRYPTED, not hashed. A bearer token can be stored
    // one-way because verifying means hashing what arrived; an HMAC key must be
    // recoverable to recompute the signature. See the secret box in
    // utils/webhookIngest.js.
    //
    // hmac_mode: off | observe | require
    //   observe computes the signature, records the verdict on every event and
    //   logs what WOULD have been rejected, while still accepting the data.
    //   That is the same two-stage rollout server.js uses for CORS_STRICT, and
    //   it is how you discover a partner's exact formulation from their own
    //   traffic instead of from a sentence in a chat window.
    await client.query(
      "ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS secret_header VARCHAR(64);" +
      "ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS hmac_mode VARCHAR(12) NOT NULL DEFAULT 'off';" +
      'ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS hmac_header VARCHAR(64);' +
      'ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS hmac_ts_header VARCHAR(64);' +
      'ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS hmac_secret_enc TEXT;' +
      'ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS hmac_format VARCHAR(40);' +
      'ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS hmac_max_skew_s INTEGER NOT NULL DEFAULT 300;'
    );

    // What the signature check concluded for the request this event came from:
    // 'ok:body', 'mismatch', 'missing', 'stale', 'no_key', or NULL when the
    // source does not sign. In observe mode this column IS the report - it is
    // how you confirm a formulation is matching consistently before enforcing.
    await client.query('ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS sig_state VARCHAR(40);');

    await client.query('ALTER TABLE webhook_event_stats ADD COLUMN IF NOT EXISTS duplicate_count BIGINT NOT NULL DEFAULT 0;');

    // Deliveries that were turned away and left no event behind.
    //
    // Without this, a partner saying "I am definitely sending" and Nova showing
    // nothing is an unfalsifiable argument: a rejected request left no trace on
    // either side. The caller still learns nothing from a 401 - we just stop
    // being blind to it ourselves.
    //
    // No payloads. A rejected request is unauthenticated by definition, and
    // storing its body would turn this into a way to write into Nova without a
    // token. Reason, slug, IP and a count only.
    await client.query(
      'CREATE TABLE IF NOT EXISTS webhook_rejections (' +
      "  source_slug VARCHAR(64) NOT NULL DEFAULT ''," +
      "  reason VARCHAR(40) NOT NULL DEFAULT ''," +
      "  ip VARCHAR(64) NOT NULL DEFAULT ''," +
      '  hits BIGINT NOT NULL DEFAULT 0,' +
      '  first_seen TIMESTAMPTZ DEFAULT NOW(),' +
      '  last_seen TIMESTAMPTZ DEFAULT NOW(),' +
      '  PRIMARY KEY (source_slug, reason, ip)' +
      ');'
    );

    // How this source decides what a duplicate is: id | bytes | off.
    await client.query("ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS dedupe_mode VARCHAR(12) NOT NULL DEFAULT 'id';");

    // dedupe_key is SEPARATE from external_id on purpose.
    //
    // They started as one column, and that conflated two different things: the
    // partner's id (which always belongs on the row, for display and for
    // tracing a record back to their system) and the value we enforce
    // uniqueness on (which we may want to stop enforcing). With one column,
    // "turn duplicate checking off" also meant "lose the id from the screen",
    // and a sentinel id like "0" became a real key.
    //
    // Now: external_id is always recorded and never constrained. dedupe_key is
    // set only when the source is deduping on the id, and it alone carries the
    // unique index.
    await client.query('ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(200);');
    await client.query('UPDATE webhook_events SET dedupe_key = external_id WHERE dedupe_key IS NULL AND external_id IS NOT NULL;');
    // Wrapped: if historic rows already contain a repeated dedupe_key (from a
    // period when duplicate checking was off, or from the sentinel bug), the
    // CREATE fails - and an initDB that throws here would take out everything
    // defined below it. Dedupe still works without the index; the index makes it
    // race-proof. Losing the guarantee is survivable, losing the rest of the
    // schema is not.
    try {
      await client.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_dedupe_key ' +
        'ON webhook_events(source_slug, dedupe_key) WHERE dedupe_key IS NOT NULL;'
      );
    } catch (e) {
      console.error('Sync: could not create the dedupe index (' + e.message + '). ' +
        'Duplicate checking still works in application code, but concurrent identical ' +
        'deliveries are no longer resolved by the database. Clear the offending rows ' +
        'and restart to restore it.');
    }
    // The old index enforced uniqueness on external_id, which must now be free
    // to repeat. Dropped AFTER the new one exists so there is no window with
    // neither in place.
    await client.query('DROP INDEX IF EXISTS idx_webhook_events_dedupe;');

    // Per-type traffic counters, including for records the filter DROPPED.
    //
    // This is what makes a firehose safe to narrow. Pulsar's feed carries every
    // event in their system; you cannot decide which codes matter by reading a
    // spec, you decide by watching what actually shows up. These counters give
    // that picture indefinitely at a few bytes per type, whether or not the
    // payload was kept.
    //
    // Written from an in-memory buffer flushed on a timer, NOT once per
    // delivery - see utils/webhookIngest.js flushStats(). One counter row per
    // type would otherwise be the hottest row in the database.
    await client.query(
      'CREATE TABLE IF NOT EXISTS webhook_event_stats (' +
      '  source_slug VARCHAR(64) NOT NULL,' +
      "  event_type VARCHAR(120) NOT NULL DEFAULT ''," +
      '  stored_count BIGINT NOT NULL DEFAULT 0,' +
      '  dropped_count BIGINT NOT NULL DEFAULT 0,' +
      '  first_seen TIMESTAMPTZ DEFAULT NOW(),' +
      '  last_seen TIMESTAMPTZ DEFAULT NOW(),' +
      '  PRIMARY KEY (source_slug, event_type)' +
      ');'
    );

    console.log('Sync: inbound webhook tables ready. No sources exist until an admin creates one.');

    // ---------------------------------------------------------------- outbound
    // The other direction: what Nova asked Pulsar to do.
    //
    // The row is written BEFORE the request leaves, which is what makes the
    // difference between "we tried and it failed" and the far worse "something
    // changed in their dispatch system and we have no record of asking".
    //
    // request_body is stored REDACTED - utils/pulsarOut.js strips the sKey and
    // the token before anything reaches this table. Nothing here should ever be
    // a credential, and if you find one, that is a bug in redact() rather than
    // a reason to add a column to hide it in.
    await client.query(
      'CREATE TABLE IF NOT EXISTS outbound_calls (' +
      '  id SERIAL PRIMARY KEY,' +
      "  target VARCHAR(64) NOT NULL DEFAULT 'pulsar'," +
      '  action VARCHAR(64) NOT NULL,' +
      "  params JSONB NOT NULL DEFAULT '{}'::jsonb," +
      '  request_shape VARCHAR(24),' +
      '  request_url TEXT,' +
      '  request_body TEXT,' +
      "  mode VARCHAR(8) NOT NULL DEFAULT 'dry'," +
      "  status VARCHAR(16) NOT NULL DEFAULT 'sending'," +
      '  http_status INTEGER,' +
      '  response_body TEXT,' +
      '  error TEXT,' +
      '  attempts INTEGER NOT NULL DEFAULT 0,' +
      '  next_attempt_at TIMESTAMPTZ,' +
      '  duration_ms INTEGER,' +
      '  user_id INTEGER,' +
      '  user_name VARCHAR(120),' +
      '  correlation VARCHAR(120),' +
      '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
      '  finished_at TIMESTAMPTZ' +
      ');'
    );
    // The retry sweep's only query. Partial, because on a healthy day almost no
    // rows are 'failed' and there is no reason to carry the rest of the table.
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_outbound_calls_due ' +
      "ON outbound_calls(next_attempt_at) WHERE status = 'failed';"
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_outbound_calls_recent ON outbound_calls(target, id DESC);'
    );

    console.log('Sync: outbound call log ready, mode ' + (process.env.PULSAR_OUT_MODE || 'off') + '.');


    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
