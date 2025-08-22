// ../service/phoenixService.js
const axios = require("axios");

const PHOENIX_BASE_URL = "http://localhost:4000/api"; // base URL Phoenix

module.exports = {
  // List all chats
  listChats: async () => {
    const res = await axios.get(`${PHOENIX_BASE_URL}/chats`);
    return res.data;
  },

  // Get single chat by ID
  getChat: async (id) => {
    const res = await axios.get(`${PHOENIX_BASE_URL}/chats/${id}`);
    return res.data;
  },

  // Create new chat
  createChat: async (data) => {
    const res = await axios.post(`${PHOENIX_BASE_URL}/chats`, data);
    return res.data;
  },

  // List messages in a chat
  listMessages: async (chatId) => {
    const res = await axios.get(`${PHOENIX_BASE_URL}/messages`, {
      params: { chat_id: chatId },
    });
    return res.data;
  },

  // Send message
  sendMessage: async (chatId, message) => {
    const res = await axios.post(`${PHOENIX_BASE_URL}/messages`, {
      chat_id: chatId,
      ...message,
    });
    return res.data;
  },
};
