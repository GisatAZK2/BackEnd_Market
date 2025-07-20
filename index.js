// 🔁 Tambahkan Realtime Support dengan Socket.IO
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const requireApiKey = require('./middleware/requireApiKey');
const rateLimiter = require('./middleware/ratelimiter');
const connect = require('./config/supabase');
const authRoutes = require('./routes/auth');
const forumpendaftaran = require('./routes/forum-pendaftaran');
const productRoutes = require('./routes/product');
const category = require('./routes/category');
const search = require('./routes/search');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 📡 Global access to io
app.set('io', io);

// Middleware global
app.use(cors());
app.use(bodyParser.json());

// ✅ Middleware API key (semua route wajib pakai)
app.use(requireApiKey);

// ✅ Middleware rate limiter, tapi skip /forum-pendaftaran
app.use((req, res, next) => {
  if (req.path.startsWith('/forum-pendaftaran')) {
    return next(); // Lewati rate limiter
  }
  return rateLimiter(req, res, next); // Apply rate limiter
});

// Routes
app.use('/auth', authRoutes);
app.use('/forum-pendaftaran', forumpendaftaran); 
app.use('/product', productRoutes);
app.use('/category',category);
app.use('/search',search);

// Socket.IO Connection
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 API + Realtime running on port ${PORT}`));
