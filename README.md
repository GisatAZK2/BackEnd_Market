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


### 3. PUT `/event/:eventId/products`
Endpoint ini digunakan untuk memperbarui stok dan/atau diskon produk dalam event secara batch.

#### Parameter
- **Path Parameters**:
  - `eventId`: ID dari event yang produknya akan diperbarui.
- **Body** (JSON):
  ```json
  {
    "items": [
      {
        "product_id": "string",
        "variant_id": "string" (opsional),
        "stock": number (opsional),
        "event_discount": number (opsional)
      }
    ]
  }
  ```

#### Autentikasi
- Tidak ada autentikasi eksplisit dalam kode, tetapi dianjurkan untuk menambahkan validasi seller.

#### Contoh Request
```bash
PUT /event/123/products
```
**Body**:
```json
{
  "items": [
    {
      "product_id": "456",
      "variant_id": "789",
      "stock": 50,
      "event_discount": 10
    },
    {
      "product_id": "101",
      "stock": 100
    }
  ]
}
```

#### Response
- **Sukses** (200):
  ```json
  {
    "results": [
      {
        "product_id": "456",
        "variant_id": "789",
        "success": true,
        "message": "✅ Data event berhasil diperbarui",
        "old_stock": 30,
        "new_stock": 50,
        "old_discount": 5,
        "new_discount": 10
      },
      {
        "product_id": "101",
        "success": true,
        "message": "✅ Data event berhasil diperbarui",
        "old_stock": 80,
        "new_stock": 100,
        "old_discount": 0,
        "new_discount": 0
      }
    ]
  }
  ```
- **Error**:
  - 400: Jika `items` bukan array atau kosong, stok tidak valid, atau produk memiliki varian tetapi `variant_id` tidak diberikan.
  - 500: Jika terjadi kesalahan server.

#### Catatan
- Pembaruan stok akan otomatis menyesuaikan stok di tabel `products` atau `product_variants`.
- Jika stok tidak mencukupi, pembaruan akan gagal untuk item tersebut.
- Logging disediakan untuk debugging (lihat `console.log` dalam kode).



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

### 5. DELETE `/event/:eventId/product/:productId`
Endpoint ini digunakan untuk menghapus produk atau varian tertentu dari event.

#### Parameter
- **Path Parameters**:
  - `eventId`: ID dari event yang ingin dihapus produknya.
  - `productId`: ID dari produk yang akan dihapus. Gunakan `all` untuk menghapus semua produk seller dari event.
- **Query Parameters**:
  - `mode`: (opsional) Mode penghapusan, nilai yang valid: `product` (hapus produk beserta semua variannya) atau `variant` (hapus varian spesifik).
  - `variantId`: (opsional, wajib jika `mode=variant`) ID dari varian produk yang akan dihapus.

#### Autentikasi
- Memerlukan cookie `seller_info` yang berisi informasi seller dalam format JSON.
- Seller harus login untuk mengakses endpoint ini.

#### Contoh Request
1. **Hapus semua produk seller dari event**:
   ```bash
   DELETE /event/123/product/all
   ```
2. **Hapus produk tertentu (tanpa varian)**:
   ```bash
   DELETE /event/123/product/456
   ```
3. **Hapus produk beserta semua variannya**:
   ```bash
   DELETE /event/123/product/456?mode=product
   ```
4. **Hapus varian spesifik**:
   ```bash
   DELETE /event/123/product/456?mode=variant&variantId=789
   ```

#### Response
- **Sukses** (200):
  ```json
  {
    "message": "✅ Produk dihapus dari event (event_stock dikembalikan otomatis oleh trigger)"
  }
  ```
- **Error**:
  - 401: Jika seller belum login.
  - 403: Jika produk bukan milik seller.
  - 400: Jika parameter tidak valid (misalnya mode salah atau variantId tidak diberikan).
  - 500: Jika terjadi kesalahan server.

#### Catatan
- Penghapusan stok event akan otomatis mengembalikan stok ke tabel `products` atau `product_variants` melalui trigger di database.
- Validasi dilakukan untuk memastikan produk atau varian milik seller.

---


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
