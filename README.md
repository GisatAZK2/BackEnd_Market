# Dokumentasi API untuk Autentikasi dan Pendaftaran Seller

Dokumentasi ini menjelaskan endpoint API untuk autentikasi pengguna, pendaftaran seller, dan operasi terkait. Semua endpoint diakses melalui base URL berikut:

**Base URL:** `https://backendmarket-production.up.railway.app/seller/V1`

Dokumentasi ini mencakup alur untuk pengguna baru dan pengguna yang sudah terdaftar sebagai seller, termasuk login dengan Google, serta format permintaan untuk setiap endpoint.

## Alur Autentikasi

1. **Pengguna Baru (Login Reguler atau Google):**
   - Daftar melalui endpoint `/register` atau login dengan Google melalui `/login/google`.
   - Jika akun baru, pengguna diarahkan ke `/verify-otp` untuk memverifikasi email dengan OTP.
   - Setelah verifikasi, pengguna harus mendaftar sebagai seller melalui `/forum-pendaftaran/seller`.
   - Setelah terdaftar sebagai seller, pengguna dapat login melalui `/login` atau `/login/google`.

2. **Seller yang Sudah Terdaftar:**
   - Jika pengguna sudah terdaftar sebagai seller, mereka dapat langsung login melalui `/login` atau `/login/google` untuk mengakses dashboard.

---

## Endpoint API

### 1. Pendaftaran Pengguna Baru
**Endpoint:** `POST /register`

**Deskripsi:** Mendaftarkan pengguna baru dengan email, kata sandi, dan avatar opsional. OTP akan dikirim untuk verifikasi email.

**Permintaan:**
```json
{
  "email": "user@example.com",
  "password": "katasandi123",
  "username": "namaPenggunaOpsional",
  "captchaToken": "token-captcha-dari-klien"
}
```
- **Opsional:** Sertakan `avatar` sebagai file dalam `multipart/form-data`.
- **Header:** `Content-Type: multipart/form-data`

**Respon (Sukses):**
```json
{
  "message": "User dibuat. OTP dikirim ke email."
}
```

**Respon (Gagal - Email Sudah Digunakan):**
```json
{
  "error": "Email sudah digunakan. Silakan gunakan email lain."
}
```

---

### 2. Verifikasi OTP
**Endpoint:** `POST /verify-otp`

**Deskripsi:** Memverifikasi OTP yang dikirim ke email pengguna. Untuk login Google, login otomatis dilakukan setelah verifikasi; jika tidak, pengguna harus login secara manual.

**Permintaan:**
```json
{
  "email": "user@example.com",
  "otp": "123456",
  "mode": "email" // atau "google"
}
```
- **Header:** `Content-Type: application/json`

**Respon (Sukses - Mode Google):**
```json
{
  "success": true,
  "step": "redirect_dashboard",
  "message": "OTP valid. Akun diaktifkan & login otomatis.",
  "token": "jwt-token",
  "id": "id-pengguna"
}
```

**Respon (Sukses - Mode Email):**
```json
{
  "success": true,
  "step": "login_manual",
  "message": "OTP valid. Akun diaktifkan. Silakan login manual."
}
```

**Respon (Gagal - OTP Salah):**
```json
{
  "success": false,
  "message": "OTP salah atau kadaluarsa."
}
```

---

### 3. Pendaftaran Seller
**Endpoint:** `POST /forum-pendaftaran/seller`

**Deskripsi:** Mendaftarkan pengguna sebagai seller setelah verifikasi OTP. Memerlukan detail toko dan gambar.

**Permintaan:**
```json
{
  "email": "user@example.com",
  "name": "John Doe",
  "businessName": "Bisnis Saya",
  "phone": "081234567890",
  "storeName": "Toko Saya",
  "storeAddress": "Jalan Utama 123",
  "provinsi_id": "31",
  "kota_id": "3171",
  "kecamatan_id": "3171010",
  "kelurahan_id": "3171010001",
  "latitude": "-6.175110",
  "longitude": "106.865036",
  "is_delivery_available": true,
  "delivery_fee": 10000
}
```
- **Wajib:** Sertakan `storeImage` sebagai file dalam `multipart/form-data` (JPEG atau PNG, maks 5MB).
- **Header:** `Content-Type: multipart/form-data`

**Respon (Sukses):**
```json
{
  "message": "✅ Seller berhasil didaftarkan",
  "imageUrl": "https://supabase-url/store-photos/...",
  "seller": { /* data seller */ }
}
```

**Respon (Gagal - Field Kurang):**
```json
{
  "message": "❌ Semua field wajib diisi termasuk gambar dan koordinat"
}
```

---

### 4. Login Seller
**Endpoint:** `POST /login`

**Deskripsi:** Login untuk pengguna yang sudah diverifikasi dan membuat profil seller jika belum ada.

**Permintaan:**
```json
{
  "email": "user@example.com",
  "password": "katasandi123",
  "captchaToken": "token-captcha-dari-klien"
}
```
- **Header:** `Content-Type: application/json`

**Respon (Sukses):**
```json
{
  "message": "Login seller sukses.",
  "token": "jwt-token",
  "seller_id": "id-seller",
  "store_name": "Toko Saya",
  "profile_seller": "url-gambar-toko",
  "email": "user@example.com"
}
```

**Respon (Gagal - Kata Sandi Salah):**
```json
{
  "error": "Password salah."
}
```

---

### 5. Login Google
**Endpoint:** `POST /login/google`

**Deskripsi:** Login atau mendaftar pengguna melalui Google OAuth. Jika akun baru, OTP dikirim untuk verifikasi.

**Permintaan:**
```json
{
  "id_token": "token-id-google"
}
```
- **Header:** `Content-Type: application/json`

**Respon (Sukses - Pengguna Baru):**
```json
{
  "success": true,
  "step": "verify_otp",
  "message": "User baru dibuat. OTP dikirim ke email.",
  "email": "user@example.com",
  "avatar": "url-avatar-google"
}
```

**Respon (Sukses - Pengguna Terverifikasi):**
```json
{
  "message": "Login Google sukses.",
  "token": "jwt-token",
  "id": "id-pengguna",
  "email": "user@example.com",
  "username": "nama-pengguna",
  "avatar": "url-avatar"
}
```

---

### 6. Lupa Kata Sandi
**Endpoint:** `POST /forgot-password`

**Deskripsi:** Mengirimkan link reset kata sandi ke email pengguna.

**Permintaan:**
```json
{
  "email": "user@example.com",
  "captchaToken": "token-captcha-dari-klien",
  "resetLink": "https://example.com/reset-password?email=user@example.com" // opsional
}
```
- **Header:** `Content-Type: application/json`

**Respon (Sukses):**
```json
{
  "message": "Link reset password dikirim ke email."
}
```

---

### 7. Reset Kata Sandi
**Endpoint:** `POST /reset-password`

**Deskripsi:** Mereset kata sandi pengguna.

**Permintaan:**
```json
{
  "email": "user@example.com",
  "newPassword": "katasandibaru123",
  "captchaToken": "token-captcha-dari-klien"
}
```
- **Header:** `Content-Type: application/json`

**Respon (Sukses):**
```json
{
  "message": "Kata sandi berhasil direset."
}
```

---

### 8. Perbarui Profil Seller
**Endpoint:** `PUT /seller/update/:id`

**Deskripsi:** Memperbarui informasi profil seller.

**Permintaan:**
```json
{
  "email": "user@example.com",
  "name": "John Doe",
  "business_name": "Bisnis Saya",
  "phone": "081234567890",
  "store_name": "Toko Saya",
  "store_address": "Jalan Utama 123",
  "provinsi_id": "31",
  "kabupaten_id": "3171",
  "kecamatan_id": "3171010",
  "kelurahan_id": "3171010001",
  "latitude": "-6.175110",
  "longitude": "106.865036",
  "store_image_url": "url-gambar-baru",
  "role": "seller",
  "is_delivery_available": true,
  "delivery_fee": 10000
}
```
- **Header:** `Content-Type: application/json`
- **Cookie:** `seller_info` dengan data seller yang valid
- **Parameter:** `id` (ID seller)

**Respon (Sukses):**
```json
{
  "message": "✅ Data toko berhasil diperbarui",
  "data": { /* data seller yang diperbarui */ }
}
```

---

### 9. Ambil Profil Seller
**Endpoint:** `GET /profile/:id`

**Deskripsi:** Mengambil profil seller berdasarkan ID atau dari cookie pengguna yang sedang login.

**Permintaan:**
- **Parameter:** `id` (ID seller, opsional jika menggunakan cookie)
- **Cookie:** `seller_info` (opsional jika ID disediakan)

**Respon (Sukses):**
```json
{
  "seller": {
    "id": "id-seller",
    "email": "user@example.com",
    "store_name": "Toko Saya",
    "alamat_lengkap_combine": "Jalan Utama 123, Kebon Kacang, Tanah Abang, Jakarta Pusat",
    /* kolom lainnya */
  }
}
```

---

### 10. Hapus Seller
**Endpoint:** `DELETE /seller/:id`

**Deskripsi:** Menghapus akun seller dan data terkait (pesanan, produk, diskon, dll.) berdasarkan parameter `mode`.

**Permintaan:**
- **Parameter:** `id` (ID seller)
- **Query:** `mode` (opsi: `account-only`, `orders`, `products`, `all`, `full`)
- **Cookie:** `seller_info` dengan data seller yang valid

**Respon (Sukses):**
```json
{
  "message": "✅ Seller berhasil dihapus dengan mode: {mode}"
}
```

**Respon (Gagal - Tidak Diizinkan):**
```json
{
  "error": "❌ Tidak boleh menghapus seller lain."
}
```

---

## Catatan
- Semua endpoint kecuali `/profile/:id` dan `/seller/update/:id` memerlukan verifikasi CAPTCHA (`captchaToken`).
- Cookie `seller_info` diatur saat login berhasil dan diperlukan untuk rute yang dilindungi seperti pembaruan atau penghapusan seller.
- Login Google memerlukan `id_token` yang valid dari Google OAuth.
- Pendaftaran seller memerlukan ID wilayah Indonesia yang valid (`provinsi_id`, `kota_id`, dll.) dan gambar toko.
- Parameter `mode` pada endpoint hapus menentukan cakupan penghapusan:
  - `account-only`: Hanya menghapus akun seller, mengatur `seller_id` pada pesanan/produk menjadi null.
  - `orders`: Menghapus akun seller dan pesanan terkait.
  - `products`: Menghapus akun seller dan produk terkait.
  - `all` atau `full`: Menghapus akun seller, pesanan, produk, dan diskon/acara terkait.