const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const requireApiKey = require('./middleware/requireApiKey');
const rateLimiter = require('./middleware/ratelimiter'); 
const authRoutes = require('./routes/auth');
const forumpendaftaran = require('./routes/forum-pendaftaran');
const product = require('./routes/product');
require('dotenv').config();

const app = express();

// Middleware global
app.use(cors());
app.use(bodyParser.json());

// ✅ Urutan penting
app.use(requireApiKey);  // Cek API key dulu
app.use(rateLimiter);    // Batasi request dari API key + IP

// Routes
app.use('/auth', authRoutes);
app.use('/forum-pendaftaran', forumpendaftaran);
app.use('/product', product);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
