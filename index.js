const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const requireApiKey = require('./middleware/requireApiKey');
const rateLimiter = require('./middleware/ratelimiter');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const forumpendaftaran = require('./routes/forum-pendaftaran');
const product = require('./routes/product');
const utilities = require('./routes/utilities')
require('dotenv').config();

const app = express();
connectDB();

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
app.use('/utilities',utilities);
app.use('/product', product);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
