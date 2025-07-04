# 📦 Marketplace Backend API

API untuk autentikasi dan pendaftaran seller dengan dukungan Firebase Auth, OTP, serta integrasi dengan ImageKit dan API wilayah Indonesia.

---

## 📁 Daftar Endpoint

---

### 🔐 Autentikasi

---

#### POST `/auth/check-email`

Cek apakah email sudah terdaftar.

**Request:**

```json
{
  "email": "user@example.com"
}
```

**Response:**

```json
// Jika ditemukan
{ "exists": true }

// Jika tidak ditemukan
{ "exists": false }
```

---

#### POST `/auth/register`

Register akun baru + kirim OTP ke email.

**Request:**

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**

```json
{
  "message": "User dibuat. OTP dikirim ke email."
}
```

---

#### POST `/auth/verify-otp`

Verifikasi OTP dan aktifkan akun.

**Request:**

```json
{
  "email": "user@example.com",
  "otp": "123456"
}
```

**Response (berhasil):**

```json
{
  "message": "OTP valid. Akun diaktifkan."
}
```

**Response (gagal):**

```json
{
  "error": "OTP salah atau sudah kadaluarsa."
}
```

---

#### POST `/auth/forgot-password`

Kirim link reset password ke email.

**Request:**

```json
{
  "email": "user@example.com"
}
```

**Response:**

```json
{
  "message": "Link reset password dikirim ke email."
}
```

---

#### POST `/auth/login`

> Ditangani di client (Firebase SDK). Endpoint dummy.

**Response:**

```json
{
  "error": "Login ditangani oleh Firebase Client SDK."
}
```

---

#### POST `/auth/verify-token`

Verifikasi Firebase ID token + cek apakah user sudah verifikasi OTP.

**Request:**

```json
{
  "idToken": "FIREBASE_ID_TOKEN"
}
```

**Response (verified):**

```json
{
  "uid": "USER_UID",
  "email": "user@example.com"
}
```

**Response (belum verified):**

```json
{
  "error": "Akun belum diverifikasi via OTP."
}
```

---

### 🗜️ Wilayah Indonesia

Ambil data provinsi, kabupaten, kecamatan, dan kelurahan dari EMSIFA API.

---

#### GET `/wilayah/provinsi`

**Response:**

```json
[
  { "id": "11", "name": "ACEH" },
  ...
]
```

---

#### GET `/wilayah/kabupaten/:provinsiId`

**Contoh:** `/wilayah/kabupaten/11`

**Response:**

```json
[
  { "id": "1101", "name": "KAB. SIMEULUE" },
  ...
]
```

---

#### GET `/wilayah/kecamatan/:kabupatenId`

**Contoh:** `/wilayah/kecamatan/1101`

**Response:**

```json
[
  { "id": "1101010", "name": "TEUPAH SELATAN" },
  ...
]
```

---

#### GET `/wilayah/kelurahan/:kecamatanId`

**Contoh:** `/wilayah/kelurahan/1101010`

**Response:**

```json
[
  { "id": "1101010001", "name": "LATIUNG" },
  ...
]
```

---

### 🛙️ Seller

---

#### POST `/seller`

Pendaftaran akun seller. Wajib kirim gambar toko (`multipart/form-data`).

**Headers:**\
`Content-Type: multipart/form-data`

**Form Data:**

| Field        | Tipe   | Keterangan                          |
| ------------ | ------ | ----------------------------------- |
| email        | string | Email seller                        |
| name         | string | Nama lengkap                        |
| businessName | string | Nama bisnis                         |
| phone        | string | Nomor HP                            |
| storeName    | string | Nama toko                           |
| storeAddress | string | Alamat lengkap                      |
| kelurahan    | string | Nama kelurahan                      |
| kecamatan    | string | Nama kecamatan                      |
| kabupaten    | string | Nama kabupaten                      |
| provinsi     | string | Nama provinsi                       |
| latitude     | string | Latitude toko (dari perangkat user) |
| longitude    | string | Longitude toko                      |
| storeImage   | file   | Gambar toko (JPEG / PNG, maks 5MB)  |

**Response (sukses):**

```json
{
  "message": "✅ Seller berhasil didaftarkan",
  "imageUrl": "https://ik.imagekit.io/...",
  "seller": {
    "email": "user@example.com",
    "name": "User Name",
    "businessName": "CV Maju Jaya",
    "storeLocation": { "_latitude": -6.2, "_longitude": 106.8 },
    ...
  }
}
```

**Response (gagal):**

```json
{
  "message": "❌ Semua field wajib diisi termasuk gambar dan koordinat"
}
```

---

## 📌 Catatan

- Semua email akan diverifikasi menggunakan OTP sebelum akun bisa digunakan.
- Token JWT dari Firebase harus diverifikasi sebelum mengakses fitur protected (gunakan endpoint `/verify-token`).
- Pastikan Anda menyimpan `serviceAccountKey.json` untuk Firebase di folder `./`.

