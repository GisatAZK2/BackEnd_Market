# Dokumentasi API Store Discount

Berikut adalah dokumentasi untuk API pengelolaan diskon toko (store discount) menggunakan Express.js dan Supabase sebagai backend. API ini memungkinkan penjual untuk membuat, mengelola, dan menghapus diskon untuk produk dan variannya.

**Base URL**: `https://backendmarket-production.up.railway.app/seller/V1/promoteseller`

## Daftar Isi
1. [Prasyarat](#prasyarat)
2. [Fitur Utama](#fitur-utama)
3. [Endpoint API](#endpoint-api)
   - [Membuat Diskon Baru](#membuat-diskon-baru)
   - [Mendapatkan Produk yang Tersedia](#mendapatkan-produk-yang-tersedia)
   - [Mendapatkan Semua Diskon](#mendapatkan-semua-diskon)
   - [Mendapatkan Detail Diskon](#mendapatkan-detail-diskon)
   - [Menduplikasi Diskon](#menduplikasi-diskon)
   - [Mengedit Diskon](#mengedit-diskon)
   - [Menghapus Diskon atau Item](#menghapus-diskon-atau-item)
4. [Struktur Data](#struktur-data)
5. [Catatan Tambahan](#catatan-tambahan)

## Prasyarat
- **Node.js** dan **Express.js** terinstal.
- **Supabase** sebagai database backend dengan tabel `store_discounts`, `store_discount_items`, `products`, dan `product_variants`.
- **Cookie** berisi `seller_info` dengan `id` penjual untuk autentikasi.
- Dependensi: `multer`, `sharp`, `uuid`, `luxon`, `node-cron`.
- Fungsi utilitas: `attachVariantsStockDiscount` dan `attachVariantsStockDiscountWithRealDiscount` dari `../../utils/applyDiscountAndVariants`.

## Fitur Utama
- Membuat diskon toko dengan item produk atau varian tertentu.
- Validasi duplikasi diskon berdasarkan nama dan periode.
- Pengecekan produk/varian yang sudah ada di diskon aktif.
- Mengelompokkan produk dan varian dengan status diskon.
- Menduplikasi diskon dengan periode baru.
- Mengedit item diskon (stock dan persentase diskon).
- Menghapus diskon atau item tertentu.

## Endpoint API

### Membuat Diskon Baru
**POST** `/store-discount/create`

**URL Lengkap**: `https://backendmarket-production.up.railway.app/seller/V1/promoteseller/store-discount/create`

**Deskripsi**: Membuat diskon baru untuk toko dengan item produk/varian tertentu.

**Body Request**:
```json
{
  "name": "string",
  "start_time": "ISO string",
  "end_time": "ISO string",
  "timezone": "string (opsional, default: Asia/Jakarta)",
  "items": [
    {
      "product_id": "string",
      "stock": "number (opsional jika ada varian)",
      "discount_percentage": "number (opsional jika ada varian)",
      "variants": [
        {
          "variant_id": "string",
          "stock": "number",
          "discount_percentage": "number"
        }
      ]
    }
  ]
}
```

**Respons Sukses** (200):
```json
{
  "message": "✅ Diskon toko berhasil dibuat dengan item-target",
  "store_discount": { /* data diskon */ }
}
```

**Respons Gagal**:
- 401: Harus login sebagai seller.
- 400: Field wajib (name, start_time, end_time, items) tidak lengkap.
- 409: Diskon dengan nama dan periode sama sudah ada atau produk/varian sudah ada di diskon aktif.
- 500: Error server atau gagal menyimpan data.

---

### Mendapatkan Produk yang Tersedia
**GET** `/store-discount/available-products`

**URL Lengkap**: `https://backendmarket-production.up.railway.app/seller/V1/promoteseller/store-discount/available-products`

**Deskripsi**: Mengambil daftar semua produk dan varian milik penjual, dengan status apakah sedang dalam diskon aktif atau tidak.

**Respons Sukses** (200):
```json
{
  "message": "✅ Daftar produk dengan status diskon",
  "items": [
    {
      "product_id": "string",
      "product_data": {
        "product_name": "string",
        "product_description": "string",
        "stock": "number (null jika ada varian)",
        "seller_name": "string",
        "product_image_url": "string|null",
        "is_on_discount": "boolean|undefined"
      },
      "stock": "number|null",
      "discount_percentage": "number|null",
      "variants": [
        {
          "variant_id": "string",
          "stock": "number",
          "discount_percentage": "number|null",
          "is_on_discount": "boolean",
          "variant_data": {
            "variant_name": "string",
            "variant_stock": "number",
            "variant_image_url": "string|null"
          }
        }
      ]
    }
  ]
}
```

**Respons Gagal**:
- 401: Harus login sebagai seller.
- 404: Seller tidak ditemukan.
- 500: Error server.

---

### Mendapatkan Semua Diskon
**GET** `/store-discount/all`

**URL Lengkap**: `https://backendmarket-production.up.railway.app/seller/V1/promoteseller/store-discount/all`

**Deskripsi**: Mengambil semua diskon milik penjual tanpa relasi produk/varian.

**Respons Sukses** (200):
```json
{
  "message": "✅ Semua diskon toko berhasil diambil",
  "data": [ /* daftar diskon */ ]
}
```

**Respons Gagal**:
- 401: Harus login sebagai seller.
- 500: Error server.

---

### Mendapatkan Detail Diskon
**GET** `/store-discount/:id`

**URL Lengkap**: `https://backendmarket-production.up.railway.app/seller/V1/promoteseller/store-discount/:id`

**Deskripsi**: Mengambil detail diskon berdasarkan ID, termasuk item produk dan varian.

**Parameter**: `id` (ID diskon)

**Respons Sukses** (200):
```json
{
  "message": "✅ Diskon berhasil diambil",
  "data": {
    /* data diskon */
    "items": [
      {
        "product_id": "string",
        "product_data": {
          "product_name": "string",
          "product_description": "string",
          "product_image_url": "string|null",
          "stock": "number|null"
        },
        "stock": "number|null",
        "discount_percentage": "number|null",
        "variants": [
          {
            "variant_id": "string",
            "stock": "number|null",
            "discount_percentage": "number",
            "variant_data": {
              "variant_name": "string",
              "variant_stock": "number"
            }
          }
        ]
      }
    ]
  }
}
```

**Respons Gagal**:
- 401: Harus login sebagai seller.
- 404: Diskon tidak ditemukan.
- 500: Error server.

---

### Menduplikasi Diskon
**POST** `/store-discount/duplicate/:id`

**URL Lengkap**: `https://backendmarket-production.up.railway.app/seller/V1/promoteseller/store-discount/duplicate/:id`

**Deskripsi**: Menduplikasi diskon yang sudah ada dengan nama dan periode baru.

**Body Request**:
```json
{
  "newName": "string (opsional, default: nama diskon lama)",
  "newStartTime": "ISO string",
  "newEndTime": "ISO string",
  "timezone": "string (opsional, default: Asia/Jakarta)"
}
```

**Respons Sukses** (200):
```json
{
  "message": "✅ Diskon berhasil diduplikasi",
  "store_discount": { /* data diskon baru */ }
}
```

**Respons Gagal**:
- 401: Harus login sebagai seller.
- 404: Diskon lama tidak ditemukan.
- 500: Error server.

---

### Mengedit Diskon
**PUT** `/store-discount/edit/:id`

**URL Lengkap**: `https://backendmarket-production.up.railway.app/seller/V1/promoteseller/store-discount/edit/:id`

**Deskripsi**: Mengedit item diskon (stock atau persentase diskon) atau menambahkan item baru.

**Body Request**:
```json
{
  "items": [
    {
      "product_id": "string",
      "variant_id": "string|null",
      "stock": "number",
      "discount_percentage": "number"
    }
  ]
}
```

**Respons Sukses** (200):
```json
{
  "message": "✅ Diskon berhasil diperbarui"
}
```

**Respons Gagal**:
- 401: Harus login sebagai seller.
- 500: Error server.

---

### Menghapus Diskon atau Item
**DELETE** `/store-discount/:id`

**URL Lengkap**: `https://backendmarket-production.up.railway.app/seller/V1/promoteseller/store-discount/:id`

**Deskripsi**: Menghapus seluruh diskon atau item tertentu berdasarkan `product_id` dan `variant_id`.

**Query Parameter** (opsional):
- `product_id`: ID produk yang akan dihapus dari diskon.
- `variant_id`: ID varian yang akan dihapus dari diskon.

**Respons Sukses** (200):
```json
{
  "message": "✅ Diskon berhasil dihapus" // atau "✅ Item {product_id} varian {variant_id} berhasil dihapus dari diskon"
}
```

**Respons Gagal**:
- 401: Harus login sebagai seller.
- 500: Error server.

## Struktur Data
- **store_discounts**: Tabel untuk menyimpan informasi diskon (id, store_id, name, start_time, end_time).
- **store_discount_items**: Tabel untuk menyimpan item diskon (discount_id, product_id, variant_id, stock, discount_percentage).
- **products**: Tabel produk (id, product_name, product_description, stock, seller_name, product_image_url).
- **product_variants**: Tabel varian produk (id, product_id, variant_name, variant_stock, variant_image_url).

## Catatan Tambahan
- Semua endpoint memerlukan autentikasi melalui cookie `seller_info` dengan `id` penjual.
- Waktu diskon dikonversi ke UTC menggunakan `luxon` berdasarkan zona waktu yang diberikan (default: Asia/Jakarta).
- Validasi dilakukan untuk mencegah duplikasi diskon atau item yang sudah ada di diskon aktif.
- Gambar produk dan varian diambil dari kolom `product_image_url` dan `variant_image_url`.