const { Resend } = require('resend');

const resend = new Resend("re_4aaRiXH6_6juiyFHsJTBa3CujM6bU5qTP"); // kamu udah bilang OK tempel langsung

const otpStore = {};

function generateOtp(email) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email] = {
    code,
    expires: Date.now() + 5 * 60 * 1000, // 5 menit
  };

  resend.emails
    .send({
      from: "Your App <onboarding@resend.dev>",
      to: [email],
      subject: "Your OTP Code",
      html: `
        <p>Your OTP code is:</p>
        <h2>${code}</h2>
        <p>This code will expire in 5 minutes.</p>
      `,
    })
    .then(() => {
      console.log(`✅ OTP sent to ${email}`);
    })
    .catch((error) => {
      console.error('❌ Failed to send OTP:', error?.message || error);
    });

  return code;
}

function verifyOtp(email, code) {
  const record = otpStore[email];
  if (!record) return false;

  const isValid = record.code === code && Date.now() < record.expires;
  if (isValid) {
    delete otpStore[email];
  }

  return isValid;
}

module.exports = { generateOtp, verifyOtp };
