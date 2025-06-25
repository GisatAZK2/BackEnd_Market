const VALID_API_KEYS = ['YOUR_ADMIN_GENERATED_KEYS']; // Simpan dari DB di produksi

module.exports = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !VALID_API_KEYS.includes(apiKey)) {
    return res.status(403).json({ message: 'Forbidden. Invalid API key.' });
  }
  next();
};
