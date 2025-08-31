# Dokumentasi API Statistik Seller

Berikut adalah dokumentasi untuk endpoint API statistik seller yang tersedia pada base URL:  
**`https://backendmarket-production.up.railway.app/seller/V1/statsSeller`**

API ini menyediakan dua endpoint utama untuk mengambil data statistik penjualan harian dan daftar order harian untuk seller. Endpoint ini mendukung berbagai rentang waktu seperti hari ini, kemarin, beberapa hari, minggu, bulan, atau tahun.

## Autentikasi
- **Cookie**: Endpoint ini memerlukan autentikasi melalui cookie `seller_info` atau `user_info` yang berisi informasi seller (termasuk `seller_id`). Jika tidak ada cookie, Anda dapat menyertakan `seller_id` sebagai query parameter.
- **Format Cookie**: JSON string, contoh: `{"id": "seller123", "nama": "Toko ABC"}`.

## Endpoint 1: Statistik Order Harian (`/history-order-by-day`)

### Deskripsi
Mengambil statistik penjualan harian untuk seller dalam rentang waktu tertentu. Data yang dikembalikan mencakup jumlah pesanan, pelanggan baru, total penjualan, serta data kumulatif per hari.

### Method dan URL
**GET** `/history-order-by-day`

### Query Parameters
| Parameter | Tipe   | Deskripsi                                                                 |
|-----------|--------|---------------------------------------------------------------------------|
| `seller_id` | String | ID seller (opsional, jika tidak ada cookie `seller_info` atau `user_info`). |
| `start`   | String | Tanggal mulai dalam format `YYYY-MM-DD` (opsional).                        |
| `end`     | String | Tanggal akhir dalam format `YYYY-MM-DD` (opsional).                        |
| `range`   | String | Rentang waktu, contoh: `today`, `yesterday`, `7days`, `2weeks`, `1month`, `1year`. |
| `days`    | String | Jumlah hari ke belakang, contoh: `3` untuk 3 hari terakhir.               |

**Catatan**:
- Jika `start` dan `end` disediakan, parameter ini akan diutamakan.
- Jika `range` atau `days` disediakan, rentang waktu akan dihitung berdasarkan nilai tersebut.
- Jika tidak ada parameter waktu, defaultnya adalah 7 hari terakhir (termasuk hari ini).

### Contoh Permintaan
1. **Hari Ini**:
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=today
   ```
2. **Kemarin**:
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=yesterday

4. **Rentang Kustom Per Hari ( 2 hari / Seterusnya )**:
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=3days
   ```
3. **Rentang 1 Minggu /Seterusnya (2 Minggu Atau Lebih)**:
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=1weeks
   ```

5. **Rentang 1 Bulan Terakhir /Seterusnya**:
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=1month
   ```
6. **1 Tahun Terakhir**:
   ```
   GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/history-order-by-day?range=1year
   ```

### Contoh Respon
```json
{
  "message": "✅ Statistik berhasil diambil.",
  "seller_id": "seller123",
  "range": {
    "start": "2025-08-25",
    "end": "2025-08-31"
  },
  "summary": {
    "total_days": 7,
    "total_orders": 150,
    "total_new_customers": 30,
    "total_sales": 7500000.00
  },
  "per_day": [
    {
      "date": "2025-08-25",
      "orders_count": 20,
      "new_customers_count": 5,
      "total_sales": 1000000.00,
      "cumulative_sales": 1000000.00,
      "cumulative_orders": 20
    },
    ...
  ]
}
```

### Status Kode
- **200**: Berhasil mengambil data statistik.
- **400**: Format tanggal tidak valid atau parameter salah.
- **401**: Seller tidak terautentikasi atau `seller_id` tidak ditemukan.
- **500**: Kesalahan server atau gagal mengambil data dari database.

---

## Endpoint 2: Daftar Order Harian (`/order/daily`)

### Deskripsi
Mengambil daftar order harian untuk seller pada hari ini (berdasarkan zona waktu Asia/Jakarta). Data yang dikembalikan mencakup detail order seperti ID, status, waktu pembuatan, informasi pembeli, dan item pesanan. Endpoint ini menggunakan cache untuk meningkatkan performa.

### Method dan URL
**GET** `/order/daily`

### Query Parameters
Tidak ada query parameter tambahan. Endpoint ini hanya mengambil data untuk hari ini berdasarkan zona waktu Asia/Jakarta.

### Contoh Permintaan
```
GET https://backendmarket-production.up.railway.app/seller/V1/statsSeller/order/daily
```

### Contoh Respon
```json
{
  "message": "✅ Daftar order harian seller berhasil diambil.",
  "orders": [
    {
      "id": "order123",
      "status": "pending",
      "created_at": "2025-08-31T10:00:00.000+07:00",
      "buyer_info": {
        "username": "buyer123"
      },
      "order_items": [
        {
          "order_item_id": "item456",
          "product_id": "prod789",
          "product_name": "Produk A",
          "product_image_url": "https://example.com/image.jpg",
          "quantity": 2,
          "price_per_item": 50000,
          "discount_percentage": 10,
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

### Status Kode
- **200**: Berhasil mengambil daftar order (dari cache atau database).
- **401**: Seller tidak terautentikasi (cookie `seller_info` tidak ditemukan).
- **500**: Kesalahan server atau gagal mengambil data dari database.

---

## Catatan Tambahan
- **Zona Waktu**: Semua tanggal dan waktu menggunakan zona waktu **Asia/Jakarta**.
- **Cache**: Endpoint `/order/daily` menggunakan cache untuk mempercepat respons. Cache dihasilkan berdasarkan `seller_id` dan tanggal hari ini.
- **Format Tanggal**: Gunakan format `YYYY-MM-DD` untuk parameter `start` dan `end` pada endpoint `/history-order-by-day`.
- **Kesalahan Parsing**: Jika data seperti `buyer_address` atau `product_image_url` tidak dapat di-parse sebagai JSON, API akan menangani kasus tersebut dengan aman dan memberikan nilai fallback.

## Dependensi
- **Express**: Framework untuk menangani routing HTTP.
- **Supabase**: Digunakan untuk mengakses database.
- **Luxon**: Untuk pengelolaan tanggal dan waktu.
- **Node-Cache**: Untuk caching data order harian.