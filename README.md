# Dokumentasi API Chat Service

Dokumentasi ini menjelaskan cara melakukan request ke endpoint API chat service beserta format respons yang dihasilkan. Service ini mendukung komunikasi antara customer dan seller, termasuk pengiriman pesan teks, stiker, gambar, produk, dan varian produk. Semua endpoint memerlukan autentikasi melalui cookie (`user_info` untuk customer atau `seller_info` untuk seller).

## Base URL
   = `https://backendmarket-production.up.railway.app`
 

## Autentikasi
Semua request memerlukan cookie:
- **Customer**: Cookie `user_info` berisi JSON dengan field `id`, `email`, `username`, `avatar`, dan opsional `seller_id`.
- **Seller**: Cookie `seller_info` berisi JSON dengan field `id`, `email`, dan `store_name`.

Cookie harus di-encode dalam format URL-encoded JSON.

## Endpoint

### 1. Mendapatkan Daftar Chat
- **Rute**: `GET /seller/v1/chats/chats/list` (untuk seller) atau `GET /chats/chats/list` (untuk customer)
- **Deskripsi**: Mengambil daftar chat yang terkait dengan user atau seller berdasarkan cookie.
- **Header**:
  - `Content-Type: application/json`
  - `Cookie: user_info=<encoded_json>` (untuk customer) atau `Cookie: seller_info=<encoded_json>` (untuk seller)
- **Query Parameters**: Tidak ada
- **Response**:
  - **Status**: `200 OK`
  - **Body** (JSON):
    ```json
    [
      {
        "id": "uuid",
        "user_id": "uuid",
        "seller_id": "uuid|null",
        "admin_id": "uuid|null",
        "type": "seller|admin",
        "queue_number": "integer|null",
        "created_at": "timestamp",
        "username": "string|null", // hanya untuk seller
        "avatar": "string|null", // hanya untuk seller
        "store_name": "string|null", // hanya untuk customer
        "store_image_url": "string|null" // hanya untuk customer
      }
    ]
    ```
  - **Error**:
    - `400 Bad Request`: Tidak ada cookie `user_info` atau `seller_info`.
    - `500 Internal Server Error`: Kesalahan database.

### 2. Mengirim Pesan
- **Rute**: `POST /chats/messages/send` (untuk customer) atau `POST /seller/v1/messages/messages/send` (untuk seller)
- **Deskripsi**: Mengirim pesan teks, stiker, gambar, produk, atau varian produk. Mendukung upload file untuk gambar.
- **Header**:
  - Untuk teks/stiker/produk/varian:
    - `Content-Type: application/json`
    - `Cookie: user_info=<encoded_json>` (customer) atau `Cookie: seller_info=<encoded_json>` (seller)
  - Untuk gambar:
    - `Content-Type: multipart/form-data`
    - `Cookie: user_info=<encoded_json>` atau `Cookie: seller_info=<encoded_json>`
- **Body**:
  - **JSON** (untuk teks/stiker/produk/varian):
    ```json
    {
      "chat_id": "uuid",
      "sender_type": "user|seller",
      "body": "string|uuid",
      "type": "text|sticker|product|variant"
    }
    ```
  - **Multipart Form** (untuk gambar):
    - `chat_id`: UUID chat
    - `sender_type`: `user` atau `seller`
    - `body`: String (opsional, diabaikan jika ada file)
    - `type`: String (opsional, otomatis `image` jika ada file)
    - `file`: File gambar (PNG/JPG)
- **Catatan**:
  - Jika `chat_id` kosong dan `sender_type` adalah `user`, chat baru akan dibuat otomatis dengan tipe `seller` (memerlukan `seller_id` di cookie `user_info`).
  - Untuk tipe `sticker`, `product`, atau `variant`, `body` harus berupa UUID yang valid dari entitas terkait.
  - Untuk tipe `image`, `body` akan diisi dengan URL hasil upload ke Supabase.
- **Response**:
  - **Status**: `200 OK`
  - **Body** (JSON):
    ```json
    {
      "id": "uuid",
      "chat_id": "uuid",
      "sender_type": "user|seller",
      "sender_id": "uuid",
      "body": "string|uuid|url",
      "type": "text|sticker|product|variant|image",
      "meta": {
        // Untuk product:
        "id": "uuid",
        "product_name": "string",
        "product_price": "integer",
        "product_image_url": "string",
        // Untuk variant:
        "id": "uuid",
        "variant_name": "string",
        "variant_price": "float",
        "variant_image_url": "string",
        "product_id": "uuid",
        // Untuk sticker:
        "id": "uuid",
        "sticker_name": "string",
        "sticker_image_url": "string",
        // Untuk image:
        "url": "string"
      },
      "created_at": "timestamp"
    }
    ```
## Cara Upload File (Gambar, Stiker, Produk, Varian)

### 2.1. Upload Gambar
- **Metode**: Gunakan endpoint `POST /chats/messages/send` Untuk Customer / `POST /seller/v1/messages/messages/send` (untuk seller) dengan `Content-Type: multipart/form-data` apabila Anda Menggunakan Websocket Gunakan action `send`.
- **Form Fields**:
  - `chat_id`: UUID chat
  - `sender_type`: `user` atau `seller`
  - `file`: File gambar (PNG/JPG)
  - `body`: Opsional (diabaikan jika ada file)
  - `type`: Opsional (otomatis `image` jika ada file)
- **Proses**:
  - File diunggah ke Supabase bucket `chat-images`.
  - URL publik file disimpan sebagai `body` pesan dengan tipe `image`.
  - Meta berisi `{ "url": "public_url" }`.
- **Contoh cURL**:
  ```bash
  curl -X POST http://localhost:3000/messages/send \
    -H "Cookie: user_info=<encoded_json>" \
    -F "chat_id=<uuid>" \
    -F "sender_type=user" \
    -F "file=@/path/to/image.jpg"
  ```

### 2.2. Mengirim Stiker
- Gunakan endpoint `POST /chats/messages/send` Untuk Customer / `POST /seller/v1/messages/messages/send` (untuk seller) dengan `Content-Type: multipart/form-data` apabila Anda Menggunakan Websocket Gunakan action `send`.
- **Body**:
  - `type`: `sticker`
  - `body`: UUID stiker yang valid (dari tabel `stickers`)
- **Proses**:
  - UUID divalidasi terhadap tabel `stickers`.
  - Meta diisi dengan `{ "id": "uuid", "sticker_name": "string", "sticker_image_url": "string" }`.
- **Contoh JSON**:
  ```json
  {
    "chat_id": "uuid",
    "sender_type": "user",
    "body": "sticker_uuid",
    "type": "sticker"
  }
  ```

### 2.3. Mengirim Produk
- **Metode**: Gunakan endpoint `POST /chats/messages/send` Untuk Customer / `POST /seller/v1/messages/messages/send` (untuk seller) dengan `Content-Type: multipart/form-data` apabila Anda Menggunakan Websocket Gunakan action `send`.
- **Body**:
  - `type`: `product`
  - `body`: UUID produk yang valid (dari tabel `products`)
- **Proses**:
  - UUID divalidasi terhadap tabel `products`.
  - Meta diisi dengan `{ "id": "uuid", "product_name": "string", "product_price": "integer", "product_image_url": "string" }`.
- **Contoh JSON**:
  ```json
  {
    "chat_id": "uuid",
    "sender_type": "seller",
    "body": "product_uuid",
    "type": "product"
  }
  ```

### 2.4. Mengirim Varian Produk
- **Metode**: Gunakan endpoint `POST /chats/messages/send` Untuk Customer / `POST /seller/v1/messages/messages/send` (untuk seller) dengan `Content-Type: multipart/form-data` apabila Anda Menggunakan Websocket Gunakan action `send`.
- **Body**:
  - `type`: `variant`
  - `body`: UUID varian yang valid (dari tabel `product_variants`)
- **Proses**:
  - UUID divalidasi terhadap tabel `product_variants`.
  - Meta diisi dengan `{ "id": "uuid", "variant_name": "string", "variant_price": "float", "variant_image_url": "string", "product_id": "uuid" }`.
- **Contoh JSON**:
  ```json
  {
    "chat_id": "uuid",
    "sender_type": "seller",
    "body": "variant_uuid",
    "type": "variant"
  }
  ```
  
  - **Error**:
    - `400 Bad Request`: Body tidak valid, `sender_type` salah, atau `chat_id` kosong (jika tidak bisa membuat chat baru).
    - `401 Unauthorized`: Cookie `user_info` atau `seller_info` tidak ada.
    - `500 Internal Server Error`: Kesalahan database atau upload ke Supabase.



### 3. Menghapus Chat
- **Rute**: `/chats/chats/:idchat` Untuk Customer Atau `/seller/V1/chats/chats/:idchat` untuk Seller 
- **Deskripsi**: Menghapus chat dan semua pesan terkait, termasuk file gambar di Supabase.
- **Header**:
  - `Cookie: user_info=<encoded_json>` atau `Cookie: seller_info=<encoded_json>`
- **Path Parameter**:
  - `id`: UUID chat
- **Response**:
  - **Status**: `200 OK`
  - **Body** (JSON):
    ```json
    {
      "message": "chat and messages deleted"
    }
    ```
  - **Error**:
    - `400 Bad Request`: `id` tidak valid atau kosong.
    - `500 Internal Server Error`: Kesalahan database atau penghapusan file di Supabase.

### 4. WebSocket
- **Rute**: `/ws` (diakses melalui `ws://localhost:3000/ws-seller` untuk seller atau `ws://localhost:3000/ws-customer` untuk customer)
- **Deskripsi**: Menangani komunikasi real-time untuk chat, termasuk subscribe ke chat, mengirim pesan, dan mengambil riwayat pesan.
- **Header**:
  - `Cookie: user_info=<encoded_json>` atau `Cookie: seller_info=<encoded_json>`
- **Payload WebSocket** (JSON):
  - **Subscribe**:
    ```json
    {
      "action": "subscribe",
      "chat_id": "uuid"
    }
    ```
  - **Send**:
    ```json
    {
      "action": "send",
      "chat_id": "uuid",
      "sender_type": "user|seller",
      "body": "string|uuid",
      "type": "text|sticker|product|variant"
    }
    ```
  - **History**:
    ```json
    {
      "action": "history",
      "chat_id": "uuid"
    }
    ```
- **Response WebSocket**:
  - **Untuk Subscribe/Send**: Broadcast pesan baru ke semua klien di `chat_id`:
    ```json
    {
      "id": "uuid",
      "chat_id": "uuid",
      "sender_type": "user|seller",
      "sender_id": "uuid",
      "body": "string|uuid|url",
      "type": "text|sticker|product|variant|image",
      "meta": {...}, // sama seperti di endpoint send message
      "created_at": "timestamp"
    }
    ```
  - **Untuk History**:
    ```json
    {
      "action": "history",
      "chat_id": "uuid",
      "messages": [
        {
          "id": "uuid",
          "chat_id": "uuid",
          "sender_type": "user|seller",
          "sender_id": "uuid",
          "body": "string|uuid|url",
          "type": "text|sticker|product|variant|image",
          "meta": {...},
          "created_at": "timestamp"
        }
      ]
    }
    ```
- **Catatan**:
  - WebSocket akan otomatis mengarahkan `/ws-seller` atau `/ws-customer` ke `/ws` di backend.
  - Pastikan cookie valid disertakan saat koneksi.



## Catatan Tambahan
- **Supabase**: File gambar diunggah ke bucket `chat-images` di Supabase. Pastikan bucket diset sebagai publik untuk akses URL.
- **WebSocket**: Gunakan untuk komunikasi real-time. Pastikan klien subscribe ke `chat_id` sebelum mengirim atau menerima pesan.
- **Pembersihan Data**: Pesan lebih dari 4 bulan akan otomatis dihapus melalui proses cleanup harian.
- **Error Handling**: Selalu periksa kode status dan pesan error dalam respons untuk menangani kasus gagal.