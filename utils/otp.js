const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL; // misalnya: "Your App <noreply@yourdomain.com>"

// === Kirim OTP ===
async function generateOtp(email, code) {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "🔐 Your OTP Code - Expires in 5 Minutes",
      html: `
        <div style="font-family: Arial; padding: 20px;">
          <h2>Your OTP Code</h2>
          <p>Gunakan kode berikut untuk verifikasi:</p>
          <div style="font-size: 30px; font-weight: bold;">${code}</div>
          <p>Expired dalam 5 menit.</p>
        </div>
      `,
    });
    console.log(`✅ OTP dikirim ke ${email}`);
  } catch (err) {
    console.error("❌ Gagal kirim OTP:", err.message);
  }
}

// === Kirim link reset password ===
async function sendPasswordResetEmail(email, resetLink) {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "🔁 Reset Your Password",
      html: `
        <div style="font-family: Arial; padding: 20px;">
          <h2>Reset Password</h2>
          <p>Klik tombol berikut untuk reset password:</p>
          <a href="${resetLink}" style="background: #4CAF50; color: white; padding: 10px 15px; border-radius: 5px; text-decoration: none;">
            Reset Password
          </a>
        </div>
      `,
    });
    console.log(`✅ Reset link dikirim ke ${email}`);
  } catch (err) {
    console.error("❌ Gagal kirim email reset:", err.message);
  }
}

module.exports = { generateOtp, sendPasswordResetEmail };
