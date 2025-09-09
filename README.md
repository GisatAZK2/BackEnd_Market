# README: API Backend untuk Sistem E-Commerce (Checkout, Delivery Fee, dan Trending Products)

## Deskripsi
API ini dibangun menggunakan Express.js dan terintegrasi dengan Supabase sebagai database. API ini menangani tiga endpoint utama:
- **POST /cart/checkout**: Menangani proses checkout barang dari keranjang belanja, termasuk pembuatan order, validasi alamat, perhitungan biaya pengiriman, dan penghapusan item dari keranjang.
- **POST /cart/delivery-fee**: Menghitung biaya pengiriman berdasarkan item yang dipilih, metode pengambilan, dan ketersediaan pengiriman dari seller.
- **GET /trending**: Mengambil daftar produk trending berdasarkan kategori acak atau riwayat pencarian pengguna (dari cookie), dengan personalisasi sederhana.

Endpoint pertama dan kedua menggunakan base URL: `https://backendcihuyy.up.railway.app/order`.  
Endpoint ketiga menggunakan base URL: `https://sharecihuy.sytes.net/product`.

**Catatan Penting**:
- Gunakan cookie untuk menyimpan informasi Trendig produk by seller (misalnya `user_info` dan `user_search_history`).


## Endpoint API

### 1. POST /cart/checkout
**URL Lengkap**: `https://backendcihuyy.up.railway.app/order/cart/checkout`  
**Deskripsi**: Memproses checkout dari keranjang belanja. Validasi user, alamat, item, dan buat order per seller. Hapus item dari cart setelah sukses.  
**Header**:  
- Content-Type: application/json  
- Cookie: user_info (JSON user data), user_search_history (opsional).  

**Body Request (JSON)**:  
```json
{
  "itemsToCheckout": [
    {
      "productId": "uuid-product",
      "variantId": "uuid-variant" (opsional),
      "qty": 2,
      "pickupMethod": "diantar" atau "diambil" (opsional)
    }
  ],
  "pickupMethod": "diantar" (global override, opsional),
  "address": {  // Opsional, jika update alamat
    "nama_penerima": "Nama Penerima",
    "no_telepon": "08123456789",
    "alamat_lengkap": "Alamat lengkap",
    "kode_pos": "12345",
    "provinsi_id": 1,
    "kota_id": 2,
    "kecamatan_id": 3,
    "kelurahan_id": 4
  }
}
```

**Response Sukses (200)**:  
```json
{
  "message": "✅ Berhasil checkout 1 order. Semua item siap diproses! (⏱ 0.5s)",
  "orders": [
    {
      "id": "uuid-order",
      "user_id": "uuid-user",
      "seller_id": "uuid-seller",
      "pickup_method": "diantar",
      "status": "pending",
      "total_price": 150000,
      "delivery_fee": 10000,
      "buyer_address": { ... }
    }
  ],
  "delivery_stats": {
    "total_items": 2,
    "pickup_only_items": 0,
    "delivery_available_items": 2
  }
}
```

**Response Error (400/500)**:  
```json
{
  "message": "⚠️ Tidak ada item untuk di-checkout."
}
```

### 2. POST /cart/delivery-fee
**URL Lengkap**: `https://backendcihuyy.up.railway.app/order/cart/delivery-fee`  
**Deskripsi**: Menghitung biaya pengiriman dan total checkout berdasarkan item dan metode. Grup per seller dan metode.  
**Header**: Content-Type: application/json  

**Body Request (JSON)**:  
```json
{
  "itemsToCheckout": [
    {
      "productId": "uuid-product",
      "variantId": "uuid-variant" (opsional),
      "qty": 1,
      "pickupMethod": "diantar" (opsional)
    }
  ],
  "pickupMethod": "diantar" (global, opsional)
}
```

**Response Sukses (200)**:  
```json
{
  "message": "✅ Data checkout berhasil dihitung.",
  "sellers": [
    {
      "seller_id": "uuid-seller",
      "store_name": "Toko ABC",
      "pickup_method": "diantar",
      "total_produk": 100000,
      "delivery_fee": 10000,
      "delivery_note": "bisa diantar",
      "delivery_status": "delivery_available",
      "item_count": 1,
      "total_semua": 110000
    }
  ],
  "total_produk_semua": 100000,
  "total_ongkir_semua": 10000,
  "total_checkout_semua": 110000,
  "delivery_stats": {
    "total_items": 1,
    "pickup_only_items": 0,
    "delivery_available_items": 1,
    "message": "✅ Semua item bisa diantar"
  }
}
```

**Response Error (400/500)**:  
```json
{
  "message": "⚠️ Tidak ada item untuk dihitung biaya kirim."
}
```

### 3. GET /trending
**URL Lengkap**: `https://sharecihuy.sytes.net/product/trending`  
**Deskripsi**: Mengambil produk trending dengan personalisasi berdasarkan riwayat pencarian (dari cookie). 60% dari kategori utama (acak atau dari history), 40% dari lainnya. Gunakan seedrandom untuk stabilitas harian.  
**Header**: Cookie: user_search_history (array string pencarian, opsional).  

**Parameter Query**: Tidak ada (GET).  

**Response Sukses (200)**:  
```json
{
  "message": "🔥 Trending personal berdasarkan riwayat search Anda di kategori \"Elektronik\" (60%) + kategori lain (40%)",
  "date": "2025-09-09",
  "total": 20,
  "main_category": "Elektronik",
  "personalized": true,
  "search_keywords_used": ["laptop", "hp"],
  "products": [
    {
      "id": "uuid-product",
      "product_name": "Produk A",
      "price": 100000,
      "final_price": 90000,
      "discount_percentage": 10,
      "avg_rating": 4.5,
      "total_ratings": 10,
      "variants": [ ... ]
    }
  ]
}
```

**Response Error (404/500)**:  
```json
{
  "message": "❌ Tidak ada kategori tersedia"
}
```

## Contoh Kasus Penggunaan (Use Cases)

### Kasus 1: Checkout Barang dengan Pengiriman
- **Skenario**: User logged in, punya item di cart yang memerlukan pengiriman. Alamat belum lengkap, jadi kirim address baru di body.
- **Langkah**:
  1. Kirim POST ke `/cart/checkout` dengan itemsToCheckout dan address.
  2. API validasi alamat, update user, buat order, hitung delivery fee, kirim email notif.
- **Hasil Diharapkan**: Order dibuat, item dihapus dari cart, response dengan stats delivery.
- **Potensi Error**: Jika alamat tidak lengkap → 400 dengan `needUpdateAddress: true`.

### Kasus 2: Hitung Biaya Pengiriman Sebelum Checkout
- **Skenario**: User ingin preview total sebelum checkout, termasuk ongkir.
- **Langkah**:
  1. Kirim POST ke `/cart/delivery-fee` dengan itemsToCheckout.
  2. API grup per seller, hitung fee berdasarkan is_delivery_available.
- **Hasil Diharapkan**: Response dengan breakdown per seller dan grand total, plus stats jika ada item pickup-only.
- **Potensi Error**: Jika seller tidak support delivery tapi dipilih "diantar" → delivery_note: "tidak bisa diantar".

### Kasus 3: Tampilkan Produk Trending Personal
- **Skenario**: User punya riwayat pencarian ["laptop", "hp"], cookie user_search_history diset.
- **Langkah**:
  1. Kirim GET ke `/trending`.
  2. API parse cookie, match kategori (misal "Elektronik"), pilih 60% dari sana, 40% random lain.
- **Hasil Diharapkan**: Produk trending personal, stabil sepanjang hari berkat seedrandom.
- **Potensi Error**: Jika tidak ada produk → 404. Fallback ke random jika history kosong.

### Kasus 4: Checkout dengan Item Pickup-Only
- **Skenario**: Beberapa seller tidak support delivery, tapi user pilih "diantar".
- **Langkah**: Checkout seperti biasa.
- **Hasil Diharapkan**: Order dibuat dengan delivery_fee=0, message warning di response, dan notif email dengan pickup_only_note.

## Catatan Tambahan
- **Caching**: Digunakan untuk produk dan seller agar efisien.
- **Async Operations**: Email dan snapshot item dilakukan di background agar tidak blok response.
- **Keamanan**: Gunakan HTTPS, validasi input, dan middleware anti-spam.
- **Testing**: Gunakan tools seperti Postman untuk test endpoint dengan cookie.
- **Kontribusi**: Jika ada bug, buka issue atau PR.

Dibuat pada September 2025. Hubungi developer untuk update.