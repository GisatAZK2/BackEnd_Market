const nodemailer = require('nodemailer');

const otpStore = {};

const FROM_EMAIL = 'gisatazk2@gmail.com'; // email pengirim
const EMAIL_PASSWORD = 'kpld krrk ratp hbyl'; // password aplikasi, bukan password login biasa

// Setup transporter Gmail (atau Yahoo/SMTP lainnya)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: FROM_EMAIL,
    pass: EMAIL_PASSWORD, // Gunakan App Password jika Gmail 2FA aktif
  },
});

function generateOtp(email) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  otpStore[email] = {
    code,
    expires: Date.now() + 5 * 60 * 1000, // 5 menit
  };

  const mailOptions = {
    from: FROM_EMAIL,
    to: email,
    subject: 'Your OTP Code',
    html: `
      <p>Your OTP code is:</p>
      <h2>${code}</h2>
      <p>This code will expire in 5 minutes.</p>
    `,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('❌ Failed to send OTP:', error.message);
    } else {
      console.log(`✅ OTP sent to ${email}: ${info.response}`);
    }
  });

  return code;
}

function verifyOtp(email, code) {
  const record = otpStore[email];
  if (!record) return false;

  const isValid = record.code === code && Date.now() < record.expires;
  if (isValid) delete otpStore[email];
  return isValid;
}

module.exports = { generateOtp, verifyOtp };
