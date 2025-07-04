const nodemailer = require('nodemailer');

const FROM_EMAIL = 'gisatazk2@gmail.com';
const EMAIL_PASSWORD = 'kpld krrk ratp hbyl'; // Password aplikasi Gmail

const otpStore = {};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: FROM_EMAIL,
    pass: EMAIL_PASSWORD,
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
    subject: '🕒 Your OTP Code - Expires in 5 Minutes',
    html: `
      <div style="font-family: Arial; padding: 20px; background: #f9f9f9;">
        <h2>🔐 Your OTP Code</h2>
        <p>Use this code to verify:</p>
        <div style="font-size: 32px; font-weight: bold;">${code}</div>
        <p>This code expires in 5 minutes.</p>
      </div>
    `,
  };

  transporter.sendMail(mailOptions, (err, info) => {
    if (err) console.error('Send OTP failed:', err.message);
    else console.log(`OTP sent to ${email}`);
  });

  return code;
}

function verifyOtp(email, code) {
  const record = otpStore[email];
  if (!record) return false;

  const isValid = record.code === code && Date.now() < record.expires;
  if (isValid) delete otpStore[email]; // Hapus OTP setelah sukses
  return isValid;
}

function sendPasswordResetEmail(email, resetLink) {
  const mailOptions = {
    from: FROM_EMAIL,
    to: email,
    subject: '🔁 Reset Your Password',
    html: `
      <div style="font-family: Arial; padding: 20px; background: #f9f9f9;">
        <h2>Reset Password</h2>
        <p>Click link below to reset:</p>
        <a href="${resetLink}" style="color: white; background: #4CAF50; padding: 10px 15px; text-decoration: none; border-radius: 5px;">Reset Password</a>
        <p>This link expires soon.</p>
      </div>
    `,
  };

  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('Send reset link failed:', err.message);
        reject(err);
      } else {
        console.log(`Reset link sent to ${email}`);
        resolve(info);
      }
    });
  });
}

module.exports = { generateOtp, verifyOtp, sendPasswordResetEmail };
