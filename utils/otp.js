const nodemailer = require('nodemailer');
require('dotenv').config();

const otpStore = {};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

function generateOtp(email) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email] = { code, expires: Date.now() + 5 * 60 * 1000 };

  const mailOptions = {
    from: `"OTP Service" <${process.env.EMAIL_USER}>`,
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
      console.error('❌ Failed to send OTP email:', error);
    } else {
      console.log(`✅ OTP email sent to ${email} (${info.response})`);
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
