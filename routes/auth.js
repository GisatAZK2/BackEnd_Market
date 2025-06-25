const express = require('express');
const admin = require('../firebase');
const { generateOtp, verifyOtp } = require('../utils/otp');
const router = express.Router();

// Register with email
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await admin.auth().createUser({ email, password });
    const otp = generateOtp(email);
    console.log(`OTP for ${email}: ${otp}`); // Send via email service
    res.status(201).json({ message: 'User created. OTP sent to email.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Verify OTP
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (verifyOtp(email, otp)) {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { verified: true });
    res.json({ message: 'OTP verified. Account is active.' });
  } else {
    res.status(400).json({ error: 'Invalid or expired OTP.' });
  }
});

// Login with email
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  // Email/password login should be handled client-side → get Firebase token
  res.status(501).json({ error: 'Use Firebase Client SDK for login and pass ID token.' });
});

// Verify ID token
router.post('/verify-token', async (req, res) => {
  const { idToken } = req.body;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const user = await admin.auth().getUser(decoded.uid);
    if (user.customClaims?.verified) {
      res.json({ uid: user.uid, email: user.email });
    } else {
      res.status(403).json({ error: 'User not verified via OTP.' });
    }
  } catch (err) {
    res.status(401).json({ error: 'Invalid token.' });
  }
});

module.exports = router;
