const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const requireApiKey = require("./middleware/requireApiKey");
const rateLimiter = require("./middleware/ratelimiter");
const authRoutes = require("./routes/auth");
const forumpendaftaran = require("./routes/forum-pendaftaran");
const productRoutes = require("./routes/product");
const category = require("./routes/category");
const search = require("./routes/search");
const clean = require("./utils/cleanup");
const order = require("./routes/orderRoutes");
const share = require("./routes/ogpmeta");
const cart = require("./routes/cart");
const discount = require("./routes/discount");
const cookieParser = require("cookie-parser");
const apicache = require("apicache");
const path = require("path");
const startCronJobs = require("./utils/restoreStock");
const sellerWithProductsRoutes = require("./routes/seller");
const { router: wilayah } = require("./utils/wilayahutils");
const authseller = require("./routes/seller/auth.js");
const orderseller = require("./routes/seller/order.js");
require("./utils/cron");
require("dotenv").config();

const app = express();
const sellerRouter = express.Router();
startCronJobs();

// === CORS ORIGINS ===
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((link) =>
      link.trim().replace(/\/$/, ""),
    )
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const cleanedOrigin = origin.replace(/\/$/, "");
    // khusus share
    if (cleanedOrigin === "https://sharecihuy.sytes.net") {
      return callback(null, true);
    }
    // dev local bebas
    if (
      process.env.NODE_ENV !== "production" &&
      cleanedOrigin.includes("localhost")
    ) {
      return callback(null, true);
    }
    // check daftar allowed
    if (allowedOrigins.includes(cleanedOrigin)) {
      return callback(null, true);
    }
    console.warn("❌ CORS blocked for origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  optionsSuccessStatus: 200,
};

// === Middleware global ===
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(cookieParser());

// === favicon.ico ===
app.get("/favicon.ico", (req, res) => {
  res.type("image/png");
  res.sendFile(path.join(__dirname, "routes", "assets", "favicon.png"));
});

// === khusus endpoint /share ===
// hanya izinkan https://sharecihuy.sytes.net
app.use(
  "/share",
  (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== "https://sharecihuy.sytes.net") {
      return res
        .status(403)
        .json({ error: "Forbidden: hanya untuk sharecihuy.sytes.net" });
    }
    next();
  },
  share,
);

// === Middleware API key (semua route wajib pakai) ===
app.use(requireApiKey);

// === Middleware rate limiter (skip /forum-pendaftaran) ===
app.use((req, res, next) => {
  if (req.path.startsWith("/forum-pendaftaran")) return next();
  return rateLimiter(req, res, next);
});

// === Cache Middleware ===
const cache = apicache.middleware;

// === Routes ===
app.use("/auth", authRoutes);
app.use("/forum-pendaftaran", forumpendaftaran);
app.use("/product", productRoutes);
app.use(wilayah);
app.use("/categories", cache("10 minutes"), category);
app.use("/search", cache("2 minutes"), search);
app.use("/clean", clean);
app.use("/order", order);
app.use("/cart", cache("10 seconds"), cart);
app.use("/discount", discount);
app.use("/seller", cache("10 seconds"), sellerWithProductsRoutes);

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
