const express = require("express");
const phoenixService = require("../service/phoenixService");

const router = express.Router();

// GET /api/chats
router.get("/", async (req, res) => {
  try {
    const chats = await phoenixService.listChats();
    res.json(chats);
  } catch (err) {
    console.error("❌ Error fetch chats:", err);
    res.status(500).json({ error: "Gagal ambil chat" });
  }
});

// GET /api/chats/:id
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const chat = await phoenixService.getChat(id);
    res.json(chat);
  } catch (err) {
    console.error("❌ Error fetch chat:", err);
    res.status(500).json({ error: "Gagal ambil chat" });
  }
});

// POST /api/chats
router.post("/", async (req, res) => {
  try {
    const chat = await phoenixService.createChat(req.body);
    res.json(chat);
  } catch (err) {
    console.error("❌ Error create chat:", err);
    res.status(400).json({ error: "Gagal buat chat", details: err });
  }
});

// GET /api/messages?chat_id=123
router.get("/messages", async (req, res) => {
  const { chat_id } = req.query;
  if (!chat_id) return res.status(400).json({ error: "chat_id wajib" });

  try {
    const messages = await phoenixService.listMessages(chat_id);
    res.json(messages);
  } catch (err) {
    console.error("❌ Error fetch messages:", err);
    res.status(500).json({ error: "Gagal ambil messages" });
  }
});

// POST /api/messages
router.post("/messages", async (req, res) => {
  const { chat_id, sender_id, body } = req.body;
  if (!chat_id || !sender_id || !body) {
    return res.status(400).json({ error: "chat_id, sender_id, dan body wajib" });
  }

  try {
    const message = await phoenixService.sendMessage(chat_id, { sender_id, body });
    res.json(message);
  } catch (err) {
    console.error("❌ Error send message:", err);
    res.status(500).json({ error: "Gagal kirim message" });
  }
});

module.exports = router;
