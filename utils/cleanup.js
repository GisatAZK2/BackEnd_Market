const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

// 🔐 Ganti ini biar cuma kamu yang bisa trigger cron (opsional tapi disarankan)
const API_KEY = process.env.CRON_API_KEY || 'supersecretkey';

router.get('/cron/cleanup-users', async (req, res) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(403).json({ error: 'Unauthorized cron request 🚫' });
  }

  try {
    const now = new Date().toISOString();

    const { error, count } = await supabase
      .from('users')
      .delete({ count: 'exact' })
      .lt('otp_expires_at', now)
      .eq('verified', false);

    if (error) throw error;

    res.json({ message: `✅ ${count || 0} akun tidak diverifikasi dihapus.` });
  } catch (err) {
    console.error('🔥 Cron cleanup error:', err.message);
    res.status(500).json({ error: 'Gagal saat proses cleanup.' });
  }
});

module.exports = router;
