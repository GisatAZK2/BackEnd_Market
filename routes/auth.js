const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { createClient } = require('@supabase/supabase-js');
const { generateOtp, sendPasswordResetEmail } = require('../utils/otp');


const router = express.Router();
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

// ======================== REGISTER ========================
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

    const { error: insertErr } = await supabase.from('users').insert([{
      email,
      username: finalUsername,
      password: hashed,
      otp_code: otp,
      otp_expires_at: expiresAt,
      verified: false
    }]);

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

// ======================== VERIFIKASI OTP ========================
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

// ======================== LOGIN ========================
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

    // Set cookie aman dari XSS (httpOnly)
    res.cookie('user_info', JSON.stringify({
      id: user.id,
      email: user.email,
      username: user.username
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    // kirim id user ke frontend untuk dipakai fetch /user/:id
    res.json({ message: 'Login sukses.', token, id: user.id });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

// ======================== LUPA PASSWORD ========================
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

// ======================== GET USER BY ID (Validasi Cookie) ========================
router.get('/user/:id', async (req, res) => {
  const cookie = req.cookies.user_info; 
  if (!cookie) return res.status(401).json({ error: 'Tidak ada sesi login.' });

  let userInfo;
  try {
    userInfo = JSON.parse(cookie);
  } catch (e) {
    return res.status(400).json({ error: 'Cookie tidak valid.' });
  }

  // Pastikan cookie id sesuai dengan id yang diminta
  if (userInfo.id !== req.params.id) {
    return res.status(403).json({ error: 'Tidak boleh akses data user lain.' });
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, username, verified')
      .eq('id', req.params.id)
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

// ======================== UPDATE USER ========================
router.put('/user/:id', async (req, res) => {
  const cookie = req.cookies.user_info;
  if (!cookie) return res.status(401).json({ error: 'Tidak ada sesi login.' });

  let userInfo;
  try {
    userInfo = JSON.parse(cookie);
  } catch (e) {
    return res.status(400).json({ error: 'Cookie tidak valid.' });
  }

  if (userInfo.id !== req.params.id) {
    return res.status(403).json({ error: 'Tidak boleh update data user lain.' });
  }

  const { username, password } = req.body;

  try {
    const updatePayload = {};

    if (username) updatePayload.username = username;
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      updatePayload.password = hashed;
    }

    const { data, error } = await supabase
      .from('users')
      .update(updatePayload)
      .eq('id', req.params.id)
      .select('id, email, username');

    if (error) throw error;

    res.json({ message: 'User berhasil diupdate.', user: data[0] });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Gagal update user.' });
  }
});


// ======================== DELETE USER ========================
router.delete('/user/:id', async (req, res) => {
  const cookie = req.cookies.user_info;
  if (!cookie) return res.status(401).json({ error: 'Tidak ada sesi login.' });

  let userInfo;
  try {
    userInfo = JSON.parse(cookie);
  } catch (e) {
    return res.status(400).json({ error: 'Cookie tidak valid.' });
  }

  if (userInfo.id !== req.params.id) {
    return res.status(403).json({ error: 'Tidak boleh hapus user lain.' });
  }

  try {
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.clearCookie('user_info'); // Hapus cookie juga
    res.json({ message: 'User berhasil dihapus dan sesi diakhiri.' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Gagal menghapus user.' });
  }
});

router.post('/login/google', async (req, res) => {
  const { provider_token } = req.body; // token dari frontend (Google OAuth token)

  try {
    // Verifikasi token Google ke Supabase
    const { data: session, error: signInError } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: provider_token,
    });

    if (signInError || !session || !session.user) {
      return res.status(401).json({ error: 'Login Google gagal.' });
    }

    const { email, user_metadata } = session.user;

    // Cek apakah email sudah ada di tabel 'users'
    const { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!existingUser) {
      // User baru → buat user & kirim OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const username = email.split('@')[0];

      const { error: insertErr } = await supabase
        .from('users')
        .insert([{
          email,
          username,
          password: null,
          otp_code: otp,
          otp_expires_at: expiresAt,
          verified: false,
        }]);

      if (insertErr) {
        console.error('Insert user error:', insertErr);
        return res.status(500).json({ error: 'Gagal menyimpan user.' });
      }

      await generateOtp(email, otp);
      return res.status(201).json({
        message: 'User Google baru dibuat. OTP dikirim ke email.',
        step: 'verify_otp',
      });
    }

    if (!existingUser.verified) {
      // User ada tapi belum verifikasi
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      await supabase
        .from('users')
        .update({
          otp_code: otp,
          otp_expires_at: expiresAt,
        })
        .eq('email', email);

      await generateOtp(email, otp);
      return res.status(200).json({
        message: 'OTP dikirim ulang. Silakan verifikasi.',
        step: 'verify_otp',
      });
    }

    // Sudah verified → login langsung
    const token = jwt.sign({ id: existingUser.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.cookie('user_info', JSON.stringify({
      id: existingUser.id,
      email: existingUser.email,
      username: existingUser.username
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ message: 'Login Google sukses.', token, id: existingUser.id });
  } catch (err) {
    console.error('Google login error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});


module.exports = router;
