const express = require('express');
const admin = require('../firebase');
const { generateOtp, verifyOtp, sendPasswordResetEmail } = require('../utils/otp');

const router = express.Router();

// ✅ Cek apakah email sudah terdaftar
router.post('/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email diperlukan.' });

  try {
    await admin.auth().getUserByEmail(email);
    res.json({ exists: true });
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      res.json({ exists: false });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});


router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email dan password diperlukan.' });

  try {
 
    try {
      await admin.auth().getUserByEmail(email);
      return res.status(400).json({ error: 'Email sudah terdaftar.' });
    } catch (_) {
  
    }

    await admin.auth().createUser({ email, password });
    const otp = generateOtp(email);
    console.log(`🔐 OTP untuk ${email}: ${otp}`);
    res.status(201).json({ message: 'User dibuat. OTP dikirim ke email.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email dan OTP diperlukan.' });

  try {
    if (verifyOtp(email, otp)) {
      const user = await admin.auth().getUserByEmail(email);
      await admin.auth().setCustomUserClaims(user.uid, { verified: true });
      res.json({ message: 'OTP valid. Akun diaktifkan.' });
    } else {
      res.status(400).json({ error: 'OTP salah atau sudah kadaluarsa.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email diperlukan.' });

  try {
    const link = await admin.auth().generatePasswordResetLink(email);
    console.log(`🔗 Reset link untuk ${email}: ${link}`); // Debug
    await sendPasswordResetEmail(email, link);
    res.json({ message: 'Link reset password dikirim ke email.' });
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      res.status(404).json({ error: 'Email tidak ditemukan.' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});


router.post('/login', (req, res) => {
  res.status(501).json({ error: 'Login ditangani oleh Firebase Client SDK.' });
});


router.post('/verify-token', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'ID token diperlukan.' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const user = await admin.auth().getUser(decoded.uid);

    if (user.customClaims?.verified) {
      res.json({ uid: user.uid, email: user.email });
    } else {
      res.status(403).json({ error: 'Akun belum diverifikasi via OTP.' });
    }
  } catch (err) {
    res.status(401).json({ error: 'Token tidak valid.' });
  }
});

module.exports = router;
