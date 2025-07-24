# 📦 Marketplace Backend API

API untuk autentikasi, pendaftaran seller, dan pengelolaan data dengan OTP, cookie, dan integrasi wilayah Indonesia.

---

## 📁 Daftar Endpoint

---

### 🔐 Autentikasi

---

#### POST `/auth/register`

Register akun baru + kirim OTP ke email.

**Request:**

```json
{
  "email": "user@example.com",
  "username" : "User123",
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
  "error": "OTP salah atau kadaluarsa."
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

Login dengan email dan password.
Jika berhasil, server akan mengirimkan:

1. **JWT Token** dalam body response
2. **Cookie ********`user_info`******** (HttpOnly)** yang menyimpan data user

**Request:**

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response (berhasil):**

```json
{
  "message": "Login sukses.",
  "token": "<JWT_TOKEN>",
  "id": "user-uuid"
}
```

**Response (gagal):**

```json
{
  "error": "Password salah."
}
```

**Catatan:**

* Cookie `user_info` bersifat **HttpOnly** sehingga tidak dapat diakses oleh JavaScript (aman dari XSS).
* JWT token dikirim ke frontend untuk digunakan bila diperlukan.

---

#### GET `/auth/user/:id`

Mengambil informasi user berdasarkan `id`.
**Hanya bisa diakses** jika user sudah login (cookie `user_info` tersedia dan cocok).

**Request (Header):**

```http
Cookie: user_info=<HttpOnly cookie otomatis dari login>
```

**Response (berhasil):**

```json
{
  "user": {
    "id": "uuid-user",
    "email": "user@example.com",
    "username": "User123",
    "verified": true
  }
}
```

**Response (gagal):**

```json
{
  "error": "Tidak ada sesi login atau tidak boleh akses data user lain."
}
```

---

## 🖥️ **Frontend Flow**

### **1. Login**

```js
fetch('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
  credentials: 'include' // penting agar cookie ikut tersimpan
})
  .then(res => res.json())
  .then(data => {
    if (data.id) {
      localStorage.setItem('userId', data.id);
      // Lanjut fetch data user
    } else {
      alert(data.error);
    }
  });
```

### **2. Ambil Data User**

```js
const userId = localStorage.getItem('userId');

fetch(`/auth/user/${userId}`, {
  credentials: 'include' // kirim cookie HttpOnly
})
  .then(res => res.json())
  .then(data => console.log('Data user:', data));
```

---

## Catatan Keamanan

* **Cookie HttpOnly** melindungi dari pencurian via XSS.
* Server akan memvalidasi cookie agar user hanya bisa mengakses datanya sendiri.
* JWT token hanya sebagai pelengkap; cookie menjadi sesi utama.

---

### 🖜️ Wilayah Indonesia

Ambil data provinsi, kabupaten, kecamatan, dan kelurahan dari EMSIFA API.

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

### 🗹️ Seller

---

## 💡 Instruksi Frontend: Ambil Koordinat Lokasi

Gunakan Geolocation API untuk mengisi latitude dan longitude:

```js
navigator.geolocation.getCurrentPosition(
  (position) => {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;

    formData.append("latitude", lat);
    formData.append("longitude", lng);

    // Lanjut kirim data ke backend
    fetch('/seller', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + idToken
      },
      body: formData,
    });
  },
  (error) => {
    alert("Tidak bisa mengambil lokasi: " + error.message);
  }
);
```

---

#### POST `/seller`

Pendaftaran akun seller. Wajib kirim gambar toko (`multipart/form-data`).

**Headers:**
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

* Semua email akan diverifikasi menggunakan OTP sebelum akun bisa digunakan.

