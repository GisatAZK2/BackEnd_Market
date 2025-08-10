# API Wilayah Indonesia dan Pembaruan Data Pengguna

Proyek ini menyediakan API berbasis Express.js untuk mengambil data wilayah administratif Indonesia (provinsi, kabupaten, kecamatan, dan kelurahan) menggunakan API Emsifa, serta endpoint untuk memperbarui data pengguna dengan dukungan unggah avatar dan pembaruan alamat berbasis wilayah. Kode ini mengasumsikan adanya sesi pengguna dengan cookie `user_info` untuk otentikasi.


## Penggunaan
1. **Mengambil Data Wilayah**:
   - Gunakan endpoint wilayah untuk mengambil data administratif secara hierarkis.
   - Contoh: Ambil provinsi dengan `https://backendmarket-production.up.railway.app/wilayah/provinsi`, lalu gunakan `id` untuk mengambil kabupaten, kecamatan, dan kelurahan.
2. **Memperbarui Profil Pengguna**:
   - Kirim permintaan `PUT` ke `https://backendmarket-production.up.railway.app/auth/user/:id` dengan field yang diperlukan.
   - Sertakan cookie `user_info` untuk otentikasi.
   - Sertakan file avatar (opsional) dan ID wilayah untuk pembaruan Gambar.
   - Contoh menggunakan `curl`:
     ```bash
     curl -X PUT http://localhost:3000/user/123 \
       -H "Cookie: user_info=nilai_cookie_anda" \
       -F "username=nama_pengguna_baru" \
       -F "provinsi_id=11" \
       -F "kota_id=1101" \
       -F "kecamatan_id=110101" \
       -F "kelurahan_id=1101012001" \
       -F "avatar=@/path/to/avatar.jpg"
     ```

## Daftar Isi
- [Fitur](#fitur)
- [Dependensi](#dependensi)
- [Endpoint API](#endpoint-api)
  - [Endpoint Wilayah](#endpoint-wilayah)
  - [Endpoint Pembaruan Pengguna](#endpoint-pembaruan-pengguna)
- [Pengaturan](#pengaturan)
- [Penggunaan](#penggunaan)
- [Penanganan Kesalahan](#penanganan-kesalahan)
- [Catatan](#catatan)

## Fitur
- Mengambil data wilayah administratif Indonesia (provinsi, kabupaten, kecamatan, kelurahan) dari API Emsifa.
- Memperbarui profil pengguna dengan field seperti nama pengguna, kata sandi, detail alamat, dan avatar.
- Mendukung input ID wilayah yang fleksibel (`provinsi_id` atau `provinsi`, dll.).
- Fungsi unggah avatar menggunakan penyimpanan Supabase.
- Penanganan kesalahan dasar untuk permintaan API dan operasi basis data yang gagal.

## Dependensi
- `express`: Framework web untuk Node.js.
- `node-fetch`: Untuk melakukan permintaan HTTP ke API Emsifa.
- `supabase`: Untuk operasi basis data dan penyimpanan (unggah avatar).
- `bcrypt`: Untuk hashing kata sandi.
- `multer`: Untuk menangani unggah file (avatar).
- Middleware: `upload.single("avatar")`, `detectSpam`, `verifyCaptcha`.

## Endpoint API

### Endpoint Wilayah
Endpoint ini mengambil data wilayah administratif Indonesia dari API Emsifa.

1. **GET https://backendmarket-production.up.railway.app/wilayah/provinsi**
   - **Deskripsi**: Mengambil semua data provinsi.
   - **Respons**: Array JSON berisi daftar provinsi.
   - **Contoh**:
     ```json
     [
       { "id": "11", "name": "Aceh" },
       { "id": "12", "name": "Sumatera Utara" }
     ]
     ```
   - **Respons Kesalahan**:
     ```json
     { "message": "❌ Gagal ambil data provinsi", "error": "<pesan kesalahan>" }
     ```

2. **GET https://backendmarket-production.up.railway.app/wilayah/kabupaten/:provinsiId**
   - **Deskripsi**: Mengambil data kabupaten untuk ID provinsi tertentu.
   - **Parameter**: `provinsiId` (misalnya, `11` untuk Aceh).
   - **Respons**: Array JSON berisi daftar kabupaten.
   - **Contoh**:
     ```json
     [
       { "id": "1101", "name": "Kabupaten Aceh Selatan" },
       { "id": "1102", "name": "Kabupaten Aceh Tenggara" }
     ]
     ```
   - **Respons Kesalahan**:
     ```json
     { "message": "❌ Gagal ambil data kabupaten", "error": "<pesan kesalahan>" }
     ```

3. **GET https://backendmarket-production.up.railway.app/wilayah/kecamatan/:kabupatenId**
   - **Deskripsi**: Mengambil data kecamatan untuk ID kabupaten tertentu.
   - **Parameter**: `kabupatenId` (misalnya, `1101` untuk Kabupaten Aceh Selatan).
   - **Respons**: Array JSON berisi daftar kecamatan.
   - **Contoh**:
     ```json
     [
       { "id": "110101", "name": "Bakongan" },
       { "id": "110102", "name": "Kluet Utara" }
     ]
     ```
   - **Respons Kesalahan**:
     ```json
     { "message": "❌ Gagal ambil data kecamatan", "error": "<pesan kesalahan>" }
     ```

4. **GET https://backendmarket-production.up.railway.app/wilayah/kelurahan/:kecamatanId**
   - **Deskripsi**: Mengambil data kelurahan untuk ID kecamatan tertentu.
   - **Parameter**: `kecamatanId` (misalnya, `110101` untuk Bakongan).
   - **Respons**: Array JSON berisi daftar kelurahan.
   - **Contoh**:
     ```json
     [
       { "id": "1101012001", "name": "Kuta Baro" },
       { "id": "1101012002", "name": "Ladang Baro" }
     ]
     ```
   - **Respons Kesalahan**:
     ```json
     { "message": "❌ Gagal ambil data kelurahan", "error": "<pesan kesalahan>" }
     ```

### Endpoint Pembaruan Pengguna
**PUT https://backendmarket-production.up.railway.app/auth/user/:id**
- **Deskripsi**: Memperbarui informasi profil pengguna, termasuk unggah avatar (opsional) dan detail alamat berdasarkan ID wilayah.
- **Middleware**:
  - `upload.single("avatar")`: Menangani unggah file avatar.
  - `detectSpam`: Middleware khusus untuk mendeteksi perilaku spam.
  - `verifyCaptcha`: Middleware khusus untuk memverifikasi CAPTCHA.
- **Otentikasi**: Mengasumsikan cookie `user_info` tersedia untuk validasi sesi.
- **Body Permintaan** (multipart/form-data atau JSON):
  - `username`: Nama pengguna baru (opsional).
  - `password`: Kata sandi baru (dihash menggunakan bcrypt, opsional).
  - `nama_penerima`: Nama penerima (opsional).
  - `no_telepon`: Nomor telepon (opsional).
  - `alamat_lengkap`: Alamat lengkap (opsional).
  - `kode_pos`: Kode pos (opsional).
  - `provinsi_id` atau `provinsi`: ID provinsi.
  - `kota_id` atau `kota`: ID kabupaten/kota.
  - `kecamatan_id` atau `kecamatan`: ID kecamatan.
  - `kelurahan_id` atau `kelurahan`: ID kelurahan.
  - `avatar`: File avatar (opsional).
- **Respons**: Data pengguna yang diperbarui.
  - **Contoh**:
    ```json
    {
      "message": "✅ User berhasil diupdate.",
      "user": {
        "id": "<user_id>",
        "email": "user@example.com",
        "username": "nama_pengguna_baru",
        "avatar": "<public_url>",
        "provinsi": "Aceh",
        "kota_kabupaten": "Kabupaten Aceh Selatan",
        "kecamatan": "Bakongan",
        "kelurahan": "Kuta Baro",
        "kode_pos": "12345",
        "nama_penerima": "John Doe",
        "no_telepon": "08123456789",
        "alamat_lengkap": "Jl. Contoh No. 123"
      }
    }
    ```
  - **Respons Kesalahan**:
    ```json
    { "error": "Gagal update user.", "detail": "<pesan kesalahan>" }
    ```

## Penanganan Kesalahan
- **Endpoint Wilayah**: Mengembalikan status 500 dengan pesan kesalahan JSON jika permintaan ke API Emsifa gagal.
- **Endpoint Pembaruan Pengguna**:
  - Mengembalikan status 500 untuk kesalahan basis data atau penyimpanan.
  - Memvalidasi ID wilayah secara hierarkis (misalnya, `kota_id` memerlukan `provinsi_id`).
  - Mencatat kesalahan ke konsol untuk debugging.

## Catatan
- Kode ini mengasumsikan cookie `user_info` telah diatur dan divalidasi di bagian lain aplikasi.
- Fungsi `getWilayahName` tidak ditampilkan dalam kode yang diberikan, tetapi diasumsikan mengambil nama wilayah berdasarkan ID dari respons API Emsifa.
- Pastikan bucket penyimpanan Supabase (`avatars`) dikonfigurasi dengan akses publik untuk mengambil URL avatar.
- API Emsifa (`https://www.emsifa.com/api-wilayah-indonesia/`) digunakan untuk data wilayah; verifikasi ketersediaan dan batas kecepatan (rate limit) untuk penggunaan produksi.
