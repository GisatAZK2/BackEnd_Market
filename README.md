# Dokumentasi API Statistik Seller

Berikut adalah dokumentasi untuk endpoint API statistik seller yang digunakan untuk mengambil data statistik penjualan dan pesanan harian seller. API ini dibangun menggunakan Express.js dengan integrasi Supabase untuk manajemen data dan NodeCache untuk caching.

## Base URL
```
https://backendmarket-production.up.railway.app/seller/V1/statsSeller
```

## Endpoint

### 1. GET /history-order-by-day
Mengambil statistik penjualan harian seller untuk rentang waktu tertentu.

#### Parameter Query
- `seller_id` (opsional): ID seller. Jika tidak disediakan, akan diambil dari cookie `seller_info` atau `user_info`.
- `start` (opsional): Tanggal mulai (format: `YYYY-MM-DD`). Jika tidak disediakan, akan menggunakan rentang default.
- `end` (opsional): Tanggal akhir (format: `YYYY-MM-DD`). Jika tidak disediakan, akan menggunakan tanggal hari ini.
- `range` (opsional): Rentang waktu. Nilai yang didukung:
  - `1week` atau `7days`: 7 hari terakhir.
  - `7weeks`: 7 minggu terakhir.
  - `1year` atau `year`: 1 tahun terakhir.
  - `<jumlah>days`: Misalnya, `30days` untuk 30 hari terakhir.
- `days` (opsional): Jumlah hari untuk rentang waktu (misalnya, `30` untuk 30 hari).

#### Contoh Permintaan
1. **Statistik Hari Ini**
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=1day
   ```
2. **Statistik 7 Hari Terakhir**
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=7days
   ```
3. **Statistik 1 Bulan Terakhir (30 Hari)**
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=30days
   ```
4. **Statistik 1 Tahun Terakhir**
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=1year
   ```

#### Contoh Respons
```json
{
  "message": "✅ Statistik berhasil diambil.",
  "seller_id": "12345",
  "range": {
    "start": "2025-08-25",
    "end": "2025-08-31"
  },
  "summary": {
    "total_days": 7,
    "total_orders": 50,
    "total_new_customers": 10,
    "total_sales": 5000000.00
  },
  "per_day": [
    {
      "date": "2025-08-25",
      "orders_count": 5,
      "new_customers_count": 1,
      "total_sales": 500000.00,
      "cumulative_sales": 500000.00,
      "cumulative_orders": 5
    },
    ...
  ]
}
```

#### Catatan
- Data di-cache hingga tengah malam waktu Asia/Jakarta untuk mengurangi beban server.
- Jika `seller_id` tidak valid atau tidak ada, respons akan mengembalikan status `401`.
- Jika format tanggal tidak valid, respons akan mengembalikan status `400`.

---

### 2. GET /order/daily
Mengambil daftar pesanan harian seller untuk hari ini.

#### Parameter Query
- Tidak ada parameter query yang diperlukan. Seller diidentifikasi melalui cookie `seller_info`.

#### Contoh Permintaan
```
GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/order/daily
```

#### Contoh Respons
```json
{
    "message": "✅ Daftar order harian seller berhasil diambil.",
    "orders": [
        {
            "id": "1252239b-9fff-4ce9-a865-6a74f169daf6",
            "status": "pending",
            "created_at": "2025-08-31T17:40:31.636916",
            "buyer_info": {
                "username": "Azz"
            },
            "order_items": [
                {
                    "product_id": "a05296c6-b63c-4080-96fd-1692fb21a972",
                    "product_name": "Wafer Superstar",
                    "product_image_url": "https://hihfiptclwrwuklojdec.supabase.co/storage/v1/object/public/product-images/f6480e57-017c-47a1-be8e-b85f33882f6c/products/09a40cdf-10a9-49ba-85aa-9c2946550f6c.webp",
                    "quantity": 0,
                    "price_per_item": 17778,
                    "discount_percentage": 0,
                    "variant": null
                }
            ]
        },
        {
            "id": "e634e414-1b50-41a6-baaa-e3c3585264e6",
            "status": "sedang di kemas",
            "created_at": "2025-08-31T17:37:10.097117",
            "buyer_info": {
                "username": "gisatazk2"
            },
            "order_items": [
                {
                    "product_id": "69bec226-9b43-40a0-ab70-b582e4e2728d",
                    "product_name": "Slai Olai",
                    "product_image_url": "https://hihfiptclwrwuklojdec.supabase.co/storage/v1/object/public/product-images/f6480e57-017c-47a1-be8e-b85f33882f6c/products/ffa084b4-3a28-4fda-9641-af526f0f673a.webp",
                    "quantity": 0,
                    "price_per_item": 42000,
                    "discount_percentage": 0,
                    "variant": null
                }
            ]
        },
        {
            "id": "1fc9378a-2839-40cf-b2ee-fdc08b054dad",
            "status": "sedang di kemas",
            "created_at": "2025-08-31T10:23:18.773687",
            "buyer_info": {
                "username": "gisatazk2"
            },
            "order_items": [
                {
                    "product_id": "ef261209-39c0-4cba-afff-b90e2f6178be",
                    "product_name": "Test",
                    "product_image_url": "https://hihfiptclwrwuklojdec.supabase.co/storage/v1/object/public/product-images/f6480e57-017c-47a1-be8e-b85f33882f6c/products/82c0c3cd-5626-41a9-9465-68813399d12b.webp",
                    "quantity": 0,
                    "price_per_item": 30000,
                    "discount_percentage": 0,
                    "variant": null
                }
            ]
        }
    ],
    "range": {
        "startOfDay": "2025-08-31T00:00:00.000+07:00",
        "endOfDay": "2025-08-31T23:59:59.999+07:00"
    }
}
```

#### Catatan
- Data di-cache hingga tengah malam waktu Asia/Jakarta.
- Jika cookie `seller_info` tidak tersedia atau tidak valid, respons akan mengembalikan status `401`.
- Jika tidak ada pesanan untuk hari ini, respons akan mengembalikan array `orders` kosong dengan status `200`.

## Autentikasi
- Endpoint memerlukan autentikasi melalui cookie `seller_info` atau `user_info` untuk mengidentifikasi seller.
- Untuk endpoint `/history-order-by-day`, `seller_id` dapat disediakan sebagai query parameter sebagai alternatif.

## Caching
- Data statistik dan pesanan di-cache menggunakan `node-cache` untuk meningkatkan performa.
- Cache akan kadaluarsa setiap tengah malam waktu Asia/Jakarta.

## Error Handling
- **401 Unauthorized**: Jika seller tidak terautentikasi atau `seller_id` tidak valid.
- **400 Bad Request**: Jika format tanggal atau parameter tidak valid.
- **500 Internal Server Error**: Jika terjadi kesalahan server atau gagal mengambil data dari Supabase.

## Dependensi
- **Express.js**: Framework untuk menangani routing dan permintaan HTTP.
- **Supabase**: Untuk mengakses dan mengelola data penjualan dan pesanan.
- **Luxon**: Untuk manipulasi tanggal dan waktu dalam zona waktu Asia/Jakarta.
- **NodeCache**: Untuk caching data guna meningkatkan performa.