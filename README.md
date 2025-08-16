# Dokumentasi API Produk Seller

Base URL: `https://backendmarket-production.up.railway.app/seller/V1/products`

API ini menyediakan endpoint untuk mengelola produk dan varian produk milik seller, termasuk operasi upload, pengambilan data, pembaruan, dan penghapusan. API ini menggunakan autentikasi berbasis cookie (`seller_info`) untuk memastikan hanya seller yang berwenang yang dapat mengakses dan mengelola produk mereka. Semua gambar diunggah dalam format WebP untuk efisiensi penyimpanan.

## Persyaratan Umum
- **Autentikasi**: Semua endpoint memerlukan cookie `seller_info` yang berisi informasi seller dalam format JSON. Jika cookie tidak ada atau tidak valid, server akan mengembalikan status `401 Unauthorized`.
- **Format Gambar**: Gambar yang diunggah akan dikonversi ke format WebP dengan kualitas 80%. Batas ukuran file adalah 10MB per gambar.
- **Maksimum Gambar**: Maksimum 10 gambar untuk produk dan 10 gambar untuk varian per permintaan.
- **Cache**: Beberapa endpoint menggunakan caching dengan `node-cache` (TTL: 10 detik) untuk meningkatkan performa.

---

## Endpoint

### 1. Upload Produk Baru
**`POST /upload`**

Mengunggah produk baru beserta gambar dan varian (opsional).

#### **Request**
- **Method**: POST
- **Content-Type**: `multipart/form-data`
- **Body**:
  - `seller_id` (string, wajib): ID seller.
  - `productName` (string, wajib): Nama produk.
  - `productDescription` (string, wajib): Deskripsi produk.
  - `category_id` (string, wajib): ID kategori produk.
  - `stock` (integer, opsional): Total stok produk (wajib jika tidak ada varian).
  - `productPrice` (float, opsional): Harga produk (wajib jika tidak ada varian).
  - `variants` (JSON string, opsional): Daftar varian dalam format JSON, contoh:
    ```json
    [
      { "name": "Varian 1", "price": 10000, "stock": 10, "image_url": null },
      { "name": "Varian 2", "price": 12000, "stock": 5, "image_url": null }
    ]
    ```
  - `productImages` (file, wajib): Minimal 1 gambar produk (maksimum 10).
  - `variantImages` (file, opsional): Gambar untuk varian (maksimum 10, sesuai urutan varian).

#### **Response**
- **201 Created**:
  ```json
  {
    "message": "✅ Produk berhasil diunggah",
    "data": {
      "id": "product_id",
      "seller_id": "seller_id",
      "product_name": "Nama Produk",
      "product_description": "Deskripsi Produk",
      "product_price": 10000,
      "min_price": 10000,
      "max_price": 12000,
      "stock": 15,
      "product_image_url": ["url1", "url2"],
      "keywords": ["keyword1", "keyword2"],
      "variants": [
        { "product_id": "product_id", "variant_name": "Varian 1", "variant_price": 10000, "variant_stock": 10, "variant_image_url": "url" },
        ...
      ]
    }
  }
  ```
- **400 Bad Request**: Jika field wajib kosong, format varian tidak valid, atau gambar bukan format yang diizinkan.
- **404 Not Found**: Jika seller tidak ditemukan.
- **500 Internal Server Error**: Jika terjadi kesalahan server.

#### **Catatan**
- Gambar diunggah ke Supabase Storage di bucket `product-images` dengan path `seller_id/products/{uuid}.webp` untuk produk dan `seller_id/variants/{uuid}.webp` untuk varian.
- Keywords dihasilkan otomatis dari `productName` dan `productDescription` menggunakan fungsi `generateKeywords`.
- Harga dan stok produk dihitung berdasarkan varian (jika ada) atau input langsung.

---

### 2. Ambil Semua Produk Seller
**`GET /allproduct`**

Mengambil semua produk milik seller yang sedang login.

#### **Request**
- **Method**: GET
- **Headers**: Cookie `seller_info` wajib.

#### **Response**
- **200 OK**:
  ```json
  {
    "message": "✅ {jumlah} produk dari seller {store_name}",
    "products": [
      {
        "id": "product_id",
        "product_name": "Nama Produk",
        "product_price": 10000,
        "stock": 15,
        "product_image_url": ["url1", "url2"],
        "variants": [
          { "variant_name": "Varian 1", "variant_price": 10000, "variant_stock": 10, "variant_image_url": "url" },
          ...
        ],
        "discountPercentage": 10,
        "realDiscount": 1000
      },
      ...
    ]
  }
  ```
- **401 Unauthorized**: Jika cookie `seller_info` tidak ada.
- **400 Bad Request**: Jika cookie `seller_info` tidak valid.
- **500 Internal Server Error**: Jika terjadi kesalahan server.

#### **Catatan**
- Produk disertai informasi varian dan diskon yang dihitung menggunakan fungsi `attachVariantsStockDiscountWithRealDiscount`.

---

### 3. Ambil Produk Berdasarkan Kategori
**`GET /by-category/:category_id`**

Mengambil semua produk milik seller dalam kategori tertentu.

#### **Request**
- **Method**: GET
- **Headers**: Cookie `seller_info` wajib.
- **Params**:
  - `category_id`: ID kategori produk.

#### **Response**
- **200 OK**:
  ```json
  {
    "message": "✅ Ditemukan {jumlah} produk dalam kategori {category_name} milik seller {store_name}",
    "category": "Nama Kategori",
    "products": [
      {
        "id": "product_id",
        "product_name": "Nama Produk",
        "product_price": 10000,
        "stock": 15,
        "product_image_url": ["url1", "url2"],
        "variants": [
          { "variant_name": "Varian 1", "variant_price": 10000, "variant_stock": 10, "variant_image_url": "url" },
          ...
        ],
        "discountPercentage": 10,
        "realDiscount": 1000
      },
      ...
    ]
  }
  ```
- **401 Unauthorized**: Jika cookie `seller_info` tidak ada.
- **400 Bad Request**: Jika cookie `seller_info` tidak valid.
- **404 Not Found**: Jika kategori tidak ditemukan.
- **500 Internal Server Error**: Jika terjadi kesalahan server.

---

### 4. Ambil Detail Produk
**`GET /:id`**

Mengambil detail produk berdasarkan ID, hanya untuk produk milik seller yang login.

#### **Request**
- **Method**: GET
- **Headers**: Cookie `seller_info` wajib.
- **Params**:
  - `id`: ID produk.

#### **Response**
- **200 OK**:
  ```json
  {
    "message": "✅ Produk ditemukan",
    "product": {
      "id": "product_id",
      "product_name": "Nama Produk",
      "product_description": "Deskripsi Produk",
      "product_price": 10000,
      "stock": 15,
      "product_image_url": ["url1", "url2"],
      "keywords": ["keyword1", "keyword2"],
      "variants": [
        { "variant_name": "Varian 1", "variant_price": 10000, "variant_stock": 10, "variant_image_url": "url" },
        ...
      ],
      "seller": {
        "id": "seller_id",
        "name": "Nama Seller",
        "email": "seller@example.com",
        "phone": "123456789",
        "store_name": "Nama Toko",
        "store_address": "Alamat Toko",
        "store_image_url": "url"
      },
      "discountPercentage": 10,
      "realDiscount": 1000
    }
  }
  ```
- **401 Unauthorized**: Jika cookie `seller_info` tidak ada.
- **400 Bad Request**: Jika cookie `seller_info` tidak valid.
- **404 Not Found**: Jika produk tidak ditemukan atau bukan milik seller.
- **500 Internal Server Error**: Jika terjadi kesalahan server.

#### **Catatan**
- Menggunakan cache (`node-cache`) untuk menyimpan hasil per seller dengan key `product_{id}_seller_{seller_id}`.

---

### 5. Update Produk
**`PUT /:id`**

Memperbarui produk yang sudah ada, termasuk gambar, varian, dan informasi lainnya.

#### **Request**
- **Method**: PUT
- **Content-Type**: `multipart/form-data`
- **Headers**: Cookie `seller_info` wajib.
- **Params**:
  - `id`: ID produk.
- **Body**:
  - `productName` (string, opsional): Nama produk baru.
  - `productDescription` (string, opsional): Deskripsi produk baru.
  - `category_id` (string, opsional): ID kategori baru.
  - `stock` (integer, opsional): Stok baru (jika tanpa varian).
  - `productPrice` (float, opsional): Harga baru (jika tanpa varian).
  - `variants` (JSON string, opsional): Daftar varian baru atau yang diperbarui, contoh:
    ```json
    [
      { "id": "variant_id", "name": "Varian 1", "price": 10000, "stock": 10, "image_url": "url" },
      { "name": "Varian Baru", "price": 12000, "stock": 5 }
    ]
    ```
  - `productImagesToDelete` (JSON array/string, opsional): Daftar URL gambar produk yang akan dihapus.
  - `productImages` (file, opsional): Gambar produk baru (maksimum 10).
  - `variantImages` (file, opsional): Gambar varian baru (maksimum 10, sesuai urutan varian).

#### **Response**
- **200 OK**:
  ```json
  {
    "message": "✅ Produk berhasil diperbarui",
    "data": {
      "id": "product_id",
      "product_name": "Nama Produk",
      "product_description": "Deskripsi Produk",
      "product_price": 10000,
      "min_price": 10000,
      "max_price": 12000,
      "stock": 15,
      "product_image_url": ["url1", "url2"],
      "keywords": ["keyword1", "keyword2"],
      "variants": [
        { "id": "variant_id", "variant_name": "Varian 1", "variant_price": 10000, "variant_stock": 10, "variant_image_url": "url" },
        ...
      ]
    }
  }
  ```
- **401 Unauthorized**: Jika cookie `seller_info` tidak ada.
- **400 Bad Request**: Jika format varian atau `productImagesToDelete` tidak valid.
- **404 Not Found**: Jika produk tidak ditemukan atau bukan milik seller.
- **500 Internal Server Error**: Jika terjadi kesalahan server.

#### **Catatan**
- Gambar lama yang tidak dihapus akan digabung dengan gambar baru.
- Varian yang memiliki `id` akan diperbarui, yang tidak memiliki `id` akan ditambahkan sebagai varian baru.
- Harga dan stok produk dihitung ulang berdasarkan varian atau input langsung.

---

### 6. Hapus Produk atau Varian
**`DELETE /delete/:id`**

Menghapus produk atau varian tertentu berdasarkan ID.

#### **Request**
- **Method**: DELETE
- **Headers**: Cookie `seller_info` wajib.
- **Params**:
  - `id`: ID produk atau varian.
- **Query**:
  - `type` (string, default: `product`): Jenis yang akan dihapus (`product` atau `variant`).
  - `mode` (string, default: `all`): Mode penghapusan produk (`all` untuk produk + varian, `variant_only` untuk varian saja).

#### **Response**
- **200 OK**:
  - Untuk varian: 
    ```json
    { "message": "✅ Varian berhasil dihapus & stok diperbarui" }
    ```
  - Untuk produk (mode `variant_only`): 
    ```json
    { "message": "✅ Semua varian berhasil dihapus" }
    ```
  - Untuk produk (mode `all`): 
    ```json
    { "message": "✅ Produk dan semua varian berhasil dihapus" }
    ```
- **401 Unauthorized**: Jika cookie `seller_info` tidak ada.
- **404 Not Found**: Jika produk/varian tidak ditemukan atau bukan milik seller.
- **500 Internal Server Error**: Jika terjadi kesalahan server.

#### **Catatan**
- Menghapus varian akan memperbarui stok total produk.
- Menghapus produk (mode `all`) juga menghapus semua varian dan gambar terkait di Supabase Storage.
- Path gambar dihapus dari bucket `product-images` menggunakan path yang diekstrak dari URL.

---

## Teknologi yang Digunakan
- **Express.js**: Framework untuk API.
- **Multer**: Middleware untuk penanganan upload file.
- **Sharp**: Konversi gambar ke WebP.
- **Supabase**: Database dan storage untuk produk, varian, dan gambar.
- **Node-Cache**: Caching data produk.
- **UUID**: Pembuatan nama file unik untuk gambar.

## Catatan Tambahan
- Semua endpoint memastikan bahwa hanya produk milik seller yang login yang dapat diakses atau dimodifikasi.
- Gambar disimpan di Supabase Storage dengan struktur folder `seller_id/products/` untuk gambar produk dan `seller_id/variants/` untuk gambar varian.
- Fungsi `generateKeywords` digunakan untuk menghasilkan kata kunci dari nama dan deskripsi produk untuk keperluan pencarian.
- Fungsi `attachVariantsStockDiscountWithRealDiscount` menambahkan informasi varian dan diskon ke respons produk.