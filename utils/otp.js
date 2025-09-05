const nodemailer = require('nodemailer');

const FROM_EMAIL = 'gisatazk2@gmail.com';
const EMAIL_PASSWORD = 'kpld krrk ratp hbyl'; // app password gmail

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: FROM_EMAIL,
    pass: EMAIL_PASSWORD,
  },
});

async function generateOtp(email, code) {
  const mailOptions = {
    from: FROM_EMAIL,
    to: email,
    subject: '🔐 Your OTP Code - Expires in 5 Minutes',
    html: `
      <div style="font-family: Arial; padding: 20px;">
        <h2>Your OTP Code</h2>
        <p>Gunakan kode berikut untuk verifikasi:</p>
        <div style="font-size: 30px; font-weight: bold;">${code}</div>
        <p>Expired dalam 5 menit.</p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ OTP dikirim ke ${email}`);
  } catch (err) {
    console.error('❌ Gagal kirim OTP:', err.message);
  }
}

async function sendPasswordResetEmail(email, resetLink) {
  const mailOptions = {
    from: FROM_EMAIL,
    to: email,
    subject: '🔁 Reset Your Password',
    html: `
      <div style="font-family: Arial; padding: 20px;">
        <h2>Reset Password</h2>
        <p>Klik tombol berikut untuk reset password:</p>
        <a href="${resetLink}" style="background: #4CAF50; color: white; padding: 10px 15px; border-radius: 5px; text-decoration: none;">Reset Password</a>
      </div>
    `,
  };

  return transporter.sendMail(mailOptions);
}

module.exports = { generateOtp, sendPasswordResetEmail };
