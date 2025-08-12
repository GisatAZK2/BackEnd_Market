# Dokumentasi API Checkout & Delivery Fee

Dokumentasi ini线索

System: ini menjelaskan dua endpoint API untuk menghitung biaya ongkir dan memproses checkout berdasarkan produk serta metode pengambilan (`pickupMethod`).

## Penting!

**⚠️ Harap Untuk Membaca Kasus Lebih Lanjut Untuk Rute Checkout Dan delivery_fee ⚠️**

## Daftar Isi
- [POST `/cart/delivery-fee`](#1-post-cartdelivery-fee)
  - [Deskripsi](#deskripsi)
  - [Request Body](#request-body)
  - [Response Sukses (200)](#response-sukses-200)
- [Contoh Kasus Request & Response](#contoh-kasus-request--response)
  - [Kasus 1: Semua Produk Diantar](#kasus-1-semua-produk-diantar)
  - [Kasus 2: Semua Produk Diambil (Pickup)](#kasus-2-semua-produk-diambil-pickup)
  - [Kasus 3: Campuran Produk Diantar dan Diambil](#kasus-3-campuran-produk-diantar-dan-diambil)
- [POST `/cart/checkout`](#2-post-cartcheckout)
  - [Deskripsi](#deskripsi-1)
  - [Request Body](#request-body-1)
  - [Response Sukses (200)](#response-sukses-200-1)
- [Contoh Kasus Request & Response](#contoh-kasus-request--response)
  - [Kasus 1: Semua Produk Diantar](#kasus-1-semua-produk-diantar)
  - [Kasus 2: Semua Produk Diambil (Pickup)](#kasus-2-semua-produk-diambil-pickup)
  - [Kasus 3: Campuran Produk Diantar dan Diambil](#kasus-3-campuran-produk-diantar-dan-diambil)
- [GET `/all`](#3-get-all)
  - [Deskripsi](#deskripsi-3)
- [GET `/:id`](#4-get-id)
  - [Deskripsi](#deskripsi-4)
- [Catatan](#catatan)

## 1. POST `/cart/delivery-fee` (Default)

### Deskripsi
Menghitung biaya ongkir dan total harga per seller berdasarkan produk yang di-checkout dan metode pengambilan (`pickupMethod`).

### Request Body
```json
{
  "itemsToCheckout": [
    {
    "qty": 1,
    "productId": "8a709e2c-5b6a-4036-a3ec-66a70209ed7a",
    "variantId": null
  },
  {
    "qty": 3,
    "productId": "f22255f5-06c1-48ce-9a66-916841a6e3d7",
    "variantId": null
  },
  {
    "qty": 5,
    "productId": "0ece8eb0-7531-4548-9a2c-831b98af01b8",
    "variantId": null
  }
  ]
}
```

### Response Sukses (200)
```json
{
    "message": "✅ Data checkout berhasil dihitung.",
    "sellers": [
        {
            "seller_id": "f664dffe-184c-4aeb-a37f-f16ea4adef84",
            "store_name": "Bakekok",
            "pickup_method": "diambil",
            "total_produk": 62500,
            "delivery_fee": 0,
            "total_semua": 62500
        },
        {
            "seller_id": "f6480e57-017c-47a1-be8e-b85f33882f6c",
            "store_name": "Toko Si Suki",
            "pickup_method": "diambil",
            "total_produk": 60000,
            "delivery_fee": 0,
            "total_semua": 60000
        }
    ],
    "total_produk_semua": 122500,
    "total_ongkir_semua": 0,
    "total_checkout_semua": 122500
}
```

## 2. POST `/cart/checkout`

### Deskripsi
Membuat order berdasarkan item yang di-checkout, mengelompokkan berdasarkan seller dan metode pengambilan. Mengirim notifikasi email dan menghapus item dari keranjang.

### Request Body
```json
{
  "itemsToCheckout": [
    {
      "productId": "string",
      "variantId": "string|null",
      "qty": number,
      "pickupMethod": "diantar" | "diambil"  // Opsional, default "diantar"
    }
  ],
  "pickupMethod": "diantar" | "diambil" // Opsional, default "diantar"
}
```

### Response Sukses (200)
```json
{
  "message": "✅ Berhasil checkout X order. (⏱ 1.23s)",
  "orders": [
    {
      "id": "uuid",
      "user_id": "uuid|null",
      "seller_id": "uuid",
      "pickup_method": "diantar" | "diambil",
      "status": "pending",
      "total_price": 112000,
      "delivery_fee": 12000,     // Hanya untuk 'diantar'
      "pickup_deadline": null    // Hanya untuk 'diambil'
    }
  ]
}
```
## 3. GET `/order/all`

### **Deskripsi**
**Mengambil daftar semua order untuk pengguna yang sudah login, dengan cache untuk performa lebih cepat. Mengembalikan informasi order termasuk item dan produk terkait.**

### **Request**
- **Metode**: GET
- **Header**: Cookie `user_info` berisi informasi pengguna (JSON dengan `id`).
- **Autentikasi**: Memerlukan login (cookie `user_info` dengan `id` pengguna).

### **Response Sukses (200)**
```json
{
  "message": "✅ Daftar order berhasil diambil.",
  "orders": [
    {
      "id": "uuid",
      "created_at": "2025-08-12T15:49:00Z",
      "total_price": 165000,
      "delivery_fee": 15000,
      "status": "pending",
      "pickup_method": "diantar" | "diambil",
      "pickup_deadline": "2025-08-13T04:49:00Z" | null,
      "order_items": [
        {
          "id": "uuid",
          "quantity": number,
          "variant_id": "string|null",
          "product": {
            "id": "string",
            "product_name": "string",
            "product_image_url": "string",
            "price": number,
            "discount": number,
            "finalPrice": number,
            "variants": [
              {
                "id": "string",
                "variant_name": "string",
                "variant_image_url": "string",
                "price": number,
                "discount": number,
                "finalPrice": number
              }
            ]
          }
        }
      ]
    }
  ],
  "cache": true | false
}
```

## 4. GET `/order/:id`

### **Deskripsi**
**Mengambil detail satu order berdasarkan ID untuk pengguna yang sudah login, dengan cache untuk performa lebih cepat. Mengembalikan informasi order termasuk item dan produk terkait.**

### **Request**
- **Metode**: GET
- **Parameter URL**: `id` (ID order)
- **Header**: Cookie `user_info` berisi informasi pengguna (JSON dengan `id`).
- **Autentikasi**: Memerlukan login (cookie `user_info` dengan `id` pengguna).

### **Response Sukses (200)**
```json
{
  "message": "✅ Order berhasil diambil." | "✅ Order berhasil diambil (cache).",
  "order": {
    "id": "uuid",
    "created_at": "2025-08-12T15:49:00Z",
    "total_price": 165000,
    "delivery_fee": 15000,
    "status": "pending",
    "pickup_method": "diantar" | "diambil",
    "pickup_deadline": "2025-08-13T04:49:00Z" | null,
    "order_items": [
      {
        "type": "single" | "variant",
        "id_product": "string",
        "id": "string|null",
        "product_name": "string",
        "variant_name": "string|null",
        "product_image_url": "string|null",
        "variant_image_url": "string|null",
        "quantity": number,
        "product_price": number,
        "original_price": number,
        "discountPercentage": number,
        "applied_discount": number,
        "finalPrice": number
      }
    ]
  }
}
```


## Contoh Kasus Request & Response

### 1. POST `/order/cart/checkout`
### Kasus 1: Semua Produk Diantar (Root `pickupMethod = "diantar"`)
**Request** `/order/cart/checkout`:
```json
{
  "itemsToCheckout": [
    {
    "qty": 1,
    "productId": "8a709e2c-5b6a-4036-a3ec-66a70209ed7a",
    "variantId": null
  },
  {
    "qty": 3,
    "productId": "f22255f5-06c1-48ce-9a66-916841a6e3d7",
    "variantId": null
  },
  {
    "qty": 5,
    "productId": "0ece8eb0-7531-4548-9a2c-831b98af01b8",
    "variantId": null
  }
  ],
  "pickupMethod": "diantar"
}
```
*Catatan*: Semua produk dianggap dikirim dengan jasa antar. `delivery_fee` dihitung berdasarkan `seller.delivery_fee`. `pickup_deadline` tidak diberikan.

**Response**:
```json

```

### Kasus 2: Semua Produk Diambil (Root `pickupMethod = "diambil"`)
**Request** `/order/cart/checkout`:
```json
{
  "itemsToCheckout": [
    {
    "qty": 1,
    "productId": "8a709e2c-5b6a-4036-a3ec-66a70209ed7a",
    "variantId": null
  },
  {
    "qty": 3,
    "productId": "f22255f5-06c1-48ce-9a66-916841a6e3d7",
    "variantId": null
  },
  {
    "qty": 5,
    "productId": "0ece8eb0-7531-4548-9a2c-831b98af01b8",
    "variantId": null
  }
  ],
  "pickupMethod": "diambil"
}
```
*Catatan*: Semua produk diambil sendiri. `delivery_fee = 0`. `pickup_deadline` diisi waktu 6 jam dari waktu checkout.

**Response**:
```json
{
    "message": "✅ Berhasil checkout 2 order. (⏱ 0.244s)",
    "orders": [
        {
            "id": "f81829cb-7984-42f0-8817-c86c33c59bc0",
            "user_id": "7bd2b9bf-231b-487b-a372-471f12fa990c",
            "seller_id": "f664dffe-184c-4aeb-a37f-f16ea4adef84",
            "total_price": 62500,
            "delivery_fee": 0,
            "pickup_method": "diambil",
            "status": "pending",
            "pickup_deadline": "2025-08-12T21:37:13.843",
            "created_at": "2025-08-12T22:37:13.901999"
        },
        {
            "id": "887f32a2-b871-4657-bb59-b9712de375fc",
            "user_id": "7bd2b9bf-231b-487b-a372-471f12fa990c",
            "seller_id": "f6480e57-017c-47a1-be8e-b85f33882f6c",
            "total_price": 60000,
            "delivery_fee": 0,
            "pickup_method": "diambil",
            "status": "pending",
            "pickup_deadline": "2025-08-12T21:37:13.957",
            "created_at": "2025-08-12T22:37:13.993046"
        }
    ]
}
```

### Kasus 3: Campuran (PickupMethod per Item)
**Request** `/order/cart/checkout`:
```json
{
 "itemsToCheckout" : [
  {
    "qty": 4,
    "productId": "e910873f-d68b-484e-9cf4-2dd3a953826a",
    "variantId": "d70cf15d-f7f5-49b7-9de7-b0e6bf097fc1",
     "pickupMethod": "diantar"
  },
   {
    "qty": 4,
    "productId": "e910873f-d68b-484e-9cf4-2dd3a953826a",
    "variantId": "d70cf15d-f7f5-49b7-9de7-b0e6bf097fc1",
     "pickupMethod": "diantar"
  },
  {
    "qty": 3,
    "productId": "68413c42-8e03-4506-9d67-ac60c3a31677",
    "variantId": null,
     "pickupMethod": "diambil"
  },
  {
    "qty": 3,
    "productId": "0ece8eb0-7531-4548-9a2c-831b98af01b8",
    "variantId": null,
     "pickupMethod": "diambil"
  },
  {
    "qty": 8,
    "productId": "94ccd2cc-40c3-4731-afe6-40a8434f8929",
    "variantId": "fff46aa4-f20c-4cb2-b879-49d3068ae9b5",
     "pickupMethod": "diantar"
  }
 ]
}
```
*Catatan*: Metode pengambilan mengikuti `pickupMethod` per item. Order dibuat per grup `seller_id` + `pickupMethod`. Ongkir dihitung per grup jika `pickupMethod = "diantar"`. `pickup_deadline` diberikan untuk grup `"diambil"`.

**Response**:
```json
{
    "message": "✅ Berhasil checkout 4 order. (⏱ 0.569s)",
    "orders": [
        {
            "id": "7fa247b1-05f6-4afb-b31c-cf2b1927801d",
            "user_id": "7bd2b9bf-231b-487b-a372-471f12fa990c",
            "seller_id": "f664dffe-184c-4aeb-a37f-f16ea4adef84",
            "total_price": 164000,
            "delivery_fee": 12000,
            "pickup_method": "diantar",
            "status": "pending",
            "pickup_deadline": null,
            "created_at": "2025-08-12T22:38:23.765546"
        },
        {
            "id": "2f60009a-afde-4b3c-a577-311e1b31c272",
            "user_id": "7bd2b9bf-231b-487b-a372-471f12fa990c",
            "seller_id": "f664dffe-184c-4aeb-a37f-f16ea4adef84",
            "total_price": 120000,
            "delivery_fee": 0,
            "pickup_method": "diambil",
            "status": "pending",
            "pickup_deadline": "2025-08-12T21:38:23.815",
            "created_at": "2025-08-12T22:38:23.856609"
        },
        {
            "id": "1070be7e-53ed-4fd7-aef7-c0a5a3bd49e8",
            "user_id": "7bd2b9bf-231b-487b-a372-471f12fa990c",
            "seller_id": "f6480e57-017c-47a1-be8e-b85f33882f6c",
            "total_price": 36000,
            "delivery_fee": 0,
            "pickup_method": "diambil",
            "status": "pending",
            "pickup_deadline": "2025-08-12T21:38:23.903",
            "created_at": "2025-08-12T22:38:23.93266"
        },
        {
            "id": "5a56453a-3164-4810-a7ef-263f6d127a8c",
            "user_id": "7bd2b9bf-231b-487b-a372-471f12fa990c",
            "seller_id": "f6480e57-017c-47a1-be8e-b85f33882f6c",
            "total_price": 210000,
            "delivery_fee": 10000,
            "pickup_method": "diantar",
            "status": "pending",
            "pickup_deadline": null,
            "created_at": "2025-08-12T22:38:24.001545"
        }
    ]
}
```
---

### 2. POST `/order/cart/delivery-fee`
### Kasus 1: Semua Produk Diantar
**Request** `/order/cart/delivery-fee`:
```json
{
  "itemsToCheckout": [
    {
    "qty": 1,
    "productId": "8a709e2c-5b6a-4036-a3ec-66a70209ed7a",
    "variantId": null
  },
  {
    "qty": 3,
    "productId": "f22255f5-06c1-48ce-9a66-916841a6e3d7",
    "variantId": null
  },
  {
    "qty": 5,
    "productId": "0ece8eb0-7531-4548-9a2c-831b98af01b8",
    "variantId": null
  }
  ],
  "pickupMethod": "diantar"
}
```

**Response**:
```json
{
    "message": "✅ Data checkout berhasil dihitung.",
    "sellers": [
        {
            "seller_id": "f664dffe-184c-4aeb-a37f-f16ea4adef84",
            "store_name": "Bakekok",
            "pickup_method": "diantar",
            "total_produk": 62500,
            "delivery_fee": 12000,
            "total_semua": 74500
        },
        {
            "seller_id": "f6480e57-017c-47a1-be8e-b85f33882f6c",
            "store_name": "Toko Si Suki",
            "pickup_method": "diantar",
            "total_produk": 60000,
            "delivery_fee": 10000,
            "total_semua": 70000
        }
    ],
    "total_produk_semua": 122500,
    "total_ongkir_semua": 22000,
    "total_checkout_semua": 144500
}
```

### Kasus 2: Semua Produk Diambil (Pickup)
**Request** `/cart/delivery-fee`:
```json
{
  "itemsToCheckout": [
    {
    "qty": 1,
    "productId": "8a709e2c-5b6a-4036-a3ec-66a70209ed7a",
    "variantId": null
  },
  {
    "qty": 3,
    "productId": "f22255f5-06c1-48ce-9a66-916841a6e3d7",
    "variantId": null
  },
  {
    "qty": 5,
    "productId": "0ece8eb0-7531-4548-9a2c-831b98af01b8",
    "variantId": null
  }
  ],
  "pickupMethod": "diambil"
}
```
*Catatan*: Jika `pickupMethod` tidak disertakan, defaultnya `"diambil"`.

**Response**:
```json
{
    "message": "✅ Data checkout berhasil dihitung.",
    "sellers": [
        {
            "seller_id": "f664dffe-184c-4aeb-a37f-f16ea4adef84",
            "store_name": "Bakekok",
            "pickup_method": "diambil",
            "total_produk": 62500,
            "delivery_fee": 0,
            "total_semua": 62500
        },
        {
            "seller_id": "f6480e57-017c-47a1-be8e-b85f33882f6c",
            "store_name": "Toko Si Suki",
            "pickup_method": "diambil",
            "total_produk": 60000,
            "delivery_fee": 0,
            "total_semua": 60000
        }
    ],
    "total_produk_semua": 122500,
    "total_ongkir_semua": 0,
    "total_checkout_semua": 122500
}
```

### Kasus 3: Campuran Produk Diantar dan Diambil
**Request** `/cart/delivery-fee`:
```json
{
 "itemsToCheckout" : [
  {
    "qty": 4,
    "productId": "e910873f-d68b-484e-9cf4-2dd3a953826a",
    "variantId": "d70cf15d-f7f5-49b7-9de7-b0e6bf097fc1",
     "pickupMethod": "diantar"
  },
   {
    "qty": 4,
    "productId": "e910873f-d68b-484e-9cf4-2dd3a953826a",
    "variantId": "d70cf15d-f7f5-49b7-9de7-b0e6bf097fc1",
     "pickupMethod": "diantar"
  },
  {
    "qty": 3,
    "productId": "68413c42-8e03-4506-9d67-ac60c3a31677",
    "variantId": null,
     "pickupMethod": "diambil"
  },
  {
    "qty": 3,
    "productId": "0ece8eb0-7531-4548-9a2c-831b98af01b8",
    "variantId": null,
     "pickupMethod": "diambil"
  },
  {
    "qty": 8,
    "productId": "94ccd2cc-40c3-4731-afe6-40a8434f8929",
    "variantId": "fff46aa4-f20c-4cb2-b879-49d3068ae9b5",
     "pickupMethod": "diantar"
  }
 ]
}

```

**Response**:
```json
{
    "message": "✅ Data checkout berhasil dihitung.",
    "sellers": [
        {
            "seller_id": "f664dffe-184c-4aeb-a37f-f16ea4adef84",
            "store_name": "Bakekok",
            "pickup_method": "diantar",
            "total_produk": 40000,
            "delivery_fee": 12000,
            "total_semua": 52000
        },
        {
            "seller_id": "f664dffe-184c-4aeb-a37f-f16ea4adef84",
            "store_name": "Bakekok",
            "pickup_method": "diambil",
            "total_produk": 120000,
            "delivery_fee": 0,
            "total_semua": 120000
        },
        {
            "seller_id": "f6480e57-017c-47a1-be8e-b85f33882f6c",
            "store_name": "Toko Si Suki",
            "pickup_method": "diambil",
            "total_produk": 36000,
            "delivery_fee": 0,
            "total_semua": 36000
        },
        {
            "seller_id": "f6480e57-017c-47a1-be8e-b85f33882f6c",
            "store_name": "Toko Si Suki",
            "pickup_method": "diantar",
            "total_produk": 64000,
            "delivery_fee": 10000,
            "total_semua": 74000
        }
    ],
    "total_produk_semua": 260000,
    "total_ongkir_semua": 22000,
    "total_checkout_semua": 282000
}
```

## Catatan
- **Endpoint `GET /all` dan `GET /:id` memerlukan autentikasi melalui cookie `user_info` dengan `id` pengguna.**
- **Cache digunakan untuk meningkatkan performa pada endpoint `GET /all` dan `GET /:id`.**
- **`pickupMethod` yang valid: `"diantar"` atau `"diambil"`.**
- **Ongkos kirim (`delivery_fee`) dihitung per grup `seller` + `pickupMethod`.**
- **Order dibuat per grup `seller` + `pickupMethod`.**
- **Email notifikasi dikirim otomatis jika user sudah login.**
- **pickup_deadline** hanya diberikan untuk `pickupMethod = "diambil"`, diatur **6 jam dari waktu checkout**.
- Jika `pickupMethod` tidak disertakan di level item, maka akan mengikuti `pickupMethod` di level root (jika ada) atau default ke **"diantar"** untuk `/cart/checkout` dan **"diambil"** untuk `/cart/delivery-fee`.
- Email notifikasi dikirim otomatis jika user sudah login.
