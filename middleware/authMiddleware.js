// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const pool = require('../config/supabase');

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token tidak ditemukan.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
    const user = result.rows[0];

    if (!user || !user.verified) {
      return res.status(403).json({ error: 'Akun tidak valid atau belum diverifikasi.' });
    }

    req.user = user; 
    next();
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(401).json({ error: 'Token tidak valid atau expired.' });
  }
};

module.exports = authMiddleware;
