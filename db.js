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
      'ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS item_number VARCHAR(100);' +
      'ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(255);' +
      'ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255);' +
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
    await client.query(
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS period_start DATE;' +
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS period_end DATE;'
    );
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
      "ALTER TABLE task_subtasks ADD COLUMN IF NOT EXISTS done BOOLEAN NOT NULL DEFAULT false;" +
      "ALTER TABLE task_subtasks ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;" +
      "ALTER TABLE task_subtasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS user_id INTEGER;" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS user_name VARCHAR(255);" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'event';" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS body TEXT;" +
      "ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();"
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
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_from_schedule BOOLEAN NOT NULL DEFAULT false;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_from_org BOOLEAN NOT NULL DEFAULT false;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS org_x INTEGER;");
    // ---- PTO module ----
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS hire_date DATE;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pto_balance_hours NUMERIC(8,2) NOT NULL DEFAULT 0;");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pto_exempt BOOLEAN NOT NULL DEFAULT false;");
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
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);' +
      'CREATE INDEX IF NOT EXISTS idx_deposits_date ON deposits(deposit_date);' +
      'CREATE INDEX IF NOT EXISTS idx_deposits_city ON deposits(city_code);'
    );
    // Cash deposit reconciliation: Pulsar-owed figure + multiple receipts + expense lines
    await client.query(
      'ALTER TABLE deposits ADD COLUMN IF NOT EXISTS pulsar_owed DECIMAL(10,2);'
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
      'ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN DEFAULT false;'
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
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS org_level INTEGER;'
    );
    // Late-alert fire-once flag on the matched shift.
    await client.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS late_alerted_at TIMESTAMPTZ;');
    // Indexes
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_time_entries_user_open ON time_entries(user_id) WHERE status = 'open';" +
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

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
