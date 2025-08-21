# Dokumentasi API Backend Market

Selamat datang di dokumentasi resmi API Backend Market! API ini menyediakan fungsionalitas untuk dua jenis pengguna: **User** (pembeli) dan **Seller** (penjual). Berikut adalah panduan lengkap untuk endpoint yang tersedia, termasuk pembaruan besar untuk kedua kategori.

## Base URL
- **User**: `https://backendmarket-production.up.railway.app/`
- **Seller**: `https://backendmarket-production.up.railway.app/seller/V1`

## Autentikasi
- Semua endpoint yang memerlukan autentikasi menggunakan **cookie** (`user_info` untuk pembeli, `seller_info` untuk penjual) yang berisi informasi pengguna dalam format JSON.
- **JWT** digunakan untuk autentikasi login, dengan masa berlaku 7 hari.
- Pastikan untuk menyertakan cookie `user_info` atau `seller_info` pada request yang memerlukan autentikasi.

---

## Endpoint untuk User

### 1. Login
Endpoint untuk login sebagai pembeli, termasuk pengecekan apakah pengguna juga terdaftar sebagai penjual untuk mencegah pembelian barang sendiri.

**Endpoint**: `POST auth/login`

**Body**:
```json
{
  "email": "string",
  "password": "string"
}
```

**Response**:
- **200**: Berhasil login
  ```json
  {
    "message": "Login sukses.",
    "token": "JWT_TOKEN",
    "id": "user_id",
    "email": "user_email",
    "username": "user_username",
    "avatar": "user_avatar_url",
    "seller_id": "seller_id_if_exists"
  }
  ```
- **401**: Password salah
- **403**: Akun tidak ditemukan atau belum diverifikasi
- **500**: Kesalahan server

**Catatan**:
- Cookie `user_info` akan diset dengan informasi pengguna, termasuk `seller_id` jika pengguna juga terdaftar sebagai penjual.
- Pengecekan `seller_id` mencegah penjual membeli barang sendiri.

---

### 2. Checkout
Endpoint untuk melakukan checkout dari keranjang belanja. Mendukung pengelompokan order per penjual dan metode pengambilan (`diantar` atau `diambil`).

**Endpoint**: `POST /order/cart/checkout`

**Body**:
```json
{
  "itemsToCheckout": [
    {
      "productId": "string",
      "variantId": "string|null",
      "qty": "number",
      "pickupMethod": "diantar|diambil"
    }
  ],
  "pickupMethod": "diantar|diambil"
}
```

**Response**:
- **200**: Berhasil checkout
  ```json
  {
    "message": "✅ Berhasil checkout {n} order. (⏱ {time}s)",
    "orders": [{ "order_data": "..." }]
  }
  ```
- **400**: Tidak ada item untuk checkout atau alamat pengiriman tidak lengkap
- **500**: Kesalahan server

**Fitur**:
- Validasi alamat lengkap untuk metode `diantar`.
- Pengelompokan order berdasarkan `seller_id` dan `pickup_method`.
- Cache untuk produk dan penjual guna meningkatkan performa.
- Notifikasi email dikirim secara asinkronus setelah checkout.
- Item yang di-checkout dihapus dari keranjang.

---

### 3. Memberikan Rating
Endpoint untuk memberikan rating pada item order yang telah diterima.

**Endpoint**: `POST /rating/:orderId/rating`

**Body** (multipart/form-data):
```json
{
  "data": JSON.stringify({
    "ratings": [
      {
        "orderItemId": "string",
        "rating": "number (1-5)",
        "reviewText": "string",
        "images": ["filename1.jpg", "filename2.jpg"]
      }
    ]
  })
}
```

**Files**: `images` (opsional, upload gambar review)

**Response**:
- **200**: Rating berhasil disimpan
  ```json
  {
    "message": "✅ Rating berhasil disimpan.",
    "ratings": [{ "rating_data": "..." }]
  }
  ```
- **400**: Rating tidak valid atau sudah ada rating untuk item ini
- **401**: Harus login
- **403**: Tidak punya akses ke order ini
- **500**: Kesalahan server

**Fitur**:
- Validasi bahwa order sudah berstatus `diterima`.
- Upload gambar review ke Supabase storage.
- Snapshot produk disimpan untuk referensi.

---

### 4. Mendapatkan Semua Rating Pengguna
Mengambil semua rating yang diberikan oleh pengguna.

**Endpoint**: `GET /rating/all`

**Response**:
- **200**: Berhasil mengambil rating
  ```json
  {
    "message": "✅ {n} rating ditemukan",
    "ratings": [{ "rating_data": "..." }]
  }
  ```
- **500**: Kesalahan server

**Fitur**:
- Mengembalikan rating beserta balasan dari penjual (jika ada).

---

### 5. Mendapatkan Rating per Order
Mengambil rating untuk order tertentu.

**Endpoint**: `GET /order/:orderId`

**Response**:
- **200**: Berhasil mengambil rating
  ```json
  {
    "message": "✅ {n} rating untuk order {orderId}",
    "ratings": [{ "rating_data": "..." }]
  }
  ```
- **500**: Kesalahan server

---

### 6. Mendapatkan Data Seller
Mengambil daftar semua penjual beserta produk, rating rata-rata, total terjual, dan jumlah followers.

**Endpoint**: `GET /seller/allseller`

**Response**:
- **200**: Berhasil mengambil data
  ```json
  {
    "message": "✅ {n} seller berhasil diambil",
    "data": [
      {
        "seller": { "seller_data": "..." },
        "products": [{ "product_data": "..." }],
        "total_sold": "number",
        "average_rating": "string (2 decimal)",
        "total_reviews": "number",
        "total_followers": "number"
      }
    ]
  }
  ```
- **500**: Kesalahan server

**Fitur**:
- Cache selama 30 detik untuk performa.
- Mengembalikan produk dengan varian, rating rata-rata, dan jumlah followers.

---

### 7. Mendapatkan Seller Berdasarkan ID
Mengambil detail penjual berdasarkan ID, termasuk produk dan jumlah followers.

**Endpoint**: `GET /seller/:id`

**Response**:
- **200**: Berhasil mengambil data
  ```json
  {
    "message": "✅ Seller & {n} produk berhasil diambil",
    "seller": { "seller_data": "..." },
    "products": [{ "product_data": "..." }],
    "total_sold": "number",
    "total_followers": "number"
  }
  ```
- **404**: Seller tidak ditemukan
- **500**: Kesalahan server

---

### 8. Mendapatkan Rating Seller
Mengambil semua rating untuk produk milik penjual tertentu.

**Endpoint**: `GET /seller/:sellerId/ratings`

**Response**:
- **200**: Berhasil mengambil rating
  ```json
  {
    "message": "✅ Rating seller berhasil diambil.",
    "average_rating": "string (2 decimal)",
    "total_reviews": "number",
    "ratings": [{ "rating_data": "..." }]
  }
  ```
- **500**: Kesalahan server

---

### 9. Follow Seller
Mengikuti penjual tertentu.

**Endpoint**: `POST /seller/sellers/:id/follow`

**Response**:
- **200**: Berhasil follow
  ```json
  { "message": "✅ Berhasil follow seller." }
  ```
- **400**: Tidak bisa follow diri sendiri
- **401**: Harus login
- **500**: Kesalahan server

---

### 10. Unfollow Seller
Berhenti mengikuti penjual tertentu.

**Endpoint**: `DELETE /seller/sellers/:id/unfollow`

**Response**:
- **200**: Berhasil unfollow
  ```json
  { "message": "✅ Berhasil unfollow seller." }
  ```
- **401**: Harus login
- **500**: Kesalahan server

---

### 11. Mendapatkan Detail Produk
Mengambil detail produk berdasarkan ID, termasuk informasi penjual.

**Endpoint**: `GET /product/:id`

**Response**:
- **200**: Berhasil mengambil produk
  ```json
  {
    "message": "✅ Produk ditemukan",
    "product": { "product_data": "..." }
  }
  ```
- **404**: Produk tidak ditemukan
- **500**: Kesalahan server

**Fitur**:
- Cache untuk performa.
- Mengembalikan varian produk dan informasi penjual.

---

### 12. Mendapatkan Rating Produk
Mengambil semua rating untuk produk tertentu.

**Endpoint**: `GET /product/:productId/ratings`

**Response**:
- **200**: Berhasil mengambil rating
  ```json
  {
    "message": "✅ Rating produk berhasil diambil.",
    "average_rating": "number (2 decimal)",
    "total_reviews": "number",
    "ratings": [{ "rating_data": "..." }]
  }
  ```
- **500**: Kesalahan server

---

## Endpoint untuk Seller

### 1. Mendapatkan Semua Order
Mengambil semua order milik penjual.

**Endpoint**: `GET /order/seller/all`

**Response**:
- **200**: Berhasil mengambil order
  ```json
  {
    "message": "✅ Daftar order seller berhasil diambil.",
    "orders": [
      {
        "id": "string",
        "created_at": "datetime",
        "total_price": "number",
        "delivery_fee": "number",
        "status": "string",
        "pickup_method": "diantar|diambil|kedua",
        "confirm_deadline": "datetime",
        "order_items": [{ "item_data": "..." }],
        "total_quantity": "number",
        "buyer_info": { "buyer_data": "..." },
        "buyer_full_address": "string",
        "seller_info": { "seller_data": "..." },
        "seller_full_address": "string"
      }
    ]
  }
  ```
- **401**: Harus login sebagai seller
- **500**: Kesalahan server

**Fitur**:
- Cache selama 30 detik.
- Mengembalikan detail item, jumlah kuantitas, dan alamat pembeli/penjual.

---

### 2. Mendapatkan Detail Order
Mengambil detail order berdasarkan ID.

**Endpoint**: `GET /order/seller/:orderId`

**Response**:
- **200**: Berhasil mengambil order
  ```json
  {
    "message": "✅ Detail order seller berhasil diambil.",
    "order": { "order_data": "..." }
  }
  ```
- **401**: Harus login sebagai seller
- **404**: Order tidak ditemukan
- **500**: Kesalahan server

---

### 3. Update Status Order
Mengubah status order dengan validasi alur status.

**Endpoint**: `PUT /order/orders/:id/status`

**Body**:
```json
{
  "action": "accept|cancel|ready|ship|complete",
  "barcodeId": "string (opsional, untuk action complete pada pickup_method diambil)"
}
```

**Response**:
- **200**: Status berhasil diubah
  ```json
  {
    "message": "✅ Status order diubah ke '{newStatus}'",
    "order": { "order_data": "..." }
  }
  ```
- **400**: Aksi tidak valid atau status tidak sesuai alur
- **401**: Harus login sebagai seller
- **404**: Order tidak ditemukan
- **500**: Kesalahan server

**Fitur**:
- Validasi alur status (contoh: `pending` → `sedang di kemas` → `siap di ambil`/`sedang di antar` → `diterima`).
- Notifikasi email dikirim secara asinkronus.
- Update jumlah `terjual` produk saat status menjadi `diterima`.

---

### 4. Mendapatkan Profil Penjual
Mengambil profil penjual beserta daftar followers.

**Endpoint**: `GET /auth/profile/:id`

**Response**:
- **200**: Berhasil mengambil profil
  ```json
  {
    "seller": {
      "id": "string",
      "store_name": "string",
      "alamat_lengkap_combine": "string",
      "total_followers": "number",
      "followers": [{ "user_data": "..." }]
    }
  }
  ```
- **401**: Seller belum login
- **404**: Seller tidak ditemukan
- **500**: Kesalahan server

---

### 5. Membalas Rating
Membalas rating dari pembeli.

**Endpoint**: `POST /ratingseller/ratings/:id/reply`

**Body**:
```json
{
  "replyText": "string"
}
```

**Response**:
- **200**: Balasan berhasil
  ```json
  {
    "message": "✅ Balasan berhasil ditambahkan.",
    "reply": { "reply_data": "..." }
  }
  ```
- **400**: Balasan kosong atau rating sudah dibalas
- **401**: Harus login sebagai seller
- **403**: Rating bukan milik produk penjual
- **500**: Kesalahan server

---

### 6. Mendapatkan Semua Rating Penjual
Mengambil semua rating untuk produk milik penjual.

**Endpoint**: `GET /ratingseller/ratings`

**Response**:
- **200**: Berhasil mengambil rating
  ```json
  {
    "message": "✅ {n} rating ditemukan",
    "ratings": [{ "rating_data": "..." }]
  }
  ```
- **401**: Harus login sebagai seller
- **500**: Kesalahan server

---

### 7. Mendapatkan Rating Berdasarkan ID
Mengambil rating tertentu milik penjual.

**Endpoint**: `GET /ratingseller/ratings/:id`

**Response**:
- **200**: Berhasil mengambil rating
  ```json
  {
    "message": "✅ Rating ditemukan",
    "rating": { "rating_data": "..." }
  }
  ```
- **401**: Harus login sebagai seller
- **404**: Rating tidak ditemukan
- **500**: Kesalahan server

---

## Catatan Tambahan
- **Cache**: Digunakan untuk meningkatkan performa (produk, penjual, order).
- **Notifikasi**: Notifikasi email dikirim secara asinkronus untuk checkout dan perubahan status order.
- **Keamanan**:
  - Validasi captcha dan deteksi spam pada login dan checkout.
  - Pengecekan kepemilikan order dan rating untuk mencegah akses tidak sah.
- **Error Handling**: Semua endpoint mengembalikan pesan error yang jelas dengan kode status HTTP yang sesuai.

Untuk informasi lebih lanjut atau akses API, hubungi tim Backend Market.