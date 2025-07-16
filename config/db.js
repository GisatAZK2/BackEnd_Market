// config/db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.SUPABASE_DB_USER,
  host: process.env.SUPABASE_DB_HOST,
  database: process.env.SUPABASE_DB_NAME,
  password: process.env.SUPABASE_DB_PASSWORD,
  port: process.env.SUPABASE_DB_PORT,
  ssl: { rejectUnauthorized: false },
});

// Optional: koneksi awal (bisa tetap ada untuk testing)
const connect = async () => {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Connected to Supabase DB!');
  } catch (error) {
    console.error('❌ Error connecting to DB:', error);
  }
};

connect(); // panggil saat start

// ✅ Export pool untuk digunakan di auth.js
module.exports = pool;
