const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { generateOtp, verifyOtp, sendPasswordResetEmail } = require('../utils/otp');

const router = express.Router();

// 🔍 Cek email terdaftar
router.post('/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email diperlukan.' });

  const user = await User.findOne({ email });
  res.json({ exists: !!user });
});

// 📝 Register + Simpan OTP
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email dan password diperlukan.' });

  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email sudah terdaftar.' });

    const hashed = await bcrypt.hash(password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 menit

    const newUser = new User({
      email,
      password: hashed,
      otp: { code: otp, expiresAt },
    });

    await newUser.save();
    await generateOtp(email, otp); // kirim email
    res.status(201).json({ message: 'User dibuat. OTP dikirim ke email.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email dan OTP diperlukan.' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    if (user.otp.code === otp && user.otp.expiresAt > new Date()) {
      user.verified = true;
      user.otp = undefined;
      await user.save();
      res.json({ message: 'OTP valid. Akun diaktifkan.' });
    } else {
      res.status(400).json({ error: 'OTP salah atau kadaluarsa.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔐 Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email dan password diperlukan.' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
    if (!user.verified) return res.status(403).json({ error: 'Akun belum diverifikasi.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Password salah.' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login sukses.', token, email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔁 Forgot Password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email diperlukan.' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'Email tidak ditemukan.' });

    const resetLink = `https://yourfrontend.com/reset-password?email=${email}`; // ganti URL-nya
    await sendPasswordResetEmail(email, resetLink);
    res.json({ message: 'Link reset password dikirim ke email.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔎 Verify Token
router.post('/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token diperlukan.' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.verified) {
      return res.status(403).json({ error: 'Akun tidak valid atau belum diverifikasi.' });
    }

    res.json({ uid: user._id, email: user.email });
  } catch (err) {
    res.status(401).json({ error: 'Token tidak valid.' });
  }
});

module.exports = router;
