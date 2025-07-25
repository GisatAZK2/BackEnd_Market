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
### ✏️ PUT `/auth/user/:id`

Update data user (hanya untuk user yang sedang login dan sesuai ID-nya).

**Headers:**
```js
Cookie: user_info=<HttpOnly cookie otomatis dari login>
```


**Request Body:**

```json
{
  "username": "NamaBaru",
  "password": "passwordBaru123"
}
```

**Response (berhasil):**

```json
{
  "message": "User berhasil diupdate.",
  "user": {
    "id": "uuid-user",
    "email": "user@example.com",
    "username": "NamaBaru"
  }
}
```
**Response (Gagal):**

```json
{
  "error": "Tidak boleh update data user lain."
}
```

---
### 🗑️ DELETE `/auth/user/:id`

Hapus akun user dan hapus cookie login (logout otomatis).

**Headers:**
```js
  Cookie: user_info=<HttpOnly cookie otomatis dari login>
```

**Response (Berhasil):**
```json
{
  "message": "User berhasil dihapus dan sesi diakhiri."
}

```

**Response (Gagal (Akses User Lain)):**
```json
{
  "error": "Tidak boleh hapus user lain."
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


# 📦 Produk API 

API ini menangani CRUD produk, upload gambar ke Supabase Storage, serta fitur pencarian berdasarkan lokasi menggunakan Haversine Formula.

## 📁 Endpoint List

---

### 🔼 `POST /upload`

**Deskripsi:** Upload produk baru dengan gambar dan varian (opsional).  
**Form Data:**

| Field             | Tipe     | Keterangan                              |
|------------------|----------|------------------------------------------|
| `seller_id`       | string   | ID seller                                |
| `productName`     | string   | Nama produk                              |
| `productDescription` | string   | Deskripsi produk                          |
| `productPrice`    | number   | Harga produk (wajib lebih dari 0)        |
| `stock`           | number   | Jumlah stok (opsional, default 0)        |
| `category_id`     | string   | ID kategori                              |
| `variants`        | string   | JSON string array varian produk (opsional) |
| `productImage`    | file     | Gambar produk (.jpeg/.png, maks. 5MB)    |

**Response:**
```json
{
  "message": "✅ Produk berhasil diunggah",
  "data": { ... }
}
```

---

### 🛍️ `GET /allproduct`

Mengambil semua produk dari database.

**Response:**
```json
{
  "message": "✅ Ditemukan X produk",
  "products": [...]
}
```

---

### 📍 `GET /nearby-by-location?lat=<latitude>&lng=<longitude>`

**Deskripsi:** Menampilkan produk dari seller yang berada dalam radius 40 km dari lokasi pengguna.

**Query Parameter:**

- `lat` — Latitude pengguna
- `lng` — Longitude pengguna

**Contoh:** `/nearby-by-location?lat=-6.200&lng=106.816`

**Response:**
```json
{
  "message": "✅ Ditemukan X produk dalam radius 40 km",
  "products": [
    {
      "id": "...",
      "product_name": "...",
      "distanceInKm": 5.42,
      ...
    }
  ]
}
```

---

### 📂 `GET /by-category/:category_id`

Menampilkan produk berdasarkan kategori tertentu.

---

### 🔍 `GET /:id`

Mengambil detail produk berdasarkan `id`.

---

### ✏️ `PUT /:id`

Edit produk berdasarkan ID. Bisa disertai `productImage` (opsional) untuk mengganti gambar.

---

### ❌ `DELETE /:id`

Menghapus produk berdasarkan ID. Termasuk menghapus gambar dari Supabase Storage.

---

## 🧰 Struktur Tabel Terkait

### Tabel: `products`
| Kolom                 | Tipe       |
|-----------------------|------------|
| `id`                  | uuid       |
| `seller_id`           | uuid       |
| `product_name`        | string     |
| `product_description` | text       |
| `product_price`       | float      |
| `stock`               | integer    |
| `category_id`         | uuid       |
| `product_image_url`   | text       |
| `keywords`            | string[]   |

### Tabel: `product_variants`
| Kolom              | Tipe     |
|--------------------|----------|
| `product_id`       | uuid     |
| `variant_name`     | string   |
| `variant_price`    | float    |
| `variant_stock`    | int      |
| `variant_image_url`| text     |

---

## 🧭 Panduan Ambil Lokasi dari Frontend (JavaScript)

Gunakan **HTML5 Geolocation API** untuk ambil koordinat pengguna:

```js
navigator.geolocation.getCurrentPosition(
  (position) => {
    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;

    // Contoh fetch produk terdekat
    fetch(`/api/product/nearby-by-location?lat=${latitude}&lng=${longitude}`)
      .then(res => res.json())
      .then(data => {
        console.log('Produk terdekat:', data.products);
      })
      .catch(err => console.error(err));
  },
  (error) => {
    console.error('Gagal mendapatkan lokasi:', error);
  },
  {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0
  }
);
```

### 🛑 Catatan:
- Minta izin pengguna agar bisa akses lokasi.
- Geolocation hanya berjalan di **HTTPS** atau **localhost**.


---

## 📌 Catatan

* Semua email akan diverifikasi menggunakan OTP sebelum akun bisa digunakan.

