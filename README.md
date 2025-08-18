# 📌 Dokumentasi API Flash Sale (Seller)

Base URL:

```
https://backendmarket-production.up.railway.app/seller/V1/promoteseller
```

Semua endpoint membutuhkan autentikasi **Seller** (kecuali endpoint publik `date-list`).

---

## 1. Daftarkan Produk ke Flash Sale

**Endpoint:**

```
POST /flash-sale/register

2 Mode :
  1. Single Product
  2. Product With Variant
```

1. Single product

**Request Body:**

```json
{
  "flash_sale_id": 110,
  "items" : [
    {
      "product_id": "903b914a-9d79-418b-8f89-d8ff9eb3f50a",
      "stock": 5,
      "discount_percentage": 67
    }
  ]
}

```

2. Product With Variant 

**Request Body:**

```json
{
  "flash_sale_id": 110,
  "items" : [
    {
      "product_id": "94ccd2cc-40c3-4731-afe6-40a8434f8929",
      "variants": [
        { "variant_id": "fff46aa4-f20c-4cb2-b879-49d3068ae9b5", "stock": 40, "discount_percentage": 10 }
      ]
    }
  ]
}

```


**Response Sukses:**

```json
{
  "message": "✅ Flash sale berhasil dibuat / produk didaftarkan",
  "flash_sale_id": "uuid",
  "items": [
    {
      "seller_id": "uuid-seller",
      "flash_sale_id": "uuid",
      "product_id": "uuid-produk",
      "variant_id": null,
      "flash_stock": 10,
      "discount_percentage": 20
    }
  ]
}
```

---

## 2. Ambil Daftar Flash Sale Tanggal & Sesi

**Endpoint:**

```
GET /flash-sale/date-list
```

**Response:**

```json
{
  "message": "✅ 3 flash sale ditemukan",
  "items": {
    "2025-08-18": {
      "pagi": [ { "id": "uuid", "tag": "upcoming", ... } ],
      "siang": [],
      "malam": []
    }
  }
}
```

* **tag:** `ongoing | ended | upcoming`
* **session:** `pagi | siang | malam`

---

## 3. List Semua Flash Sale Milik Seller

**Endpoint:**

```
GET /flash-sale/list
```

**Response:**

```json
{
  "message": "✅ Daftar flash sale seller",
  "data": [
    {
      "id": "uuid",
      "name": "Flash Sale Merdeka",
      "start_time": "2025-08-18T10:00:00+07:00",
      "end_time": "2025-08-18T12:00:00+07:00",
      "timezone": "Asia/Jakarta",
      "status": "enabled",
      "tag": "ongoing"
    }
  ]
}
```

---

## 4. Detail Flash Sale by ID

**Endpoint:**

```
GET /flash-sale/:id
```

**Response:**

```json
{
  "message": "✅ Detail flash sale",
  "data": {
    "id": "uuid",
    "name": "Flash Sale Merdeka",
    "start_time": "2025-08-18T10:00:00+07:00",
    "end_time": "2025-08-18T12:00:00+07:00",
    "timezone": "Asia/Jakarta",
    "status": "enabled",
    "products": [
      {
        "product": { "id": "uuid-produk", "name": "Sayur Kangkung" },
        "variants": [],
        "price_before": 20000,
        "discount_percentage": 20,
        "price_after": 16000
      }
    ]
  }
}
```

---

## 5. Update Produk Flash Sale

**Endpoint:**

```
PUT /flash-sale/:id/products
```

**Request Body:**

```json
{
  "items": [
    {
      "product_id": "uuid-produk",
      "stock": 5,
      "discount_percentage": 10
    },
    {
      "product_id": "uuid-produk-2",
      "variants": [
        { "variant_id": "uuid-variant", "stock": 3, "discount_percentage": 15 }
      ]
    }
  ]
}
```

**Response:**

```json
{
  "message": "✅ Produk flash sale berhasil ditambahkan / diupdate",
  "inserted": [ { ... } ],
  "updated": [ { ... } ]
}
```

---

## 6. Hapus Flash Sale / Produk

**Endpoint:**

```
DELETE /flash-sale/:id
```

### Mode 1: Hapus semua item dalam flash sale

```
DELETE /flash-sale/:id
```

**Response:**

```json
{ "message": "✅ Semua item dalam flash sale berhasil dihapus" }
```

### Mode 2: Hapus produk non-variant

```
DELETE /flash-sale/:id?product_id=uuid-produk
```

**Response:**

```json
{ "message": "✅ Item uuid-produk berhasil dihapus" }
```

### Mode 3: Hapus produk variant tertentu

```
DELETE /flash-sale/:id?product_id=uuid-produk&variant_id=uuid-variant
```

**Response:**

```json
{ "message": "✅ Item uuid-produk varian uuid-variant berhasil dihapus" }
```

---

# ⚠️ Catatan Penting

* Stok produk/varian akan otomatis **dikurangi** saat didaftarkan ke flash sale.
* Tidak bisa menambahkan produk yang sudah terdaftar di flash sale yang sama.
* `status` flash sale bisa berupa: `enabled` atau `disabled`.
