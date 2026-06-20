const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal') ? false : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false)
});

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
      'ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS item_number VARCHAR(100);' +
      'ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(255);' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;' +
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);' +
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
      '  code VARCHAR(6) NOT NULL,' +
      '  expires_at TIMESTAMPTZ NOT NULL,' +
      '  used BOOLEAN NOT NULL DEFAULT false,' +
      '  created_at TIMESTAMPTZ DEFAULT NOW()' +
      ');'
    );
    await client.query(
      'ALTER TABLE two_factor_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;'
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
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_deposits_date ON deposits(deposit_date);' +
      'CREATE INDEX IF NOT EXISTS idx_deposits_city ON deposits(city_code);'
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
    const _vb = await client.query("SELECT value FROM settings WHERE key = 'view_perms_backfilled'");
    if (!_vb.rows.length) {
      const _rp = await client.query("SELECT value FROM settings WHERE key = 'role_permissions'");
      if (_rp.rows.length && _rp.rows[0].value) {
        try {
          const obj = JSON.parse(_rp.rows[0].value);
          if (obj && typeof obj === 'object') {
            ['locksmith', 'locksmith_coordinator', 'roadside_technician', 'manager'].forEach(function(r) {
              if (Array.isArray(obj[r])) {
                ['view_pos', 'view_quotes', 'view_vr', 'view_deposits'].forEach(function(p) {
                  if (obj[r].indexOf(p) === -1) obj[r].push(p);
                });
              }
            });
            await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('role_permissions', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(obj)]);
          }
        } catch (e) { console.error('view-perm backfill failed:', e.message); }
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('view_perms_backfilled', '1') ON CONFLICT (key) DO NOTHING");
    }
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
