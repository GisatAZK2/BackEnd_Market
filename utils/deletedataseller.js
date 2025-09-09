const cron = require('node-cron');
const supabase = require('../config/supabase');

// Schedule cron job to run every minute
cron.schedule('* * * * *', async () => {
  console.log('Running OTP cleanup job...');
  
  try {
    // Cari user dengan OTP expired (> 5 menit) dan belum verifikasi
    const { data: expiredUsers, error: userError } = await supabase
      .from('users')
      .select('email, otp_expires_at, avatar')
      .eq('verified', false)
      .lt('otp_expires_at', new Date().toISOString());

    if (userError) {
      console.error('Error fetching expired users:', userError);
      return;
    }

    if (!expiredUsers || expiredUsers.length === 0) {
      console.log('No expired OTPs found.');
      return;
    }

    // Proses setiap user
    for (const user of expiredUsers) {
      const email = user.email;

      try {
        // Hapus data user + seller (pakai fungsi Postgres atomic)
        const { error: cleanupError } = await supabase.rpc('cleanup_unverified_user', { p_email: email });
        if (cleanupError) {
          throw new Error(`RPC cleanup failed for ${email}: ${cleanupError.message}`);
        }

        // Hapus store images dari storage
        const bucketPath = `store-photos/${email.replace(/[@.]/g, "_")}`;
        const { error: storageDeleteError } = await supabase.storage
          .from('store-photos')
          .remove([bucketPath]);

        if (storageDeleteError) {
          console.warn(`⚠️ Failed to delete store images for ${email}: ${storageDeleteError.message}`);
        }

        // Hapus avatar user dari storage
        if (user.avatar) {
          const avatarPath = user.avatar.split('/').pop();
          const { error: avatarDeleteError } = await supabase.storage
            .from('avatars')
            .remove([avatarPath]);

          if (avatarDeleteError) {
            console.warn(`⚠️ Failed to delete avatar for ${email}: ${avatarDeleteError.message}`);
          }
        }

        console.log(`✅ Successfully deleted unverified account: ${email}`);
      } catch (error) {
        console.error(`❌ Error processing cleanup for ${email}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Error in OTP cleanup job:', error.message);
  }
});

console.log('OTP cleanup cron job started.');
