# 📌 Google Login + Verify OTP Flow

Dokumentasi ini menjelaskan alur login menggunakan **Google Sign-In** yang dilanjutkan dengan **verifikasi OTP** sebelum user dianggap terverifikasi.

---

## 🔹 Flow Login

1. **User klik tombol "Login dengan Google"**
   - Frontend akan memanggil **Google OAuth** untuk mendapatkan `id_token`.
   - Gunakan **Google Client ID** yang sudah terdaftar di Google Cloud Console.

2. **Kirim `id_token` ke Backend**
   - Endpoint yang digunakan:
     ```
     POST {API_URL}/auth/login/google
     Content-Type: application/json
     Body: { "id_token": "<google_id_token>" }
     ```
   - Backend akan:
     1. Verifikasi `id_token` ke Supabase Auth.
     2. Cek apakah user sudah ada di tabel `users`.

3. **Jika user belum ada → buat akun + kirim OTP**
   - Backend membuat user baru dengan:
     - `email` dari Google
     - `username` dari bagian awal email
     - `avatar` dari Google
     - `verified = false`
     - `otp_code` dan `otp_expires_at`
   - Backend mengirimkan OTP ke email user.

4. **Jika user sudah ada tapi belum verified**
   - Backend akan membuat OTP baru dan mengirim ulang ke email user.

5. **Jika user sudah verified**
   - Backend langsung membuat **JWT token** + **cookie login** (`user_info`) yang disimpan di browser.

---

## 🔹 Alur Lengkap

```
[User Klik Login Google]
        ↓
[Frontend: Ambil id_token Google]
        ↓
[POST /login/google]
        ↓
[Backend: Verifikasi ke Supabase Auth]
        ↓
[User belum ada?]
    ├─ Ya → Insert user + Kirim OTP → step: verify_otp
    └─ Tidak
        ↓
[User verified?]
    ├─ Tidak → Kirim OTP → step: verify_otp
    └─ Ya → Buat JWT + Cookie → Login sukses
```

---

## 🔹 Verifikasi OTP

- Endpoint:
  ```
  POST {API_URL}/auth/verify-otp
  Content-Type: application/json
  Body: {
    "email": "user@example.com",
    "otp": "123456"
  }
  ```
- Jika OTP benar & belum kadaluarsa → `verified` diubah menjadi `true`, user bisa login normal.

---

## 🔹 Komponen Penting

- **API URL**:  
  Contoh:
  ```
  https://backendmarket-production.up.railway.app
  ```

- **Google Client ID**:  
  Contoh:
  ```
  1234567890-abcdefgh.apps.googleusercontent.com
  ```

> Pastikan **Google Client ID** di frontend sama persis dengan yang terdaftar di Google Cloud Console.

---

## 🔹 Contoh Response

### User Baru (butuh OTP)
```json
{
  "success": true,
  "step": "verify_otp",
  "message": "User baru dibuat. OTP dikirim ke email.",
  "email": "user@example.com",
  "avatar": "https://lh3.googleusercontent.com/a/default-avatar"
}
```

### User Verified (Login Sukses)
```json
{
  "message": "Login Google sukses.",
  "token": "<jwt_token>",
  "id": "uuid",
  "email": "user@example.com",
  "username": "username",
  "avatar": "https://lh3.googleusercontent.com/a/default-avatar"
}
```

---

## 🔹 Catatan
- OTP berlaku **5 menit**.
- Cookie login (`user_info`) bersifat **httpOnly** dan berlaku **7 hari**.
- `sameSite` di-set `None` agar bisa digunakan **cross-origin**.

---
