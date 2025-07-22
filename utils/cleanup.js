
require('dotenv').config();
const supabase = require('../config/supabase');

async function deleteExpiredUnverifiedUsers() {
  try {
    const now = new Date().toISOString();

    const { error, count } = await supabase
      .from('users')
      .delete({ count: 'exact' }) 
      .lt('otp_expires_at', now)
      .eq('verified', false);

    if (error) {
      console.error('❌ Gagal hapus akun expired:', error.message);
    } else {
      console.log(`✅ ${count || 0} akun tidak diverifikasi berhasil dihapus.`);
    }
  } catch (err) {
    console.error('🔥 Error saat running cleanup:', err);
  }
}

deleteExpiredUnverifiedUsers();
