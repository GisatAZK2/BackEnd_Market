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
const apicache = require('apicache'); // <-- tambahan
require('dotenv').config();

const app = express();

// === CORS ORIGINS ===
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(link => link.trim().replace(/\/$/, ''))
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const cleanedOrigin = origin.replace(/\/$/, '');
    if (process.env.NODE_ENV !== 'production' && cleanedOrigin.includes('localhost')) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(cleanedOrigin)) {
      return callback(null, true);
    }
    console.warn('❌ CORS blocked for origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 200,
};

// === Middleware global ===
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(cookieParser());

// === Middleware API key (semua route wajib pakai) ===
app.use(requireApiKey);

// === Middleware rate limiter (skip /forum-pendaftaran) ===
app.use((req, res, next) => {
  if (req.path.startsWith('/forum-pendaftaran')) return next();
  return rateLimiter(req, res, next);
});

// === Cache Middleware ===
const cache = apicache.middleware;

// === Routes ===
app.use('/auth', authRoutes);
app.use('/forum-pendaftaran', forumpendaftaran);
app.use('/product', cache('5 minutes'), productRoutes); // <--- cache di sini
app.use('/categories', cache('10 minutes'), category);
app.use('/search', cache('2 minutes'), search);
app.use('/clean', clean);
app.use('/order', order);

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
