const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { generateOtp, sendPasswordResetEmail } = require('../utils/otp');
const router = express.Router();

// ✅ REGISTER
router.post('/register', async (req, res) => {
  const { email, password, username } = req.body;
  console.log('Body register:', req.body);

  try {
    const { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'Email sudah digunakan. Silakan gunakan email lain.' });
    }

    const finalUsername = username && username.trim() !== '' 
      ? username.trim() 
      : email.split('@')[0];

    const hashed = await bcrypt.hash(password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { data: insertedUser, error: insertErr } = await supabase.from('users').insert([{
      email,
      username: finalUsername,
      password: hashed,
      otp_code: otp,
      otp_expires_at: expiresAt,
      verified: false
    }]).select();

    if (insertErr) {
      console.error('Supabase insert error:', insertErr);
      return res.status(500).json({ error: 'Gagal membuat user di database.' });
    }

    await generateOtp(email, otp);
    res.status(201).json({ message: 'User dibuat. OTP dikirim ke email.' });
  } catch (err) {
    console.error('Error saat register:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

// ✅ VERIFIKASI OTP
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const now = new Date().toISOString();
    if (user.otp_code === otp && user.otp_expires_at > now) {
      const { error: updateErr } = await supabase
        .from('users')
        .update({
          verified: true,
          otp_code: null,
          otp_expires_at: null
        })
        .eq('email', email);

      if (updateErr) throw updateErr;

      res.json({ message: 'OTP valid. Akun diaktifkan.' });
    } else {
      res.status(400).json({ error: 'OTP salah atau kadaluarsa.' });
    }
  } catch (err) {
    console.error('OTP Error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

// ✅ LOGIN + COOKIE
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!user || !user.verified) {
      return res.status(403).json({ error: 'Akun tidak ditemukan atau belum diverifikasi.' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Password salah.' });

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    // Set cookie (httpOnly biar aman)
    res.cookie('user_info', {
      id: user.id,
      email: user.email,
      username: user.username
    }, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ message: 'Login sukses.', token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

// ✅ LUPA PASSWORD
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!user) return res.status(404).json({ error: 'Email tidak ditemukan.' });

    const resetLink = `https://yourfrontend.com/reset-password?email=${email}`;
    await sendPasswordResetEmail(email, resetLink);

    res.json({ message: 'Link reset password dikirim ke email.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

// ✅ GET USER BY ID
router.get('/user/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, username, verified')
      .eq('id', id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User tidak ditemukan.' });
    }

    res.json({ user });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

module.exports = router;
