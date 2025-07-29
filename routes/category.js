const express = require('express');
const multer = require('multer');
const supabase = require('../config/supabase');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// --- setup multer untuk upload gambar sementara ---
const upload = multer({ dest: 'uploads/' });

// ==================== CREATE CATEGORY ====================
router.post('/create', upload.single('image'), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ message: '❌ Nama kategori wajib diisi' });

  try {
    let imageUrl = null;

    // === Upload gambar jika ada ===
    if (req.file) {
      const fileExt = path.extname(req.file.originalname);
      const fileName = `${Date.now()}${fileExt}`;
      const filePath = `categories/${fileName}`;

      // baca file sebagai buffer (hindari error duplex)
      const fileBuffer = fs.readFileSync(req.file.path);

      const { error: uploadError } = await supabase.storage
        .from('category-images') // pastikan sudah buat bucket
        .upload(filePath, fileBuffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });

      // hapus file lokal setelah upload
      fs.unlinkSync(req.file.path);

      if (uploadError) throw uploadError;

      // dapatkan URL publik
      const { data: publicUrlData } = supabase.storage
        .from('category-images')
        .getPublicUrl(filePath);

      imageUrl = publicUrlData.publicUrl;
    }

    // === Insert ke database ===
    const { data, error } = await supabase
      .from('categories')
      .insert([{ name, description, image_url: imageUrl }])
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ message: '✅ Kategori berhasil ditambahkan', category: data });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal menambahkan kategori', error: err.message });
  }
});

// ==================== GET ALL CATEGORY ====================
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('categories').select('*');
    if (error) throw error;
    return res.status(200).json({ message: `✅ Ditemukan ${data.length} kategori`, categories: data });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal mengambil kategori', error: err.message });
  }
});

// ==================== DELETE CATEGORY ====================
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('categories').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ message: '✅ Kategori berhasil dihapus' });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal menghapus kategori', error: err.message });
  }
});

// ==================== GET CATEGORY BY ID ====================
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('id, name, description, image_url')
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ message: '❌ Kategori tidak ditemukan' });
    }

    return res.status(200).json({ message: '✅ Kategori ditemukan', category: data });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal mengambil kategori', error: err.message });
  }
});


module.exports = router;
