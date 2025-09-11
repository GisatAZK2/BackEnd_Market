# Dokumentasi API Promosi Penjual dan Diskon Pelanggan

API ini menyediakan fitur untuk mengelola promosi penjual dan diskon pelanggan melalui rute-rute yang terpisah untuk penjual dan pelanggan. API ini dibangun menggunakan Express.js dan Supabase sebagai database. Berikut adalah penjelasan rute yang tersedia untuk penjual dan pelanggan.

## Base URL
- **Penjual**: `backendcihuyy.up.railway.app/seller/V1/promoteseller`
- **Pelanggan**: `backendcihuyy.up.railway.app/discount/`

## Deskripsi Umum
API ini memungkinkan:
- **Penjual**: Mendaftarkan produk ke event promosi, mengelola produk dalam event, menghapus produk dari event, serta melihat daftar produk yang tersedia untuk event.
- **Pelanggan**: Melihat daftar event promosi dan detail event tertentu beserta produk yang terkait.

## Rute Penjual
Berikut adalah endpoint yang tersedia untuk penjual di bawah base URL `backendcihuyy.up.railway.app/seller/V1/promoteseller`.

### 1. **POST /event/register**
Mendaftarkan produk ke event promosi.

- **Deskripsi**: Menambahkan produk atau varian produk ke event tertentu dengan memeriksa aturan seperti kategori, stok minimum, dan diskon minimum.
- **Body**:
  ```json
  {
    "event_id": "string",
    "products": [
      {
        "product_id": "string",
        "variant_id": "string | null",
        "event_stock": number,
        "discount_percentage": number
      }
    ]
  }
  ```
- **Respons Sukses**:
  ```json
  {
    "message": "✅ Produk berhasil didaftarkan ke event",
    "accepted": [{ seller_id, event_id, product_id, variant_id, event_discount, event_stock }],
    "rejected": [{ product_id, variant_id, reason }]
  }
  ```
- **Respons Gagal**:
  - 401: Harus login sebagai penjual.
  - 400: Data tidak lengkap atau tidak ada produk yang memenuhi aturan.
  - 404: Event tidak ditemukan.
  - 500: Gagal mendaftarkan produk.

### 2. **GET /events/seller**
Mengambil daftar event dengan jumlah penjual terdaftar dan status event.

- **Deskripsi**: Mengembalikan daftar semua event dengan informasi jumlah penjual yang mendaftar dan status event (upcoming, active, ended).
- **Respons Sukses**:
  ```json
  {
    "message": "✅ Daftar event untuk seller dengan jumlah seller terdaftar",
    "data": [
      {
        "id": "string",
        "start_time": "string",
        "end_time": "string",
        "seller_count": number,
        "status": "upcoming | active | ended",
        ...
      }
    ]
  }
  ```
- **Respons Gagal**:
  - 500: Gagal mengambil daftar event.

### 3. **PUT /event/:eventId/products**
Memperbarui stok dan diskon produk dalam event secara batch.

- **Deskripsi**: Memperbarui stok dan/atau diskon untuk produk tertentu dalam event. Memastikan stok tidak negatif dan memperbarui stok produk/varian di database.
- **Parameter**: `eventId` (string)
- **Body**:
  ```json
  {
    "items": [
      {
        "product_id": "string",
        "stock": number,
        "event_discount": number
      }
    ]
  }
  ```
- **Respons Sukses**:
  ```json
  {
    "results": [
      {
        "product_id": "string",
        "success": boolean,
        "message": "string",
        "old_stock": number,
        "new_stock": number,
        "old_discount": number,
        "new_discount": number
      }
    ]
  }
  ```
- **Respons Gagal**:
  - 400: Items tidak valid.
  - 500: Gagal memperbarui produk.

### 4. **GET /event/:eventId/available-products**
Mengambil daftar produk yang tersedia untuk ditambahkan ke event.

- **Deskripsi**: Mengembalikan produk milik penjual yang belum terdaftar di event tertentu, lengkap dengan informasi varian, stok, dan diskon.
- **Parameter**: `eventId` (string)
- **Respons Sukses**:
  ```json
  {
    "message": "✅ Produk yang tersedia untuk ditambahkan ke event",
    "count": number,
    "data": [
      {
        "id": "string",
        "product_name": "string",
        "product_price": number,
        "stock": number,
        ...
      }
    ]
  }
  ```
- **Respons Gagal**:
  - 401: Harus login sebagai penjual.
  - 500: Gagal mengambil produk.

### 5. **DELETE /event/:eventId/product/:productId**
Menghapus produk dari event.

- **Deskripsi**: Menghapus produk tertentu atau semua produk milik penjual dari event. Stok dikembalikan otomatis melalui trigger.
- **Parameter**:
  - `eventId` (string)
  - `productId` (string, gunakan "all" untuk menghapus semua produk penjual)
- **Respons Sukses**:
  ```json
  {
    "message": "✅ Produk dihapus dari event (stok dikembalikan otomatis oleh trigger)"
  }
  ```
- **Respons Gagal**:
  - 401: Harus login sebagai penjual.
  - 403: Produk bukan milik penjual.
  - 500: Gagal menghapus produk.

### 6. **GET /event/:eventId**
Mengambil detail event untuk penjual.

- **Deskripsi**: Mengembalikan detail event beserta produk yang terkait, dengan filter berdasarkan penjual jika login.
- **Parameter**: `eventId` (string)
- **Respons Sukses**:
  ```json
  {
    "message": "✅ Detail event flash sale",
    "event": {
      "id": "string",
      "start_time": "string",
      "end_time": "string",
      "rules": "string | null",
      "products": [
        {
          "id": "string",
          "product_name": "string",
          "product_price": number,
          "event_stock": number,
          ...
        }
      ]
    }
  }
  ```
- **Respons Gagal**:
  - 404: Event tidak ditemukan.
  - 500: Gagal mengambil detail event.

## Rute Pelanggan
Berikut adalah endpoint yang tersedia untuk pelanggan di bawah base URL `backendcihuyy.up.railway.app/discount/`.

### 1. **GET /event/list**
Mengambil daftar event untuk pelanggan.

- **Deskripsi**: Mengembalikan daftar semua event dengan status (upcoming, active, ended).
- **Respons Sukses**:
  ```json
  {
    "message": "✅ Daftar event untuk customer",
    "data": [
      {
        "id": "string",
        "start_time": "string",
        "end_time": "string",
        "status": "upcoming | active | ended",
        ...
      }
    ]
  }
  ```
- **Respons Gagal**:
  - 500: Gagal mengambil daftar event.

### 2. **GET /event/:eventId**
Mengambil detail event untuk pelanggan.

- **Deskripsi**: Mengembalikan detail event beserta produk yang terkait, termasuk informasi varian, stok, dan diskon.
- **Parameter**: `eventId` (string)
- **Respons Sukses**:
  ```json
  {
    "message": "✅ Detail event flash sale",
    "event": {
      "id": "string",
      "start_time": "string",
      "end_time": "string",
      "rules": "string | null",
      "products": [
        {
          "id": "string",
          "product_name": "string",
          "product_price": number,
          "event_stock": number,
          ...
        }
      ]
    }
  }
  ```
- **Respons Gagal**:
  - 404: Event tidak ditemukan.
  - 500: Gagal mengambil detail event.

## Catatan Tambahan
- **Autentikasi Penjual**: Semua rute penjual memerlukan cookie `seller_info` yang berisi informasi penjual (ID penjual). Jika tidak ada, akan mengembalikan error 401.
- **Manajemen Stok**: Penambahan atau pengurangan stok event akan memperbarui stok produk/varian di database. Penghapusan produk dari event akan mengembalikan stok secara otomatis melalui trigger.
- **Format Tanggal**: Menggunakan `DateTime` dari library Luxon untuk menentukan status event berdasarkan `start_time` dan `end_time`.
- **Fungsi Tambahan**: Fungsi `attachVariantsStockDiscountWithRealDiscount` digunakan untuk memperkaya data produk dengan informasi varian, stok, dan diskon.

## Cara Menjalankan
1. Pastikan Anda memiliki akses ke Supabase dan konfigurasikan kredensialnya.
2. Jalankan server Express.js di lingkungan Node.js.
3. Gunakan base URL yang sesuai untuk mengakses endpoint penjual atau pelanggan.
4. Pastikan cookie `seller_info` tersedia untuk rute penjual.
