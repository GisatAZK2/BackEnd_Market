// ✅ Versi tanpa Socket.IO
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const requireApiKey = require('./middleware/requireApiKey');
const rateLimiter = require('./middleware/ratelimiter');
const authRoutes = require('./routes/auth');
const forumpendaftaran = require('./routes/forum-pendaftaran');
const productRoutes = require('./routes/product');
const category = require('./routes/category');
const search = require('./routes/search');
const clean = require('./utils/cleanup');
const order = require('./routes/orderRoutes');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const getLink = process.env.CORS_ORIGIN?.split(',').map(link => link.trim()) || [];

// CORS
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || getLink.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 200,
};



// Middleware global
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(cookieParser());


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
app.use('/category', category);
app.use('/search', search);
app.use('/clean', clean);
app.use('/order', order);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
