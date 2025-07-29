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
  const { email, otp, mode = 'email' } = req.body;

  try {
    // === Cek user ===
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (userErr || !user) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    const now = new Date().toISOString();
    if (user.otp_code !== otp || user.otp_expires_at <= now) {
      return res.status(400).json({ success: false, message: 'OTP salah atau kadaluarsa.' });
    }

    // === Update verified ===
    const { error: updateErr } = await supabase
      .from('users')
      .update({
        verified: true,
        otp_code: null,
        otp_expires_at: null
      })
      .eq('email', email);

    if (updateErr) throw updateErr;

    // === Hanya Google yang login otomatis ===
    if (mode === 'google') {
      const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

      res.cookie('user_info', JSON.stringify({
        id: user.id,
        email: user.email,
        username: user.username
      }), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'None',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });

      return res.json({
        success: true,
        step: 'redirect_dashboard',
        message: 'OTP valid. Akun diaktifkan & login otomatis.',
        token,
        id: user.id
      });
    }

    // === Email biasa tidak auto-login ===
    return res.json({
      success: true,
      step: 'login_manual',
      message: 'OTP valid. Akun diaktifkan. Silakan login manual.'
    });

  } catch (err) {
    console.error('OTP Error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
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
      sameSite: 'None',
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
  const { email, resetLink } = req.body;

  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!user) return res.status(404).json({ error: 'Email tidak ditemukan.' });

    const link = resetLink || `https://cihuy-store-production.up.railway.app/reset-password?email=${encodeURIComponent(email)}`;

    // Kirim email reset
    await sendPasswordResetEmail(email, link);

    res.json({ message: 'Link reset password dikirim ke email.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});


// lanjutan forgot password

// ======================== RESET PASSWORD ========================
router.post('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!user) return res.status(404).json({ error: 'Email tidak ditemukan.' });

    const hashed = await bcrypt.hash(newPassword, 10);
    const { error } = await supabase
      .from('users')
      .update({ password: hashed })
      .eq('email', email);

    if (error) {
      console.error('Supabase update error:', error);
      return res.status(500).json({ error: 'Gagal mereset kata sandi.' });
    }

    res.json({ message: 'Kata sandi berhasil direset.' });
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

  // Pastikan cookie user_info.id sama dengan param id
  if (userInfo.id !== req.params.id) {
    return res.status(403).json({ error: 'Sesi login tidak valid.' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, username, verified')
    .eq('id', req.params.id)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User tidak ditemukan.' });

  res.json({ user });
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
  const { provider_token } = req.body;

  if (!provider_token) {
    const response = { error: 'Token Google tidak ditemukan.' };
    console.log('Response →', response);
    return res.status(400).json(response);
  }

  try {
    // === 1. Verifikasi token Google ke Supabase ===
    const { data: session, error: signInError } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: provider_token,
    });

    if (signInError || !session?.user) {
      const response = { error: 'Login Google gagal.' };
      console.error('Google sign-in error:', signInError);
      console.log('Response →', response);
      return res.status(401).json(response);
    }

    const { email } = session.user;

    // === 2. Cari user di DB ===
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    // === 3. Kalau belum ada user, buat & kirim OTP ===
    if (!user) {
      const username = email.split('@')[0];
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: insertErr } = await supabase.from('users').insert([{
        email,
        username,
        password: '',
        otp_code: otp,
        otp_expires_at: expiresAt,
        verified: false
      }]);

      if (insertErr) {
        const response = { error: 'Gagal menyimpan user.' };
        console.error('Insert user error:', insertErr);
        console.log('Response →', response);
        return res.status(500).json(response);
      }

      await generateOtp(email, otp);
      const response = {
        success: true,
        step: 'verify_otp',
        message: 'User baru dibuat. OTP dikirim ke email.',
        email
      };
      console.log('Response →', response);
      return res.status(201).json(response);
    }

    // === 4. Kalau user belum diverifikasi → kirim OTP ulang ===
    if (!user.verified) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: updateErr } = await supabase
        .from('users')
        .update({ otp_code: otp, otp_expires_at: expiresAt })
        .eq('email', email);

      if (updateErr) {
        const response = { error: 'Gagal memperbarui OTP.' };
        console.error('Update OTP error:', updateErr);
        console.log('Response →', response);
        return res.status(500).json(response);
      }

      await generateOtp(email, otp);
      const response = {
        success: true,
        step: 'verify_otp',
        message: 'OTP dikirim ulang. Silakan verifikasi.',
        email
      };
      console.log('Response →', response);
      return res.json(response);
    }

    // === 5. Kalau user verified → buat JWT & set cookie ===
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.cookie('user_info', JSON.stringify({
      id: user.id,
      email: user.email,
      username: user.username
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'None',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    const response = {
      message: 'Login Google sukses.',
      token,
      id: user.id
    };
    console.log('Response →', response);
    return res.json(response);

  } catch (err) {
    const response = { error: 'Kesalahan server.' };
    console.error('Google login error:', err);
    console.log('Response →', response);
    return res.status(500).json(response);
  }
});



module.exports = router;
