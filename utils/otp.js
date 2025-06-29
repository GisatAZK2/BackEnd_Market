const nodemailer = require('nodemailer');

// Email dan password aplikasi
const FROM_EMAIL = 'gisatazk2@gmail.com';
const EMAIL_PASSWORD = 'kpld krrk ratp hbyl'; // Gunakan password aplikasi Gmail

const otpStore = {};

// Setup nodemailer
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
    expires: Date.now() + 5 * 60 * 1000,
  };

  const mailOptions = {
  from: FROM_EMAIL,
  to: email,
  subject: '🕒 Your OTP Code - Expires in 5 Minutes',
  html: `
    <div style="font-family: Arial, sans-serif; background-color: #f9f9f9; padding: 30px; border-radius: 10px; max-width: 500px; margin: auto; box-shadow: 0 0 10px rgba(0,0,0,0.1);">
      <h2 style="color: #333;">🔐 Your One-Time Password (OTP)</h2>
      <p style="font-size: 16px; color: #555;">Use the code below to continue:</p>
      <div style="font-size: 32px; font-weight: bold; color: #4CAF50; letter-spacing: 8px; margin: 20px 0; text-align: center;">
        ${code}
      </div>
      <p style="font-size: 14px; color: #999; text-align: center;">This code will expire in:</p>
      
      <!-- Gimmick: Simulated countdown bar -->
      <div style="margin: 20px auto; background: #eee; border-radius: 20px; overflow: hidden; height: 10px; width: 100%;">
        <div style="
          width: 100%;
          height: 100%;
          background: linear-gradient(to right, #f44336, #ff9800);
          animation: countdown 300s linear forwards;
        "></div>
      </div>
      
      <style>
        @keyframes countdown {
          from { width: 100%; }
          to { width: 0%; }
        }
      </style>
      
      <p style="font-size: 12px; color: #aaa; text-align: center; margin-top: 30px;">
        If you didn’t request this, you can safely ignore this email.
      </p>
    </div>
  `
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
