const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const supabase = require("../../config/supabase");
const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");
const { generateOtp, sendPasswordResetEmail } = require("../../utils/otp");
const detectSpam = require("../../middleware/detectSpam");
const verifyCaptcha = require("../../middleware/verifyCaptcha");
const fetch = require("node-fetch");

const router = express.Router();
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post(
  "/register",
  detectSpam,
  upload.single("avatar"),
  verifyCaptcha,
  async (req, res) => {
    const { email, password, username } = req.body;
    console.log("Body register:", req.body);

    try {
      // === Cek user sudah ada atau belum ===
      const { data: existingUser } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .single();

      if (existingUser) {
        return res.status(400).json({
          error: "Email sudah digunakan. Silakan gunakan email lain.",
        });
      }

      // === Buat username final ===
      const finalUsername =
        username && username.trim() !== ""
          ? username.trim()
          : email.split("@")[0];

      const hashed = await bcrypt.hash(password, 10);
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      // === Avatar Handling ===
      let avatarPath;
      if (req.file) {
        // --- Kalau user upload avatar ---
        const filename = `avatar_${Date.now()}.webp`;

        // Konversi ke WebP dalam buffer
        const buffer = await sharp(req.file.buffer)
          .webp({ quality: 80 })
          .toBuffer();

        // Upload ke Supabase Storage
        const { error: uploadErr } = await supabase.storage
          .from("avatars")
          .upload(filename, buffer, {
            contentType: "image/webp",
            upsert: true,
          });

        if (uploadErr) {
          console.error("Upload error:", uploadErr);
          return res
            .status(500)
            .json({ error: "Gagal upload avatar ke storage." });
        }

        // Ambil public URL
        const { data: publicUrl } = supabase.storage
          .from("avatars")
          .getPublicUrl(filename);

        avatarPath = publicUrl.publicUrl;
      } else {
        // --- Kalau user TIDAK upload avatar ---
        const defaultImagePath = path.join(__dirname, "../assets/user.png");
        const filename = `avatar_default_${Date.now()}.webp`;

        // Konversi default.png ke WebP buffer
        const buffer = await sharp(defaultImagePath)
          .webp({ quality: 80 })
          .toBuffer();

        // Upload ke Supabase Storage
        const { error: uploadErr } = await supabase.storage
          .from("avatars")
          .upload(filename, buffer, {
            contentType: "image/webp",
            upsert: true,
          });

        if (uploadErr) {
          console.error("Upload default avatar error:", uploadErr);
          return res
            .status(500)
            .json({ error: "Gagal upload default avatar ke storage." });
        }

        // Ambil public URL
        const { data: publicUrl } = supabase.storage
          .from("avatars")
          .getPublicUrl(filename);

        avatarPath = publicUrl.publicUrl;
      }

      // === Simpan ke database ===
      const { error: insertErr } = await supabase.from("users").insert([
        {
          email,
          username: finalUsername,
          password: hashed,
          otp_code: otp,
          otp_expires_at: expiresAt,
          verified: false,
          avatar: avatarPath,
        },
      ]);

      if (insertErr) {
        console.error("Supabase insert error:", insertErr);
        return res
          .status(500)
          .json({ error: "Gagal membuat user di database." });
      }

      await generateOtp(email, otp);
      res.status(201).json({ message: "User dibuat. OTP dikirim ke email." });
    } catch (err) {
      console.error("Error saat register:", err);
      res.status(500).json({ error: "Terjadi kesalahan pada server." });
    }
  },
);

// ======================== VERIFY OTP ========================
router.post("/verify-otp", async (req, res) => {
  const { email, otp, mode = "email" } = req.body;

  try {
    // === Cek user ===
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (userErr || !user) {
      return res
        .status(404)
        .json({ success: false, message: "User tidak ditemukan." });
    }

    const now = new Date().toISOString();
    if (user.otp_code !== otp || user.otp_expires_at <= now) {
      return res
        .status(400)
        .json({ success: false, message: "OTP salah atau kadaluarsa." });
    }

    // === Update verified ===
    const { error: updateErr } = await supabase
      .from("users")
      .update({
        verified: true,
        otp_code: null,
        otp_expires_at: null,
      })
      .eq("email", email);

    if (updateErr) throw updateErr;

    // === Hanya Google yang login otomatis ===
    if (mode === "google") {
      const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });

      // === Cek apakah sudah seller ===
      const { data: seller } = await supabase
        .from("sellers")
        .select("*")
        .eq("email", user.email)
        .single();

      if (!seller) {
        return res.json({
          success: true,
          step: "register_seller",
          message: "OTP valid. Akun diaktifkan. Harap daftar sebagai seller.",
        });
      }

      // Set cookie seller_info
      res.cookie(
        "seller_info",
        JSON.stringify({
          id: seller.id,
          email: seller.email,
          store_name: seller.store_name,
        }),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "None",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        },
      );

      return res.json({
        success: true,
        step: "redirect_dashboard",
        message: "OTP valid. Akun diaktifkan & login otomatis.",
        token,
        id: user.id,
      });
    }

    return res.json({
      success: true,
      step: "login_manual",
      message: "OTP valid. Akun diaktifkan. Silakan login manual.",
    });
  } catch (err) {
    console.error("OTP Error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan pada server." });
  }
});

// ======================== LOGIN SELLER ========================
router.post("/login", detectSpam, verifyCaptcha, async (req, res) => {
  const { email, password } = req.body;

  try {
    // Cek user untuk autentikasi
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (!user || !user.verified) {
      return res
        .status(403)
        .json({ error: "Akun tidak ditemukan atau belum diverifikasi." });
    }

    if (!user.password) {
      return res.status(400).json({ error: "Password user belum diatur." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Password salah." });

    // Cek data seller
    let { data: seller } = await supabase
      .from("sellers")
      .select("*")
      .eq("email", email)
      .single();

    // Token tetap berdasarkan user.id
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    if (!seller) {
      // Kalau seller belum terdaftar → pakai user_info sementara
      res.cookie(
        "user_info",
        JSON.stringify({
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar || null,
        }),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "None",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        }
      );

      return res.status(409).json({
        message: "User ini belum terdaftar sebagai seller",
        token,
        user_info: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar || null,
        },
      });
    }

    // Kalau seller sudah ada → pakai seller_info
    res.cookie(
      "seller_info",
      JSON.stringify({
        id: seller.id,
        email: seller.email,
        store_name: seller.store_name,
      }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "None",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      }
    );

    res.json({
      message: "Login seller sukses.",
      token,
      seller_id: seller.id,
      store_name: seller.store_name,
      profile_seller: seller.store_image_url,
      email: seller.email,
    });
  } catch (err) {
    console.error("Login seller error:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});


// GET Seller profile + total followers
router.get("/profile/:id", async (req, res) => {
  try {
    let sellerId;

    if (req.params.id) {
      sellerId = req.params.id;
    } else {
      const sellerCookie = req.cookies?.seller_info;
      if (!sellerCookie) {
        return res.status(401).json({ error: "Seller belum login." });
      }
      try {
        const sellerInfo = JSON.parse(sellerCookie);
        sellerId = sellerInfo.id;
      } catch {
        return res.status(400).json({ error: "Cookie seller tidak valid." });
      }
    }

    // Ambil semua kolom biar fleksibel
    const { data: seller, error } = await supabase
      .from("sellers")
      .select("*")
      .eq("id", sellerId)
      .single();

    if (error || !seller) {
      return res.status(404).json({ error: "Seller tidak ditemukan." });
    }

    // Gabungkan alamat
    const alamat_lengkap_combine = [
      seller.store_address || seller.alamat_lengkap || "",
      seller.kelurahan || "",
      seller.kecamatan || "",
      seller.kabupaten || seller.kota_kabupaten || "",
    ]
      .filter(Boolean)
      .join(", ");

    // Hitung jumlah followers seller ini
    const { count: totalFollowers, error: followerError } = await supabase
      .from("follows")
      .select("*", { count: "exact", head: true })
      .eq("seller_id", sellerId);

    if (followerError) {
      return res.status(500).json({
        error: "Gagal mengambil jumlah followers.",
        detail: followerError.message,
      });
    }

    // (Opsional) ambil daftar user yang follow seller ini
    const { data: followers, error: followersError } = await supabase
      .from("follows")
      .select(`
        user_id,
        users (id, username, email, avatar, created_at)
      `)
      .eq("seller_id", sellerId);

    if (followersError) {
      return res.status(500).json({
        error: "Gagal mengambil daftar followers.",
        detail: followersError.message,
      });
    }

    res.json({
      seller: {
        ...seller,
        alamat_lengkap_combine,
        total_followers: totalFollowers || 0,
        followers: followers?.map((f) => f.users) || [],
      },
    });
  } catch (err) {
    console.error("Get seller profile error:", err);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});


// ======================== LUPA PASSWORD ========================
router.post("/forgot-password", detectSpam, verifyCaptcha, async (req, res) => {
  const { email, resetLink } = req.body;

  try {
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (!user) return res.status(404).json({ error: "Email tidak ditemukan." });

    const link =
      resetLink ||
      `https://sellercihuy.sytes.net/forgot-password?email=${encodeURIComponent(email)}`;

    // Kirim email reset
    await sendPasswordResetEmail(email, link);

    res.json({ message: "Link reset password dikirim ke email." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});

// lanjutan forgot password

// ======================== RESET PASSWORD ========================
router.post("/reset-password", detectSpam, verifyCaptcha, async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (!user) return res.status(404).json({ error: "Email tidak ditemukan." });

    const hashed = await bcrypt.hash(newPassword, 10);
    const { error } = await supabase
      .from("users")
      .update({ password: hashed })
      .eq("email", email);

    if (error) {
      console.error("Supabase update error:", error);
      return res.status(500).json({ error: "Gagal mereset kata sandi." });
    }

    res.json({ message: "Kata sandi berhasil direset." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
});


// ====================== UPDATE USER ======================
// Helper ambil nama wilayah (sama persis seperti di user)
async function getWilayahName(url, id) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Gagal fetch data wilayah");
  const list = await res.json();
  const found = list.find((item) => item.id == id);
  if (!found) throw new Error(`Wilayah dengan id ${id} tidak ditemukan`);
  return found.name;
}

router.put(
  "/seller/update/:id",
  upload.single("store_image_url"),
  async (req, res) => {
    try {
      console.log("👉 Mulai proses update seller");

      const sellerInfo = req.cookies?.seller_info
        ? JSON.parse(req.cookies.seller_info)
        : null;

      if (!sellerInfo?.id) {
        console.log("❌ Seller belum login");
        return res
          .status(401)
          .json({ error: "❌ Harus login sebagai seller" });
      }

      const sellerId = req.params.id;
      console.log("🔑 Seller ID dari param:", sellerId);
      console.log("🔑 Seller ID dari cookie:", sellerInfo.id);

      if (sellerId !== sellerInfo.id) {
        console.log("⚠️ Seller mencoba update data seller lain");
        return res.status(403).json({
          error: "❌ Tidak diizinkan mengubah data seller lain",
        });
      }

      const body = req.body || {};
      console.log("📦 Body request:", body);

      const {
        email,
        name,
        business_name,
        phone,
        store_name,
        store_address,
        provinsi_id,
        kabupaten_id,
        kecamatan_id,
        kelurahan_id,
        latitude,
        longitude,
        role,
        is_delivery_available,
        delivery_fee,
      } = body;

      const updatePayload = {};

      if (email) updatePayload.email = email;
      if (name) updatePayload.name = name;
      if (business_name) updatePayload.business_name = business_name;
      if (phone) updatePayload.phone = phone;
      if (store_name) updatePayload.store_name = store_name;
      if (store_address) updatePayload.store_address = store_address;
      if (latitude) updatePayload.latitude = latitude;
      if (longitude) updatePayload.longitude = longitude;
      if (role) updatePayload.role = role;
      if (typeof is_delivery_available !== "undefined")
        updatePayload.is_delivery_available =
          is_delivery_available === "true" || is_delivery_available === true;
      if (delivery_fee) updatePayload.delivery_fee = delivery_fee;

      // === Upload / Replace Gambar Toko ===
      if (req.file) {
        console.log("🖼️ File upload diterima:", req.file.originalname);
        const filename = `store_${sellerId}_${Date.now()}.webp`;

        const buffer = await sharp(req.file.buffer)
          .webp({ quality: 80 })
          .toBuffer();

        const { error: uploadError } = await supabase.storage
          .from("store-photos")
          .upload(filename, buffer, {
            contentType: "image/webp",
            upsert: true,
          });

        if (uploadError) {
          console.error("❌ Gagal upload gambar:", uploadError);
          return res.status(400).json({
            error: "Upload gagal",
            detail: uploadError.message,
          });
        }

        const { data: publicUrl } = supabase.storage
          .from("store-photos")
          .getPublicUrl(filename);

        updatePayload.store_image_url = publicUrl.publicUrl;
      }

      // === Update wilayah ===
      if (provinsi_id) {
        updatePayload.provinsi = await getWilayahName(
          "https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json",
          provinsi_id
        );
      }
      if (kabupaten_id && provinsi_id) {
        updatePayload.kabupaten = await getWilayahName(
          `https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${provinsi_id}.json`,
          kabupaten_id
        );
      }
      if (kecamatan_id && kabupaten_id) {
        updatePayload.kecamatan = await getWilayahName(
          `https://www.emsifa.com/api-wilayah-indonesia/api/districts/${kabupaten_id}.json`,
          kecamatan_id
        );
      }
      if (kelurahan_id && kecamatan_id) {
        updatePayload.kelurahan = await getWilayahName(
          `https://www.emsifa.com/api-wilayah-indonesia/api/villages/${kecamatan_id}.json`,
          kelurahan_id
        );
      }

      console.log("📤 Payload final yang akan diupdate:", updatePayload);

      // === Update DB seller ===
      const { data, error } = await supabase
        .from("sellers")
        .update(updatePayload)
        .eq("id", sellerId)
        .select();

      if (error) {
        console.error("❌ Gagal update seller di DB:", error);
        return res.status(400).json({ error: error.message });
      }

      console.log("✅ Data seller berhasil diperbarui:", data);

      // === Sinkronisasi seller_name di tabel products ===
      if (name) {
        console.log("🔄 Update semua produk seller dengan seller_name baru:", name);
        const { error: productUpdateError } = await supabase
          .from("products")
          .update({ seller_name: name })
          .eq("seller_id", sellerId);

        if (productUpdateError) {
          console.error("⚠️ Gagal sinkronisasi seller_name di products:", productUpdateError);
          // jangan return error, biarkan update seller tetap berhasil
        } else {
          console.log("✅ Semua produk berhasil diupdate seller_name.");
        }
      }

      res.json({
        message: "✅ Data toko berhasil diperbarui",
        data,
      });
    } catch (err) {
      console.error("💥 Error server:", err);
      res.status(500).json({
        error: "Terjadi kesalahan server",
        detail: err.message,
      });
    }
  }
);


// ======================== DELETE USER ========================
router.post("/login/google", async (req, res) => {
  const { id_token } = req.body;
  if (!id_token) return res.status(400).json({ error: "ID token Google tidak ditemukan." });

  try {
    // 1. Verifikasi token Google
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;
    const googleAvatar = payload.picture || null;

    // 2. Cek user
    let { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    // 3. User baru → buat user + OTP
    if (!user) {
      const username = email.split("@")[0];
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: insertErr, data: newUser } = await supabase.from("users").insert([{
        email,
        username,
        password: null,
        otp_code: otp,
        otp_expires_at: expiresAt,
        verified: false,
        avatar: googleAvatar,
      }]).select().single();

      if (insertErr) {
        console.error(insertErr);
        return res.status(500).json({ error: "Gagal menyimpan user." });
      }

      await generateOtp(email, otp);
      return res.status(201).json({
        success: true,
        step: "verify_otp",
        message: "User baru dibuat. OTP dikirim ke email.",
        email,
        avatar: googleAvatar,
      });
    }

    // 4. User ada tapi belum verified → OTP ulang
    if (!user.verified) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: updateErr } = await supabase
        .from("users")
        .update({ otp_code: otp, otp_expires_at: expiresAt })
        .eq("email", email);

      if (updateErr) return res.status(500).json({ error: "Gagal memperbarui OTP." });

      await generateOtp(email, otp);
      return res.json({
        success: true,
        step: "verify_otp",
        message: "OTP dikirim ulang. Silakan verifikasi.",
        email,
        avatar: user.avatar || googleAvatar,
      });
    }

    // 5. User verified → cek seller
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    let { data: seller } = await supabase
      .from("sellers")
      .select("*")
      .eq("email", email)
      .single();

    // Kalau belum seller → balikin info user
    if (!seller) {
      res.cookie(
        "user_info",
        JSON.stringify({
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar || googleAvatar,
        }),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "None",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        }
      );

      return res.status(409).json({
        message: "User ini belum terdaftar sebagai seller",
        token,
        user_info: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar || googleAvatar,
        },
      });
    }

    // Kalau seller ada → set cookie seller_info
    res.cookie(
      "seller_info",
      JSON.stringify({
        id: seller.id,
        email: seller.email,
        store_name: seller.store_name,
      }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "None",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      }
    );

    return res.json({
      message: "Login Google seller sukses.",
      token,
      seller_id: seller.id,
      store_name: seller.store_name,
      profile_seller: seller.store_image_url,
      email: seller.email,
    });
  } catch (err) {
    console.error("Google login seller error:", err);
    return res.status(500).json({ error: "Kesalahan server." });
  }
});


router.delete("/seller/:id", async (req, res) => {
  const cookie = req.cookies.seller_info;
  if (!cookie) {
    return res.status(401).json({ error: "❌ Tidak ada sesi login seller." });
  }

  let sellerInfo;
  try {
    sellerInfo = JSON.parse(cookie);
  } catch (err) {
    return res.status(400).json({ error: "❌ Cookie seller tidak valid." });
  }

  if (sellerInfo.id !== req.params.id) {
    return res.status(403).json({ error: "❌ Tidak boleh menghapus seller lain." });
  }

  const sellerId = req.params.id;
  const mode = req.query.mode || "account-only"; // default akun saja

  try {
    // Ambil semua order & produk seller
    const { data: orders } = await supabase
      .from("orders")
      .select("id")
      .eq("seller_id", sellerId);
    const orderIds = orders?.map(o => o.id) || [];

    const { data: products } = await supabase
      .from("products")
      .select("id")
      .eq("seller_id", sellerId);
    const productIds = products?.map(p => p.id) || [];

    // Ambil semua store_discount, flash_sale_products, event_products
    const { data: storeDiscounts } = await supabase
      .from("store_discounts")
      .select("id")
      .eq("store_id", sellerId);
    const storeDiscountIds = storeDiscounts?.map(s => s.id) || [];

    const { data: flashSaleProducts } = await supabase
      .from("flash_sale_products")
      .select("flash_sale_id")
      .eq("seller_id", sellerId);
    const flashSaleIds = [...new Set(flashSaleProducts?.map(f => f.flash_sale_id) || [])];

    const { data: eventProducts } = await supabase
      .from("event_products")
      .select("event_id")
      .eq("seller_id", sellerId);
    const eventIds = [...new Set(eventProducts?.map(e => e.event_id) || [])];

    // Mode: hapus akun + order
    if (mode === "orders" || mode === "all" || mode === "full") {
      if (orderIds.length > 0) {
        await supabase.from("order_items").delete().in("order_id", orderIds);
        await supabase.from("orders").delete().eq("seller_id", sellerId);
      }
    }

    // Mode: hapus akun + produk
    if (mode === "products" || mode === "all" || mode === "full") {
      if (productIds.length > 0) {
        await supabase.from("product_variants").delete().in("product_id", productIds);
        await supabase.from("products").delete().eq("seller_id", sellerId);
      }
    }

    // Mode: hapus akun + store discounts
    if (mode === "full") {
      if (storeDiscountIds.length > 0) {
        await supabase.from("store_discount_items").delete().in("discount_id", storeDiscountIds);
        await supabase.from("store_discounts").delete().eq("store_id", sellerId);
      }

      if (flashSaleIds.length > 0) {
        await supabase.from("flash_sale_products").delete().eq("seller_id", sellerId);
        // NOTE: kalau mau hapus master flash_sale, pastikan dia milik seller ini
        await supabase.from("flash_sales").delete().in("id", flashSaleIds);
      }

      if (eventIds.length > 0) {
        await supabase.from("event_products").delete().eq("seller_id", sellerId);
        await supabase.from("events").delete().in("id", eventIds);
      }
    }

    // Mode: hanya hapus akun
    if (mode === "account-only") {
      if (orderIds.length > 0) {
        await supabase
          .from("orders")
          .update({ seller_id: null })
          .eq("seller_id", sellerId);
      }
      if (productIds.length > 0) {
        await supabase
          .from("products")
          .update({ seller_id: null })
          .eq("seller_id", sellerId);
      }
    }

    // Hapus akun seller
    await supabase.from("sellers").delete().eq("id", sellerId);

    res.clearCookie("seller_info");
    res.json({ message: `✅ Seller berhasil dihapus dengan mode: ${mode}` });

  } catch (err) {
    console.error("Delete seller error:", err);
    res.status(500).json({ error: "❌ Terjadi kesalahan saat menghapus seller." });
  }
});



module.exports = router;
