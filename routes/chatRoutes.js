const express = require('express');
const supabase = require('../config/supabase');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// 🔁 Buat room atau gunakan yang sudah ada
router.post('/start-chat', async (req, res) => {
  const { sender_id, receiver_id, type } = req.body; // type: 'seller' | 'admin'

  if (!sender_id || !receiver_id || !type) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi' });
  }

  try {
    // Cari room yang sudah ada
    const { data: existingRoom } = await supabase
      .from('chat_rooms')
      .select('*')
      .or(`(user1.eq.${sender_id},user2.eq.${receiver_id}), (user1.eq.${receiver_id},user2.eq.${sender_id})`)
      .eq('type', type)
      .maybeSingle();

    if (existingRoom) {
      return res.status(200).json({ message: '✅ Room ditemukan', room: existingRoom });
    }

    // Buat baru
    const { data: newRoom, error } = await supabase
      .from('chat_rooms')
      .insert([{
        id: uuidv4(),
        user1: sender_id,
        user2: receiver_id,
        type
      }])
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ message: '✅ Room baru dibuat', room: newRoom });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal membuat chat room', error: err.message });
  }
});

// 💬 Kirim pesan
router.post('/send-message', async (req, res) => {
  const { room_id, sender_id, message } = req.body;

  if (!room_id || !sender_id || !message) {
    return res.status(400).json({ message: '❌ Semua field wajib diisi' });
  }

  try {
    const { data, error } = await supabase
      .from('messages')
      .insert([{ room_id, sender_id, message }])
      .select();

    if (error) throw error;

    return res.status(201).json({ message: '✅ Pesan terkirim', data });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal kirim pesan', error: err.message });
  }
});

// 🧾 Ambil semua pesan di room
router.get('/messages/:room_id', async (req, res) => {
  const { room_id } = req.params;

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('room_id', room_id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return res.status(200).json({ messages: data });
  } catch (err) {
    return res.status(500).json({ message: '❌ Gagal ambil pesan', error: err.message });
  }
});

module.exports = router;
