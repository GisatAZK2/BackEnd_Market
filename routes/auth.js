const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/supabase');
const { generateOtp, sendPasswordResetEmail } = require('../utils/otp');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();


router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await pool.query(`
    INSERT INTO users (email, password, otp_code, otp_expires_at) 
    VALUES ($1, $2, $3, $4)
  `, [email, hashed, otp, expiresAt]);

  await generateOtp(email, otp);
  res.status(201).json({ message: 'User dibuat. OTP dikirim ke email.' });
});

router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (user.otp_code === otp && new Date(user.otp_expires_at) > new Date()) {
    await pool.query(`UPDATE users SET verified = TRUE, otp_code = NULL, otp_expires_at = NULL WHERE email = $1`, [email]);
    res.json({ message: 'OTP valid. Akun diaktifkan.' });
  } else {
    res.status(400).json({ error: 'OTP salah atau kadaluarsa.' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];

  if (!user || !user.verified) return res.status(403).json({ error: 'Akun tidak ditemukan atau belum diverifikasi.' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Password salah.' });

  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ message: 'Login sukses.', token });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Email tidak ditemukan.' });

  const resetLink = `https://yourfrontend.com/reset-password?email=${email}`;
  await sendPasswordResetEmail(email, resetLink);
  res.json({ message: 'Link reset password dikirim ke email.' });
});


module.exports = router;
