# Dokumentasi API Backend

Selamat datang di dokumentasi API Backend untuk aplikasi e-commerce. API ini menggunakan endpoint dengan basis URL `backencihuyy.up.railway.app`. Rute untuk seller menggunakan prefix `/seller/v1`, sedangkan rute untuk pembeli tidak menggunakan prefix. Berikut adalah penjelasan mengenai rute-rute utama yang telah diperbarui, termasuk penambahan field seperti `bankCode`, `pin`, dan lainnya, serta contoh request dan script Postman untuk bagian keuangan.

## Daftar Isi
1. [Rute Seller](#rute-seller)
   - [Update Seller](#update-seller)
   - [Pendaftaran Seller](#pendaftaran-seller)
   - [Update Status Order](#update-status-order)
   - [Keuangan Seller](#keuangan-seller)
2. [Rute Pembeli](#rute-pembeli)
   - [Checkout](#checkout)
   - [Keuangan Pembeli](#keuangan-pembeli)
   - [Update User](#update-user)

## Rute Seller

### Update Seller
**Endpoint**: `PUT /seller/v1/auth/seller/update/:id`  
**Deskripsi**: Mengupdate data seller, termasuk informasi toko, alamat, dan data bank. Mendukung upload gambar toko dan validasi PIN serta data bank.  
**Fitur Baru**:
- Penambahan field `bankCode`, `pin`, `accountHolderName`, dan `accountNumber`.
- Validasi PIN (4-6 digit).
- Validasi data bank harus diisi bersama-sama jika salah satu disediakan.
- Sinkronisasi `seller_name` ke tabel `products` jika nama diubah.

**Contoh Request Body**:
```json
{
  "email": "seller@example.com",
  "name": "Nama Seller",
  "business_name": "Nama Bisnis",
  "phone": "081234567890",
  "store_name": "Toko Seller",
  "store_address": "Jl. Contoh No. 123",
  "provinsi_id": "1",
  "kabupaten_id": "101",
  "kecamatan_id": "1001",
  "kelurahan_id": "10001",
  "latitude": "-6.123456",
  "longitude": "106.123456",
  "is_delivery_available": "true",
  "delivery_fee": "15000",
  "pin": "123456",
  "bankCode": "BCA",
  "accountHolderName": "Nama Pemilik Rekening",
  "accountNumber": "1234567890"
}
```
**Catatan**:
- File gambar toko diunggah melalui `store_image_url` menggunakan `multipart/form-data`.
- Validasi wilayah memastikan urutan pengisian (`provinsi_id` → `kabupaten_id` → `kecamatan_id` → `kelurahan_id`).

### Pendaftaran Seller
**Endpoint**: `POST /seller/v1/forum-pendaftaran/seller`  
**Deskripsi**: Mendaftarkan seller baru, termasuk informasi toko, alamat, dan data bank. Menggunakan upload gambar toko dan pengiriman OTP untuk verifikasi email.  
**Fitur Baru**:
- Penambahan field `pin`, `bankCode`, `accountHolderName`, dan `accountNumber` sebagai wajib.
- Validasi PIN (4-6 digit).
- Validasi semua field wajib, termasuk koordinat dan data bank.

**Contoh Request Body**:
```json
{
  "email": "new.seller@example.com",
  "name": "Nama Seller",
  "businessName": "Nama Bisnis",
  "phone": "081234567890",
  "storeName": "Toko Baru",
  "storeAddress": "Jl. Baru No. 1",
  "provinsi_id": "1",
  "kota_id": "101",
  "kecamatan_id": "1001",
  "kelurahan_id": "10001",
  "latitude": "-6.123456",
  "longitude": "106.123456",
  "is_delivery_available": "true",
  "delivery_fee": "15000",
  "password": "P@ssw0rd123",
  "pin": "123456",
  "bankCode": "BCA",
  "accountHolderName": "Nama Pemilik",
  "accountNumber": "1234567890"
}
```
**Catatan**:
- Gambar toko diunggah melalui `storeImage` menggunakan `multipart/form-data`.
- Password harus memenuhi kriteria keamanan (min. 8 karakter, huruf besar, kecil, angka, dan simbol).

### Update Status Order
**Endpoint**: `PUT /seller/v1/order/orders/:id/status`  
**Deskripsi**: Mengupdate status pesanan seller dengan validasi alur status dan penanganan refund serta pengembalian stok untuk pembatalan.  
**Fitur Baru**:
- Penambahan logika refund otomatis saat pembatalan untuk pembayaran digital.
- Pengembalian stok produk/varian saat status menjadi `dibatalkan`.
- Notifikasi email dengan detail produk dan alamat seller.

**Contoh Request Body**:
```json
{
  "action": "accept",
  "barcodeId": "12345",
  "awb_number": "TRX123456789"
}
```
**Aksi yang Didukung**:
- `accept`: Menerima pesanan (dari `pending` atau `processing`).
- `cancel`: Membatalkan pesanan (dengan refund jika sudah dibayar).
- `ready`: Menandakan pesanan siap diambil (untuk `pickup_method: diambil`).
- `ship`: Mengirim pesanan (untuk `pickup_method: diantar`).
- `complete`: Menyelesaikan pesanan (dari `siap di ambil` atau `sedang di antar`).

**Catatan**:
- Validasi alur status memastikan transisi yang valid (misalnya, dari `pending` hanya ke `sedang di kemas` atau `dibatalkan`).
- Cache digunakan untuk mengurangi query database.

### Keuangan Seller
**Endpoint**:
- `POST /seller/v1/payment/withdraw/batch`: Melakukan penarikan saldo seller ke rekening bank.
- `GET /seller/v1/payment/withdrawals`: Mengambil riwayat penarikan saldo.
- `GET /seller/v1/payment/transactions`: Mengambil riwayat transaksi saldo.
- `GET /seller/v1/payment/balance`: Mengambil informasi saldo seller.
- `POST /seller/v1/payment/set-pin`: Mengatur atau mengubah PIN seller.

**Fitur Baru**:
- Penarikan saldo menggunakan Xendit dengan validasi PIN dan signature.
- Penyimpanan riwayat transaksi dan penarikan di tabel `seller_balance_transactions` dan `seller_withdrawals`.
- Validasi PIN (4-6 digit) dan otorisasi menggunakan `seller_info` dari cookies.

**Contoh Request Body (Withdraw)**:
```json
{
  "seller_id": "{{seller_id}}",
  "amount": {{amount}},
  "bank_code": "{{bank_code}}",
  "account_number": "{{account_number}}",
  "channel_properties": {
    "account_holder_name": "{{account_holder_name}}"
  },
  "timestamp": {{timestamp}},
  "signature": "{{signature}}"
}
```

**Script Postman untuk Withdraw Seller**:
```javascript
// Fungsi stableStringify (harus sama dengan di backend)
function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",")}}`;
}

// === Data request ===
const sellerId = "34882968-93c6-4408-9619-8ebbd022fe27";        // ganti sesuai DB / cookies
const amount = 3000;                 // contoh nominal
const bankCode = "BNI";            // contoh kode bank
const accountNumber = "1234567890";   // contoh nomor rekening
const accountHolderName = "Amba Dev"; // contoh nama
const ts = Date.now();

// payload untuk signature
const payload = {
  sellerId,
  amount,
  bankCode,
  accountNumber,
  accountHolderName,
  timestamp: ts
};

const jsonPayload = stableStringify(payload);

// ambil secret dari environment variable Postman
const secret = pm.environment.get("WITHDRAW_SECRET");

// generate signature pakai CryptoJS (built-in Postman)
const signature = CryptoJS.HmacSHA256(jsonPayload, secret).toString(CryptoJS.enc.Hex);

// simpan ke environment variable Postman
pm.environment.set("seller_id", sellerId);
pm.environment.set("amount", amount);
pm.environment.set("bank_code", bankCode);
pm.environment.set("account_number", accountNumber);
pm.environment.set("account_holder_name", accountHolderName);
pm.environment.set("timestamp", ts);
pm.environment.set("signature", signature);
```

**Catatan**:
- Pastikan environment variable `WITHDRAW_SECRET` sudah diset di Postman.
- Signature dihasilkan menggunakan HMAC-SHA256 dengan payload yang disusun menggunakan `stableStringify`.
- Response akan mencakup status penarikan dan detail transaksi dari Xendit.

## Rute Pembeli

### Checkout
**Endpoint**: `POST /cart/checkout`  
**Deskripsi**: Memproses checkout dari keranjang belanja, termasuk validasi alamat, pembayaran, dan pembuatan pesanan.  
**Fitur Baru**:
- Penambahan metode pembayaran `balance` untuk menggunakan saldo user.
- Otomatisasi pembaruan alamat jika disediakan dalam request.
- Snapshot item pesanan disimpan di `order_item_details` dan `order_details_items`.

**Contoh Request Body**:
```json
{
  "itemsToCheckout": [
    {
      "productId": "product-uuid",
      "variantId": "variant-uuid",
      "qty": 2,
      "pickupMethod": "diantar"
    }
  ],
  "pickupMethod": "diantar",
  "paymentMethod": "digital",
  "address": {
    "nama_penerima": "Nama Penerima",
    "no_telepon": "081234567890",
    "alamat_lengkap": "Jl. Contoh No. 123",
    "kode_pos": "12345",
    "provinsi_id": "1",
    "kota_id": "101",
    "kecamatan_id": "1001",
    "kelurahan_id": "10001"
  }
}
```
**Catatan**:
- Metode pembayaran: `cod`, `digital`, atau `balance`.
- Alamat wajib lengkap jika ada item dengan `pickupMethod: diantar`.

### Keuangan Pembeli
**Endpoint**:
- `POST /paymentuser/set-pin`: Mengatur atau mengubah PIN pembeli.
- `POST /paymentuser/withdraw/batch`: Melakukan penarikan saldo pembeli ke rekening bank.
- `GET /paymentuser/withdrawals`: Mengambil riwayat penarikan saldo.
- `GET /paymentuser/transactions`: Mengambil riwayat transaksi saldo.
- `GET /paymentuser/balance`: Mengambil informasi saldo pembeli.

**Fitur Baru**:
- Penarikan saldo menggunakan Xendit dengan validasi PIN dan signature.
- Penyimpanan riwayat transaksi dan penarikan di tabel `user_balance_transactions` dan `user_withdrawals`.
- Validasi PIN (4-6 digit) dan otorisasi menggunakan `user_info` dari cookies.

**Contoh Request Body (Withdraw)**:
```json
{
  "user_id": "{{user_id}}",
  "amount": {{amount}},
  "bank_code": "{{bank_code}}",
  "account_number": "{{account_number}}",
  "account_holder_name": "{{account_holder_name}}",
  "pin": "1234",
  "timestamp": {{timestamp}},
  "signature": "{{signature}}"
}
```

**Script Postman untuk Withdraw Pembeli**:
```javascript
// Fungsi stableStringify (harus sama dengan di backend)
function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",")}}`;
}

// === Data request ===
const userId = "64d67463-148f-4490-a23a-134f199dfa7e";        // ganti sesuai DB/ cookies
const amount = 3000;                 // contoh nominal
const bankCode = "BCA";            // contoh kode bank
const accountNumber = "1234567890";   // contoh nomor rekening
const accountHolderName = "John Doe"; // contoh nama
const ts = Date.now();

// payload untuk signature
const payload = {
  userId,
  amount,
  bankCode,
  accountNumber,
  accountHolderName,
  timestamp: ts
};

const jsonPayload = stableStringify(payload);

// ambil secret dari environment variable Postman
const secret = pm.environment.get("WITHDRAW_SECRET");

// generate signature pakai CryptoJS (built-in Postman)
const signature = CryptoJS.HmacSHA256(jsonPayload, secret).toString(CryptoJS.enc.Hex);

// simpan ke environment variable Postman
pm.environment.set("user_id", userId);
pm.environment.set("amount", amount);
pm.environment.set("bank_code", bankCode);
pm.environment.set("account_number", accountNumber);
pm.environment.set("account_holder_name", accountHolderName);
pm.environment.set("timestamp", ts);
pm.environment.set("signature", signature);
```

**Catatan**:
- Pastikan environment variable `WITHDRAW_SECRET` sudah diset di Postman.
- PIN harus sesuai dengan yang diset di `POST /paymentuser/set-pin`.
- Signature dihasilkan menggunakan HMAC-SHA256 dengan payload yang disusun menggunakan `stableStringify`.

### Update User
**Endpoint**: `PUT /auth/user/:id`  
**Deskripsi**: Mengupdate data pembeli, termasuk informasi alamat, avatar, dan data rekening.  
**Fitur Baru**:
- Penambahan field `user_pin`, `bank_code`, `account_holder_name`, dan `account_number` untuk keperluan penarikan saldo.
- Validasi wilayah menggunakan API eksternal untuk memastikan data alamat valid.

**Contoh Request Body**:
```json
{
  "username": "newusername",
  "password": "NewP@ssw0rd123",
  "nama_penerima": "Nama Penerima",
  "no_telepon": "081234567890",
  "alamat_lengkap": "Jl. Baru No. 1",
  "kode_pos": "12345",
  "provinsi_id": "1",
  "kota_id": "101",
  "kecamatan_id": "1001",
  "kelurahan_id": "10001",
  "user_pin": "123456",
  "bank_code": "BCA",
  "account_holder_name": "Nama Pemilik",
  "account_number": "1234567890"
}
```
**Catatan**:
- Avatar diunggah melalui `multipart/form-data`.
- Password harus memenuhi kriteria keamanan jika diubah.

## Catatan Umum
- **Otentikasi**: Semua rute memerlukan cookies (`seller_info` atau `user_info`) untuk otorisasi.
- **Validasi Wilayah**: Menggunakan API `https://www.emsifa.com/api-wilayah-indonesia` untuk validasi dan pengambilan nama wilayah.
- **Pembayaran**: Menggunakan Xendit untuk pembayaran digital dan penarikan saldo.
- **Error Handling**: Setiap rute memiliki penanganan error dengan pesan yang jelas dan kode status HTTP yang sesuai.
- **Cache**: Beberapa rute menggunakan cache untuk mengoptimalkan performa (misalnya, data produk dan seller).

Untuk informasi lebih lanjut atau bantuan, hubungi tim pengembang melalui [support@example.com](mailto:support@example.com).