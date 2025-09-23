# Dokumentasi API - Manajemen Pengguna, Keuangan, dan Sistem Pesanan

**URL Dasar**: `https://backendcihuyy.up.railway.app`

## Daftar Isi
1. [Autentikasi](#autentikasi)
   - [Registrasi](#post-authregister)
   - [Cek PIN Pengguna](#get-authusercheck-pinid)
   - [Ubah/Atur PIN](#post-authuserchange-pinid)
   - [Minta PIN melalui Email](#post-authuserrequest-pinid)
   - [Perbarui Pengguna](#put-authuserid)
2. [Keuangan](#keuangan)
   - [Penarikan Massal](#post-paymentuserwithdrawbatch)
   - [Dapatkan Riwayat Penarikan](#get-paymentuserwithdrawals)
   - [Dapatkan Riwayat Transaksi](#get-paymentusertransactions)
   - [Dapatkan Saldo](#get-paymentuserbalance)
3. [Sistem Pesanan](#sistem-pesanan)
   - [Checkout Keranjang](#post-ordercartcheckout)
   - [Hitung Biaya Pengiriman](#post-ordercartdelivery-fee)
   - [Konfirmasi Penerimaan Pesanan](#post-orderordersidconfirm-receive)
   - [Hapus Pesanan](#delete-orderordersid)
   - [Dapatkan Semua Pembayaran Tertunda](#get-orderallpendingpayments)
   - [Dapatkan Semua Pesanan](#get-orderall)
   - [Dapatkan Pesanan berdasarkan ID](#get-orderorderid)
4. [Penjual](#penjual)
   - [Autentikasi Penjual](#autentikasi-penjual)
     - [Dapatkan Profil Penjual](#get-seller-v1authprofileid)
     - [Minta PIN Penjual](#post-seller-v1authrequest-pinid)
     - [Ubah PIN Penjual](#post-seller-v1authchange-pinid)
     - [Perbarui Penjual](#put-seller-v1authupdateid)
   - [Keuangan Penjual](#keuangan-penjual)
     - [Penarikan Massal](#post-seller-v1paymentwithdrawbatch)
     - [Dapatkan Riwayat Penarikan](#get-seller-v1paymentwithdrawals)
     - [Dapatkan Riwayat Transaksi](#get-seller-v1paymenttransactions)
     - [Dapatkan Saldo](#get-seller-v1paymentbalance)
   - [Sistem Pesanan Penjual](#sistem-pesanan-penjual)
     - [Dapatkan Semua Pesanan Penjual](#get-seller-v1orderall)
     - [Dapatkan Pesanan Dibatalkan Penjual](#get-seller-v1ordercancelled)
     - [Dapatkan Pesanan Selesai Penjual](#get-seller-v1ordercompleted)
     - [Dapatkan Pesanan Penjual berdasarkan ID](#get-seller-v1orderorderid)
     - [Perbarui Status Pesanan](#put-seller-v1orderordersidstatus)

---

## Autentikasi
**Path Dasar**: `/auth`

### POST /auth/register
Mendaftarkan pengguna baru dengan opsi unggah avatar dan pengaturan PIN.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/auth/register`
- **Content-Type**: `multipart/form-data`
- **Body**:
  - `email` (string, wajib): Alamat email pengguna.
  - `password` (string, wajib): Kata sandi pengguna.
  - `username` (string, opsional): Nama pengguna. Jika tidak diberikan, diambil dari email.
  - `pin` (string, opsional): PIN 4-6 digit untuk saldo pengguna.
  - `avatar` (file, opsional): Gambar avatar pengguna.

**Respon:**
- **201 Created**:
  ```json
  { "message": "Pengguna dibuat. OTP dikirim ke email." }
  ```
- **400 Bad Request**:
  ```json
  { "error": "Email sudah digunakan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "error": "Terjadi kesalahan pada server." }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/auth/register \
  -F "email=user@example.com" \
  -F "password=secure123" \
  -F "username=john_doe" \
  -F "pin=123456" \
  -F "avatar=@/path/to/avatar.jpg"
```

### GET /auth/user/:id/check-pin
Memeriksa apakah pengguna telah mengatur PIN.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/auth/user/:id/check-pin`
- **Parameter**:
  - `id` (string, wajib): ID pengguna.

**Respon:**
- **200 OK**:
  ```json
  { "hasPin": true }
  ```
- **500 Internal Server Error**:
  ```json
  { "error": "Gagal memeriksa PIN." }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/auth/user/123/check-pin
```

### POST /auth/user/change-pin/:id
Mengubah atau mengatur PIN pengguna.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/auth/user/change-pin/:id`
- **Parameter**:
  - `id` (string, wajib): ID pengguna.
- **Body**:
  - `old_pin` (string, opsional): PIN saat ini (wajib jika PIN sudah ada).
  - `new_pin` (string, wajib): PIN baru 4-6 digit.

**Respon:**
- **200 OK**:
  ```json
  { "message": "✅ PIN berhasil diubah." }
  ```
- **400 Bad Request**:
  ```json
  { "error": "PIN baru diperlukan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "error": "Terjadi kesalahan server." }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/auth/user/change-pin/123 \
  -H "Content-Type: application/json" \
  -d '{"old_pin": "1234", "new_pin": "5678"}'
```

### POST /auth/user/request-pin/:id
Meminta PIN pengguna untuk dikirim melalui email.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/auth/user/request-pin/:id`
- **Parameter**:
  - `id` (string, wajib): ID pengguna.

**Respon:**
- **200 OK**:
  ```json
  { "message": "✅ PIN telah dikirim ke email." }
  ```
- **404 Not Found**:
  ```json
  { "error": "Pengguna tidak ditemukan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "error": "Terjadi kesalahan server." }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/auth/user/request-pin/123
```

### PUT /auth/user/:id
Memperbarui informasi pengguna, termasuk opsi unggah avatar.

**Permintaan:**
- **Metode**: PUT
- **URL**: `https://backendcihuyy.up.railway.app/auth/user/:id`
- **Parameter**:
  - `id` (string, wajib): ID pengguna.
- **Content-Type**: `multipart/form-data`
- **Body**:
  - `username` (string, opsional): Nama pengguna baru.
  - `password` (string, opsional): Kata sandi baru.
  - `nama_penerima` (string, opsional): Nama penerima.
  - `no_telepon` (string, opsional): Nomor telepon.
  - `alamat_lengkap` (string, opsional): Alamat lengkap.
  - `kode_pos` (string, opsional): Kode pos.
  - `provinsi_id` (string, opsional): ID provinsi.
  - `provinsi` (string, opsional): Nama provinsi.
  - `kota_id` (string, opsional): ID kota.
  - `kota` (string, opsional): Nama kota.
  - `kecamatan_id` (string, opsional): ID kecamatan.
  - `kecamatan` (string, opsional): Nama kecamatan.
  - `kelurahan_id` (string, opsional): ID kelurahan.
  - `kelurahan` (string, opsional): Nama kelurahan.
  - `bank_code` (string, opsional): Kode bank.
  - `account_holder_name` (string, opsional): Nama pemegang rekening.
  - `account_number` (string, opsional): Nomor rekening bank.
  - `avatar` (file, opsional): Gambar avatar baru.

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Pengguna berhasil diperbarui.",
    "user": { "id": "123", "email": "user@example.com", ... }
  }
  ```
- **500 Internal Server Error**:
  ```json
  { "error": "Gagal memperbarui pengguna.", "detail": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X PUT https://backendcihuyy.up.railway.app/auth/user/123 \
  -F "username=new_username" \
  -F "avatar=@/path/to/new_avatar.jpg"
```

---

## Keuangan
**Path Dasar**: `/paymentuser`

### POST /paymentuser/withdraw/batch
Memulai penarikan massal dari saldo pengguna.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/paymentuser/withdraw/batch`
- **Body**:
  - `user_id` (string, wajib): ID pengguna.
  - `amount` (number, wajib): Jumlah penarikan.
  - `bank_code` (string, wajib): Kode bank.
  - `account_number` (string, wajib): Nomor rekening bank.
  - `pin` (string, wajib): PIN pengguna.
  - `channel_properties` (object, opsional): Properti saluran tambahan.
  - `timestamp` (number, opsional): Waktu tanda tangan.
  - `signature` (string, wajib): Tanda tangan untuk validasi.

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "Penarikan disbursement dikirim ke Xendit (status sudah dimap ke DB).",
    "db_status": "pending",
    "disbursementPayload": {...},
    "xenditResponse": {...}
  }
  ```
- **400 Bad Request**:
  ```json
  { "error": "Field wajib untuk penarikan disbursement tidak lengkap" }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "Gagal memproses penarikan disbursement", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/paymentuser/withdraw/batch \
  -H "Content-Type: application/json" \
  -d '{"user_id": "123", "amount": 50000, "bank_code": "BCA", "account_number": "1234567890", "pin": "1234", "signature": "abc123"}'
```

### GET /paymentuser/withdrawals
Mengambil riwayat penarikan pengguna.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/paymentuser/withdrawals`
- **Parameter Kueri**:
  - `limit` (number, opsional): Jumlah rekaman yang dikembalikan (default: 20).
  - `offset` (number, opsional): Offset untuk paginasi (default: 0).
  - `status` (string, opsional): Filter berdasarkan status.

**Respon:**
- **200 OK**:
  ```json
  {
    "withdrawals": [...],
    "pagination": { "limit": 20, "offset": 0, "has_more": false, "total": 10 }
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai pengguna." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Gagal mengambil riwayat penarikan." }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/paymentuser/withdrawals?limit=10&offset=0
```

### GET /paymentuser/transactions
Mengambil riwayat transaksi pengguna.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/paymentuser/transactions`
- **Parameter Kueri**:
  - `limit` (number, opsional): Jumlah rekaman yang dikembalikan (default: 20).
  - `offset` (number, opsional): Offset untuk paginasi (default: 0).
  - `type` (string, opsional): Filter berdasarkan jenis transaksi.

**Respon:**
- **200 OK**:
  ```json
  {
    "transactions": [...],
    "pagination": { "limit": 20, "offset": 0, "has_more": false, "total": 10 }
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai pengguna." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Gagal mengambil riwayat transaksi." }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/paymentuser/transactions?limit=10&type=withdrawal
```

### GET /paymentuser/balance
Mengambil informasi saldo pengguna.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/paymentuser/balance`

**Respon:**
- **200 OK**:
  ```json
  {
    "balance": {
      "total": 100000,
      "withdrawable": 100000,
      "pending": 0
    }
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai pengguna." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Gagal mengambil data saldo." }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/paymentuser/balance
```

---

## Sistem Pesanan
**Path Dasar**: `/order`

### POST /order/cart/checkout
Melakukan checkout item dari keranjang.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/order/cart/checkout`
- **Body**:
  - `itemsToCheckout` (array, wajib): Daftar item untuk checkout (`productId`, `variantId`, `qty`).
  - `pickupMethod` (string, opsional): Metode pengambilan (`diantar` atau `diambil`).
  - `address` (object, opsional): Detail alamat pengiriman.
  - `paymentMethod` (string, wajib): Metode pembayaran (`cod`, `digital`, `balance`).
  - `selectedPaymentChannel` (string, opsional): Saluran pembayaran untuk pembayaran digital.
  - `pin` (string, opsional): PIN untuk pembayaran saldo.

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Berhasil checkout 1 pesanan. Semua item siap diproses!",
    "orders": [...],
    "delivery_stats": {...}
  }
  ```
- **400 Bad Request**:
  ```json
  { "message": "⚠️ Tidak ada item untuk di-checkout." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/order/cart/checkout \
  -H "Content-Type: application/json" \
  -d '{"itemsToCheckout": [{"productId": "1", "variantId": "2", "qty": 1}], "pickupMethod": "diantar", "paymentMethod": "digital", "selectedPaymentChannel": "BCA"}'
```

### POST /order/cart/delivery-fee
Menghitung biaya pengiriman untuk item keranjang.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/order/cart/delivery-fee`
- **Body**:
  - `itemsToCheckout` (array, wajib): Daftar item (`productId`, `variantId`, `qty`).
  - `pickupMethod` (string, opsional): Metode pengambilan (`diantar` atau `diambil`).

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Data checkout berhasil dihitung.",
    "sellers": [...],
    "total_produk_semua": 100000,
    "total_ongkir_semua": 10000,
    "total_checkout_semua": 110000,
    "delivery_stats": {...},
    "payment_methods": {...}
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login dulu." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server.", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/order/cart/delivery-fee \
  -H "Content-Type: application/json" \
  -d '{"itemsToCheckout": [{"productId": "1", "variantId": "2", "qty": 1}], "pickupMethod": "diantar"}'
```

### POST /order/orders/:id/confirm-receive
Mengkonfirmasi penerimaan pesanan.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/order/orders/:id/confirm-receive`
- **Parameter**:
  - `id` (string, wajib): ID pesanan.

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Pesanan berhasil dikonfirmasi diterima.",
    "order": {...}
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/order/orders/123/confirm-receive
```

### DELETE /order/orders/:id
Menghapus pesanan yang telah selesai.

**Permintaan:**
- **Metode**: DELETE
- **URL**: `https://backendcihuyy.up.railway.app/order/orders/:id`
- **Parameter**:
  - `id` (string, wajib): ID pesanan.

**Respon:**
- **200 OK**:
  ```json
  { "message": "✅ Pesanan dan item pesanan berhasil dihapus. Rating tetap aman." }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X DELETE https://backendcihuyy.up.railway.app/order/orders/123
```

### GET /order/allpendingpayments
Mengambil semua pesanan dengan pembayaran digital tertunda.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/order/allpendingpayments`

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Daftar pembayaran tertunda berhasil diambil.",
    "data": [...]
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login untuk melihat daftar pembayaran tertunda." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/order/allpendingpayments
```

### GET /order/all
Mengambil semua pesanan untuk pengguna.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/order/all`

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Daftar pesanan berhasil diambil.",
    "orders": [...]
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login untuk melihat daftar pesanan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/order/all
```

### GET /order/:orderId
Mengambil detail pesanan tertentu.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/order/:orderId`
- **Parameter**:
  - `orderId` (string, wajib): ID pesanan.

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Detail pesanan berhasil diambil.",
    "order": {...}
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login untuk melihat detail pesanan." }
  ```
- **404 Not Found**:
  ```json
  { "message": "❌ Pesanan tidak ditemukan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/order/123
```

---

## Penjual
**Path Dasar**: `/seller/V1`

### Autentikasi Penjual
**Path Dasar**: `/seller/V1/auth`

#### GET /seller/V1/auth/profile/:id
Mengambil profil penjual, total pengikut, dan informasi rekening bank (tanpa PIN).

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/auth/profile/:id`
- **Parameter**:
  - `id` (string, wajib): ID penjual (atau kosongkan untuk menggunakan ID penjual yang terautentikasi dari cookie).

**Respon:**
- **200 OK**:
  ```json
  {
    "seller": {
      "id": "123",
      "alamat_lengkap_combine": "Alamat Toko, Kelurahan, Kecamatan, Kota",
      "total_followers": 100,
      "followers": [{ "id": "user1", "username": "user1", "email": "user1@example.com", ... }],
      "bank_info": { "bank_code": "BCA", "account_number": "1234567890", "account_holder_name": "John Doe" }
    }
  }
  ```
- **401 Unauthorized**:
  ```json
  { "error": "Penjual belum login." }
  ```
- **400 Bad Request**:
  ```json
  { "error": "Cookie penjual tidak valid." }
  ```
- **404 Not Found**:
  ```json
  { "error": "Penjual tidak ditemukan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "error": "Terjadi kesalahan server." }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/seller/V1/auth/profile/123
```

#### POST /seller/V1/auth/request-pin/:id
Meminta PIN penjual untuk dikirim melalui email.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/auth/request-pin/:id`
- **Parameter**:
  - `id` (string, wajib): ID penjual.

**Respon:**
- **200 OK**:
  ```json
  { "message": "✅ PIN telah dikirim ke email Anda." }
  ```
- **401 Unauthorized**:
  ```json
  { "error": "❌ Harus login sebagai penjual." }
  ```
- **403 Forbidden**:
  ```json
  { "error": "❌ Tidak diizinkan." }
  ```
- **404 Not Found**:
  ```json
  { "error": "PIN tidak ditemukan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "error": "Terjadi kesalahan server." }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/seller/V1/auth/request-pin/123
```

#### POST /seller/V1/auth/change-pin/:id
Mengubah atau mengatur PIN penjual.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/auth/change-pin/:id`
- **Parameter**:
  - `id` (string, wajib): ID penjual.
- **Body**:
  - `old_pin` (string, wajib): PIN saat ini.
  - `new_pin` (string, wajib): PIN baru 4-6 digit.

**Respon:**
- **200 OK**:
  ```json
  { "message": "✅ PIN berhasil diubah." }
  ```
- **400 Bad Request**:
  ```json
  { "error": "PIN lama dan PIN baru diperlukan." }
  ```
- **401 Unauthorized**:
  ```json
  { "error": "❌ Harus login sebagai penjual." }
  ```
- **403 Forbidden**:
  ```json
  { "error": "❌ Tidak diizinkan." }
  ```
- **404 Not Found**:
  ```json
  { "error": "Data penjual tidak ditemukan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "error": "Terjadi kesalahan server." }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/seller/V1/auth/change-pin/123 \
  -H "Content-Type: application/json" \
  -d '{"old_pin": "1234", "new_pin": "5678"}'
```

#### PUT /seller/V1/auth/update/:id
Memperbarui informasi penjual, termasuk opsi unggah gambar toko.

**Permintaan:**
- **Metode**: PUT
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/auth/update/:id`
- **Parameter**:
  - `id` (string, wajib): ID penjual.
- **Content-Type**: `multipart/form-data`
- **Body**:
  - `name` (string, opsional): Nama penjual.
  - `business_name` (string, opsional): Nama bisnis.
  - `phone` (string, opsional): Nomor telepon.
  - `store_name` (string, opsional): Nama toko.
  - `store_address` (string, opsional): Alamat toko.
  - `provinsi_id` (string, opsional): ID provinsi.
  - `kabupaten_id` (string, opsional): ID kabupaten/kota.
  - `kecamatan_id` (string, opsional): ID kecamatan.
  - `kelurahan_id` (string, opsional): ID kelurahan.
  - `latitude` (number, opsional): Latitude toko.
  - `longitude` (number, opsional): Longitude toko.
  - `role` (string, opsional): Peran penjual.
  - `is_delivery_available` (boolean, opsional): Ketersediaan pengiriman.
  - `delivery_fee` (number, opsional): Biaya pengiriman.
  - `bank_code` (string, opsional): Kode bank.
  - `account_holder_name` (string, opsional): Nama pemegang rekening.
  - `account_number` (string, opsional): Nomor rekening bank.
  - `store_image_url` (file, opsional): Gambar toko.

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Data penjual berhasil diperbarui",
    "seller": {...},
    "balance": {...}
  }
  ```
- **401 Unauthorized**:
  ```json
  { "error": "❌ Harus login sebagai penjual." }
  ```
- **403 Forbidden**:
  ```json
  { "error": "❌ Tidak diizinkan." }
  ```
- **400 Bad Request**:
  ```json
  { "error": "Upload gambar gagal", "detail": "Pesan kesalahan" }
  ```
- **500 Internal Server Error**:
  ```json
  { "error": "Terjadi kesalahan server." }
  ```

**Contoh**:
```bash
curl -X PUT https://backendcihuyy.up.railway.app/seller/V1/auth/update/123 \
  -F "name=John Doe" \
  -F "store_image_url=@/path/to/store_image.webp"
```

---

### Keuangan Penjual
**Path Dasar**: `/seller/V1/payment`

#### POST /seller/V1/payment/withdraw/batch
Memulai penarikan massal dari saldo penjual.

**Permintaan:**
- **Metode**: POST
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/payment/withdraw/batch`
- **Body**:
  - `seller_id` (string, wajib): ID penjual.
  - `amount` (number, wajib): Jumlah penarikan.
  - `bank_code` (string, wajib): Kode bank.
  - `account_number` (string, wajib): Nomor rekening bank.
  - `channel_properties` (object, opsional): Properti saluran tambahan (contoh: `account_holder_name`).
  - `timestamp` (number, opsional): Waktu tanda tangan.
  - `signature` (string, wajib): Tanda tangan untuk validasi.

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "Penarikan disbursement dikirim ke Xendit (status sudah dimap ke DB).",
    "db_status": "pending",
    "disbursementPayload": {...},
    "xenditResponse": {...}
  }
  ```
- **400 Bad Request**:
  ```json
  { "error": "Field wajib untuk penarikan disbursement tidak lengkap" }
  ```
- **401 Unauthorized**:
  ```json
  { "error": "Tanda tangan tidak valid" }
  ```
- **404 Not Found**:
  ```json
  { "error": "Penjual tidak ditemukan" }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "Gagal memproses penarikan disbursement", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X POST https://backendcihuyy.up.railway.app/seller/V1/payment/withdraw/batch \
  -H "Content-Type: application/json" \
  -d '{"seller_id": "123", "amount": 50000, "bank_code": "BCA", "account_number": "1234567890", "signature": "abc123"}'
```

#### GET /seller/V1/payment/withdrawals
Mengambil riwayat penarikan penjual.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/payment/withdrawals`
- **Parameter Kueri**:
  - `limit` (number, opsional): Jumlah rekaman yang dikembalikan (default: 20).
  - `offset` (number, opsional): Offset untuk paginasi (default: 0).
  - `status` (string, opsional): Filter berdasarkan status.

**Respon:**
- **200 OK**:
  ```json
  {
    "withdrawals": [
      {
        "id": "123",
        "amount": 50000,
        "status": "pending",
        "created_at": "2025-09-23T17:05:00Z",
        "bank_info": { "code": "BCA", "holder_name": "John Doe", "number": "****7890" },
        "xendit_id": "disb-123",
        "transaction": {...}
      }
    ],
    "pagination": { "limit": 20, "offset": 0, "has_more": false, "total": 1 }
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai penjual." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Gagal mengambil riwayat penarikan." }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/seller/V1/payment/withdrawals?limit=10&offset=0
```

#### GET /seller/V1/payment/transactions
Mengambil riwayat transaksi penjual.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/payment/transactions`
- **Parameter Kueri**:
  - `limit` (number, opsional): Jumlah rekaman yang dikembalikan (default: 20).
  - `offset` (number, opsional): Offset untuk paginasi (default: 0).
  - `type` (string, opsional): Filter berdasarkan jenis transaksi.

**Respon:**
- **200 OK**:
  ```json
  {
    "transactions": [
      {
        "id": "123",
        "amount": -50000,
        "type": "withdrawal",
        "timestamp": "2025-09-23T17:05:00Z",
        "metadata": {...},
        "signature": "abc123"
      }
    ],
    "pagination": { "limit": 20, "offset": 0, "has_more": false, "total": 1 }
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai penjual." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Gagal mengambil riwayat transaksi." }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/seller/V1/payment/transactions?limit=10&type=withdrawal
```

#### GET /seller/V1/payment/balance
Mengambil informasi saldo penjual.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/payment/balance`

**Respon:**
- **200 OK**:
  ```json
  {
    "balance": {
      "total": 100000,
      "withdrawable": 100000,
      "pending": 0
    }
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai penjual." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Gagal mengambil data saldo." }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/seller/V1/payment/balance
```

---

### Sistem Pesanan Penjual
**Path Dasar**: `/seller/V1/order`

#### GET /seller/V1/order/all
Mengambil semua pesanan untuk penjual, kecuali yang dibatalkan atau diterima oleh pembeli.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/order/all`

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Daftar pesanan penjual berhasil diambil.",
    "orders": [
      {
        "id": "123",
        "created_at": "2025-09-23T17:05:00Z",
        "total_price": 100000,
        "delivery_fee": 10000,
        "status": "pending",
        "pickup_method": "diantar",
        "buyer_info": {...},
        "buyer_full_address": "Alamat, Kelurahan, Kecamatan, Kota, Provinsi, Kode Pos",
        "seller_info": {...},
        "seller_full_address": "Alamat Toko, Kelurahan, Kecamatan, Kota, Provinsi",
        "order_items": [...],
        "total_quantity": 2,
        "can_process": true
      }
    ]
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai penjual untuk melihat daftar pesanan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/seller/V1/order/all
```

#### GET /seller/V1/order/cancelled
Mengambil semua pesanan penjual yang dibatalkan.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/order/cancelled`

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Daftar pesanan dibatalkan penjual berhasil diambil.",
    "orders": [
      {
        "id": "123",
        "created_at": "2025-09-23T17:05:00Z",
        "total_price": 100000,
        "delivery_fee": 10000,
        "status": "dibatalkan",
        "pickup_method": "diantar",
        "buyer_info": {...},
        "buyer_full_address": "Alamat, Kelurahan, Kecamatan, Kota, Provinsi, Kode Pos",
        "seller_info": {...},
        "seller_full_address": "Alamat Toko, Kelurahan, Kecamatan, Kota, Provinsi",
        "order_items": [...],
        "total_quantity": 2,
        "can_process": false
      }
    ]
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai penjual untuk melihat daftar pesanan dibatalkan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/seller/V1/order/cancelled
```

#### GET /seller/V1/order/completed
Mengambil semua pesanan penjual yang telah selesai (diterima oleh pembeli).

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/order/completed`

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Daftar pesanan selesai penjual berhasil diambil.",
    "orders": [
      {
        "id": "123",
        "created_at": "2025-09-23T17:05:00Z",
        "total_price": 100000,
        "delivery_fee": 10000,
        "status": "diterima oleh pembeli",
        "pickup_method": "diantar",
        "buyer_info": {...},
        "buyer_full_address": "Alamat, Kelurahan, Kecamatan, Kota, Provinsi, Kode Pos",
        "seller_info": {...},
        "seller_full_address": "Alamat Toko, Kelurahan, Kecamatan, Kota, Provinsi",
        "order_items": [...],
        "total_quantity": 2,
        "can_process": false
      }
    ]
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai penjual untuk melihat daftar pesanan selesai." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/seller/V1/order/completed
```

#### GET /seller/V1/order/:orderId
Mengambil detail pesanan penjual tertentu.

**Permintaan:**
- **Metode**: GET
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/order/:orderId`
- **Parameter**:
  - `orderId` (string, wajib): ID pesanan.

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Detail pesanan penjual berhasil diambil.",
    "order": {
      "id": "123",
      "created_at": "2025-09-23T17:05:00Z",
      "total_price": 100000,
      "delivery_fee": 10000,
      "status": "pending",
      "pickup_method": "diantar",
      "buyer_info": {...},
      "buyer_full_address": "Alamat, Kelurahan, Kecamatan, Kota, Provinsi, Kode Pos",
      "seller_info": {...},
      "seller_full_address": "Alamat Toko, Kelurahan, Kecamatan, Kota, Provinsi",
      "order_items": [...],
      "total_quantity": 2,
      "can_process": true
    }
  }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai penjual." }
  ```
- **404 Not Found**:
  ```json
  { "message": "❌ Pesanan tidak ditemukan." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X GET https://backendcihuyy.up.railway.app/seller/V1/order/123
```

#### PUT /seller/V1/order/orders/:id/status
Memperbarui status pesanan.

**Permintaan:**
- **Metode**: PUT
- **URL**: `https://backendcihuyy.up.railway.app/seller/V1/order/orders/:id/status`
- **Parameter**:
  - `id` (string, wajib): ID pesanan.
- **Body**:
  - `action` (string, wajib): Aksi untuk status pesanan (`accept`, `cancel`, `ready`, `ship`, `complete`).
  - `barcodeId` (string, opsional): ID barcode untuk konfirmasi pengambilan (diperlukan untuk `complete` dengan metode `diambil`).
  - `awb_number` (string, opsional): Nomor resi pengiriman (diperlukan untuk `ship` dengan metode `diantar`).

**Respon:**
- **200 OK**:
  ```json
  {
    "message": "✅ Status pesanan berhasil diubah ke 'sedang di kemas'",
    "order": {...},
    "processing_time": "0.25s",
    "pdf_available": true
  }
  ```
- **400 Bad Request**:
  ```json
  { "message": "⚠️ Aksi tidak valid untuk pesanan ini." }
  ```
- **401 Unauthorized**:
  ```json
  { "message": "❌ Harus login sebagai penjual." }
  ```
- **500 Internal Server Error**:
  ```json
  { "message": "❌ Terjadi kesalahan server.", "error": "Pesan kesalahan" }
  ```

**Contoh**:
```bash
curl -X PUT https://backendcihuyy.up.railway.app/seller/V1/order/orders/123/status \
  -H "Content-Type: application/json" \
  -d '{"action": "accept"}'
```