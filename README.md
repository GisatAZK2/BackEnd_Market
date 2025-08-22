# Dokumentasi API Order

API ini menyediakan endpoint untuk mengelola order, termasuk konfirmasi penerimaan order oleh pembeli dan penghapusan order beserta item terkait. Base URL untuk API ini adalah:

```
https://backendmarket-production.up.railway.app/order
```

## Endpoint

### 1. Konfirmasi Penerimaan Order
- **Method**: POST
- **Path**: `/orders/:id/confirm-receive`
- **Deskripsi**: Mengkonfirmasi bahwa pembeli telah menerima order. Status order akan diperbarui menjadi "diterima oleh pembeli", rating deadline akan diatur menjadi 1 hari dari waktu konfirmasi, dan `confirm_by_buyers_deadline` akan dihapus.
- **Autentikasi**: Membutuhkan cookie `user_info` yang berisi informasi user (ID).
- **Parameter**:
  - `id` (path): ID dari order yang akan dikonfirmasi.
- **Contoh Request**:
  ```
  POST https://backendmarket-production.up.railway.app/order/orders/123/confirm-receive
  Headers: Cookie: user_info={"id": "user123"}
  ```
- **Contoh Response**:
  - Sukses (200):
    ```json
    {
      "message": "✅ Order berhasil dikonfirmasi diterima.",
      "order": {
        "id": "123",
        "status": "diterima oleh pembeli",
        "rating_deadline": "2025-08-23T17:06:00.000Z",
        "confirm_by_buyers_deadline": null
      }
    }
    ```
  - Gagal (401, Unauthorized):
    ```json
    { "message": "❌ Harus login." }
    ```
  - Gagal (403, Forbidden):
    ```json
    { "message": "⚠️ Tidak punya akses ke order ini." }
    ```
  - Gagal (404, Not Found):
    ```json
    { "message": "❌ Order tidak ditemukan." }
    ```
  - Gagal (400, Bad Request):
    ```json
    { "message": "⚠️ Hanya order yang sudah diantar oleh penjual / sudah diambil" }
    ```
  - Gagal (500, Server Error):
    ```json
    { "message": "❌ Gagal update status." }
    ```

### 2. Hapus Order
- **Method**: DELETE
- **Path**: `/orders/:id`
- **Deskripsi**: Menghapus order dan semua `order_items` terkait. Hanya order dengan status "diterima oleh pembeli" yang dapat dihapus.
- **Autentikasi**: Membutuhkan cookie `user_info` yang berisi informasi user (ID).
- **Parameter**:
  - `id` (path): ID dari order yang akan dihapus.
- **Contoh Request**:
  ```
  DELETE https://backendmarket-production.up.railway.app/order/orders/123
  Headers: Cookie: user_info={"id": "user123"}
  ```
- **Contoh Response**:
  - Sukses (200):
    ```json
    { "message": "✅ Order dan order_items berhasil dihapus. Rating tetap aman." }
    ```
  - Gagal (401, Unauthorized):
    ```json
    { "message": "❌ Harus login." }
    ```
  - Gagal (403, Forbidden):
    ```json
    { "message": "⚠️ Tidak punya akses ke order ini." }
    ```
  - Gagal (404, Not Found):
    ```json
    { "message": "❌ Order tidak ditemukan." }
    ```
  - Gagal (400, Bad Request):
    ```json
    { "message": "⚠️ Order hanya bisa dihapus jika sudah diterima oleh pembeli." }
    ```
  - Gagal (500, Server Error):
    ```json
    { "message": "❌ Gagal hapus order." }
    ```

## Catatan
- Pastikan cookie `user_info` valid dan berisi ID pengguna yang sesuai.
- Endpoint ini menggunakan Supabase sebagai database untuk mengelola tabel `orders` dan `order_items`.
- Rating deadline pada endpoint konfirmasi penerimaan diatur menjadi 1 hari setelah konfirmasi.
- Penghapusan order hanya dapat dilakukan oleh pengguna yang memiliki akses ke order tersebut dan hanya jika statusnya "diterima oleh pembeli".