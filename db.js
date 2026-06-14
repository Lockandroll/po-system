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
      "  role VARCHAR(50) NOT NULL DEFAULT 'requester'," +
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
      'ALTER TABLE vehicle_repairs ADD COLUMN IF NOT EXISTS vehicle_id INTEGER REFERENCES vehicles(id);'
    );
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
