// 📁 routes/category.js
const express = require('express');
const supabase = require('../config/supabase');

const router = express.Router();


router.post('/create', async (req, res) => {
  const { name, description } = req.body;

  if (!name) return res.status(400).json({ message: '❌ Nama kategori wajib diisi' });

  try {
    const { data, error } = await supabase
      .from('categories')
      .insert([{ name, description }])
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ message: '✅ Kategori berhasil ditambahkan', category: data });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal menambahkan kategori', error: err.message });
  }
});


router.get('/all', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*');

    if (error) throw error;

    return res.status(200).json({ message: `✅ Ditemukan ${data.length} kategori`, categories: data });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal mengambil kategori', error: err.message });
  }
});

// 🗑️ Hapus kategori
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('categories')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return res.status(200).json({ message: '✅ Kategori berhasil dihapus' });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal menghapus kategori', error: err.message });
  }
});

module.exports = router;
