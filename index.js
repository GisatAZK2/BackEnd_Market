const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const apicache = require("apicache");
const path = require("path");
const http = require("http");
require("dotenv").config();

// === Middleware & Utils ===
const requireApiKey = require("./middleware/requireApiKey");
const rateLimiter = require("./middleware/ratelimiter");
const startCronJobs = require("./utils/restoreStock");
require("./utils/cron");
require("./utils/autocancelorder.js");
require("./utils/autodeletorder.js");
require("./utils/autocompleteorder.js");

// === Routes ===
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/product");
const category = require("./routes/category");
const search = require("./routes/search");
const clean = require("./utils/cleanup");
const order = require("./routes/orderRoutes");
const share = require("./routes/ogpmeta");
const chatProxy = require("./routes/chatRoutes.js"); // proxy chat
const cart = require("./routes/cart");
const ratingcustomer = require("./routes/ratingcustomer.js");
const discount = require("./routes/discount");
const sellerWithProductsRoutes = require("./routes/seller");
const { router: wilayah } = require("./utils/wilayahutils");

// === Seller sub-routes ===
const authseller = require("./routes/seller/auth.js");
const orderseller = require("./routes/seller/order.js");
const formseller = require("./routes/seller/forum-pendaftaran.js");
const promoteproductseller = require("./routes/seller/promote.js");
const productseller = require("./routes/seller/product.js");
const ratingselelr = require("./routes/seller/rating.js");

// === App & Server ===
const app = express();
const server = http.createServer(app);

// Jalankan cron job otomatis
startCronJobs();

// === Mount chat proxy dulu (tanpa CORS global) ===
chatProxy(app, server);

// === Middleware umum ===
app.use(bodyParser.json());
app.use(cookieParser());

// === CORS untuk route non-chat ===
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((link) =>
      link.trim().replace(/\/$/, "")
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

// Pasang CORS untuk semua route kecuali /chat
app.use((req, res, next) => {
  if (req.path.startsWith("/chat") || req.path.startsWith("/chats") || req.path.startsWith("/messages"))
    return next(); // skip CORS untuk chat
  return cors(corsOptions)(req, res, next);
});

// === favicon.ico ===
app.get("/favicon.ico", (req, res) => {
  res.type("image/png");
  res.sendFile(path.join(__dirname, "routes", "assets", "favicon.png"));
});

// === khusus endpoint /share ===
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
  share
);

// === Middleware API key ===
app.use((req, res, next) => {
  if (req.path.startsWith("/share")) return next();
  if (req.path.startsWith("/chat") || req.path.startsWith("/chats") || req.path.startsWith("/messages"))
    return next(); // skip API key untuk chat
  return requireApiKey(req, res, next);
});

// === Middleware rate limiter ===
app.use((req, res, next) => {
  if (req.path.startsWith("/forum-pendaftaran")) return next();
  return rateLimiter(req, res, next);
});

// === Cache Middleware ===
const cache = apicache.middleware;

// === Routes utama ===
app.use("/auth", authRoutes);
app.use("/product", productRoutes);
app.use(wilayah);
app.use("/categories", cache("10 minutes"), category);
app.use("/search", cache("2 minutes"), search);
app.use("/clean", clean);
app.use("/order", order);
app.use("/cart", cache("10 seconds"), cart);
app.use("/discount", discount);
app.use("/rating", ratingcustomer);
app.use("/seller", cache("10 seconds"), sellerWithProductsRoutes);

// === Seller V1 routes (nested router) ===
const sellerRouter = express.Router();
sellerRouter.use("/auth", authseller);
sellerRouter.use("/order", orderseller);
sellerRouter.use("/forum-pendaftaran", formseller);
sellerRouter.use("/products", productseller);
sellerRouter.use("/promoteseller", promoteproductseller);
sellerRouter.use("/ratingseller", ratingselelr);
sellerRouter.get("/test", (req, res) => {
  res.json({ message: "Seller V1 API aktif 🚀" });
});
app.use("/seller/V1", sellerRouter);

// === Start server ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
