const otpStore = {}; // Replace with DB like Redis in production

function generateOtp(email) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email] = { code, expires: Date.now() + 5 * 60 * 1000 };
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
