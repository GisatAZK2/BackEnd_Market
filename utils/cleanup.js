const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
require('dotenv').config();

const CRON_SECRET = process.env.CRON_SECRET || 'defaultsecret';

router.get('/cron/cleanup-users', async (req, res) => {
  const key = req.query.secret;

  if (key !== CRON_SECRET) {
    return res.status(403).json({ error: 'Akses ditolak 🛑' });
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
