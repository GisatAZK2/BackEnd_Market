# Dokumentasi API Backend Market

Dokumentasi ini menjelaskan rute API yang tersedia untuk mengelola Air Waybill (AWB) dan pesanan (order) pada aplikasi Backend Market. API ini dirancang untuk mendukung fungsi seller dan buyer dalam mengelola pesanan, termasuk pembuatan AWB, melihat daftar pesanan yang dibatalkan, dan pesanan yang diterima.

## Base URL
- **AWB Seller**: `https://backendmarket-production.up.railway.app/seller/V1/awbseller`
- **Order Seller**: `https://backendmarket-production.up.railway.app/seller/V1/order`
- **Order Buyer**: `https://backendmarket-production.up.railway.app/order`

## Rute API

### 1. Generate AWB / Label Seller (Seller)
- **Endpoint**: `POST /seller/generate-awb`
- **Base URL**: `https://backendmarket-production.up.railway.app/seller/V1/awbseller`
- **Deskripsi**: Menghasilkan label pengiriman (AWB) dalam format PDF untuk pesanan tertentu milik seller. Label mencakup informasi penerima, pengirim, detail produk, dan kode QR untuk verifikasi.
- **Autentikasi**: Memerlukan cookie `seller_info` dengan ID seller yang valid.
- **Body Request**:
  ```json
  {
    "orderIds": ["order_id_1", "order_id_2"]
  }
  ```
- **Respons**:
  - Jika hanya satu pesanan, mengembalikan file PDF langsung dengan header:
    - `Content-Type: application/pdf`
    - `Content-Disposition: inline; filename="shipping-label-<order_id>.pdf"`
  - Jika beberapa pesanan, mengembalikan halaman HTML untuk pratinjau PDF dengan opsi download dan print.
  - **Error**:
    - `401`: Seller belum login.
    - `400`: `orderIds` tidak valid.
    - `404`: Pesanan tidak ditemukan atau bukan milik seller.
    - `500`: Kesalahan server, seperti gagal memperbarui status atau mengambil data.

### 2. Daftar Order Dibatalkan (Seller)
- **Endpoint**: `GET /seller/cancelled`
- **Base URL**: `https://backendmarket-production.up.railway.app/seller/V1/order`
- **Deskripsi**: Mengambil daftar pesanan dengan status "dibatalkan" milik seller, termasuk detail item, jumlah total, dan informasi alamat pembeli serta penjual.
- **Autentikasi**: Memerlukan cookie `seller_info` dengan ID seller yang valid.
- **Respons**:
  ```json
  {
    "message": "✅ Daftar order dibatalkan seller berhasil diambil.",
    "orders": [
      {
        "id": "order_id",
        "created_at": "timestamp",
        "total_price": number,
        "delivery_fee": number,
        "status": "dibatalkan",
        "pickup_method": "diantar/diambil",
        "confirm_deadline": "timestamp",
        "buyer_address": object,
        "seller_address": object,
        "order_items": [
          {
            "order_item_id": "item_id",
            "orderItemId": "item_id",
            "product_id": "product_id",
            "product_name": "string",
            "product_image_url": "string",
            "quantity": number,
            "price_per_item": number,
            "discount_percentage": number,
            "variant": object | null
          }
        ],
        "total_quantity": number,
        "buyer_info": object,
        "buyer_full_address": "string",
        "seller_info": object,
        "seller_full_address": "string"
      }
    ]
  }
  ```
- **Cache**: Menggunakan cache dengan kunci `orders:seller:cancelled:<seller_id>` untuk mempercepat respons.
- **Error**:
  - `401`: Seller belum login.
  - `500`: Kesalahan server, seperti gagal mengambil data dari Supabase.

### 3. Daftar Order Diterima Oleh Pembeli (Seller)
- **Endpoint**: `GET /seller/completed`
- **Base URL**: `https://backendmarket-production.up.railway.app/seller/V1/order`
- **Deskripsi**: Mengambil daftar pesanan dengan status "diterima oleh pembeli" milik seller, termasuk detail item, jumlah total, dan informasi alamat pembeli serta penjual.
- **Autentikasi**: Memerlukan cookie `seller_info` dengan ID seller yang valid.
- **Respons**: Sama seperti endpoint `/seller/cancelled`, tetapi untuk status "diterima oleh pembeli".
- **Cache**: Menggunakan cache dengan kunci `orders:seller:completed:<seller_id>`.
- **Error**:
  - `401`: Seller belum login.
  - `500`: Kesalahan server, seperti gagal mengambil data dari Supabase.

### 4. Daftar Order Dibatalkan Oleh Seller / Sistem (Buyer)
- **Endpoint**: `GET /canceled`
- **Base URL**: `https://backendmarket-production.up.railway.app/order`
- **Deskripsi**: Mengambil daftar pesanan dengan status "dibatalkan" milik pembeli, termasuk detail item, jumlah total, informasi alamat, dan status rating.
- **Autentikasi**: Memerlukan cookie `user_info` dengan ID pengguna yang valid.
- **Respons**: Sama seperti endpoint `/seller/cancelled`, tetapi untuk pesanan pembeli dengan tambahan field `is_rated`.
- **Cache**: Menggunakan cache dengan kunci `orders:canceled:<user_id>`.
- **Error**:
  - `401`: Pengguna belum login.
  - `500`: Kesalahan server, seperti gagal mengambil data atau parsing alamat.

### 5. Daftar Order Diterima (Buyer)
- **Endpoint**: `GET /received`
- **Base URL**: `https://backendmarket-production.up.railway.app/order`
- **Deskripsi**: Mengambil daftar pesanan dengan status "diterima oleh pembeli" milik pembeli, termasuk detail item, jumlah total, informasi alamat, dan status rating.
- **Autentikasi**: Memerlukan cookie `user_info` dengan ID pengguna yang valid.
- **Respons**: Sama seperti endpoint `/canceled`, tetapi untuk status "diterima oleh pembeli".
- **Cache**: Menggunakan cache dengan kunci `orders:received:<user_id>`.
- **Error**:
  - `401`: Pengguna belum login.
  - `500`: Kesalahan server, seperti gagal mengambil data atau parsing alamat.

## Catatan
- **Autentikasi**: Semua endpoint memerlukan cookie autentikasi (`seller_info` untuk seller, `user_info` untuk buyer).
- **Cache**: Digunakan untuk mengoptimalkan performa dengan menyimpan hasil query ke memori.
- **Format Alamat**: Alamat pembeli dan penjual di-parse dari JSON untuk menghasilkan `full_address` dalam format string.
- **PDF AWB**: Menggunakan `pdfkit` untuk menghasilkan label pengiriman dengan desain yang mencakup header, detail produk, kode QR, dan elemen dekoratif.
- **Error Handling**: Semua endpoint memiliki penanganan kesalahan dengan pesan dalam bahasa Indonesia dan kode status HTTP yang sesuai.

## Dependensi
- `express`: Framework untuk routing API.
- `supabase`: Koneksi ke database Supabase untuk query data.
- `luxon`: Penanganan tanggal dan waktu.
- `qrcode`: Pembuatan kode QR untuk verifikasi AWB.
- `pdfkit`: Pembuatan dokumen PDF untuk label pengiriman.
- `axios`: Pengambilan logo dari URL.
- `orderCache`: Sistem caching untuk hasil query.