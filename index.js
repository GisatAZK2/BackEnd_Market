const express = require("express");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const apicache = require("apicache");
const path = require("path");
require("dotenv").config();

// === Middleware & Utils ===
const requireApiKey = require("./middleware/requireApiKey");
const startCronJobs = require("./utils/restoreStock");
require("./utils/cron");
require("./utils/autocancelorder.js");
require("./utils/autodeletorder.js");
require("./utils/autocompleteorder.js");
require("./utils/deletedataseller.js");
const webhookpayment = require("./utils/webhookpayment.js");

// === Routes ===
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/product");
const category = require("./routes/category");
const search = require("./routes/search");
const clean = require("./utils/cleanup");
const order = require("./routes/orderRoutes");
const share = require("./routes/ogpmeta");
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
const StatistikSeller = require("./routes/seller/stastikdata.js");
const awblabelseller = require("./routes/seller/awb.js");
const paymentseller = require("./routes/seller/finance.js");

// ===== Global Sticker ====
const sticker = require("./routes/sticker.js");


// === App & Server ===
const app = express();
const server = http.createServer(app);

// === Chat Proxy (skip semua middleware global) ===
const chatProxy = require("./routes/chatRoutes.js");
chatProxy(app, server); 

// === CORS Configuration ===
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((link) => link.trim().replace(/\/$/, ""))
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const cleanedOrigin = origin.replace(/\/$/, "");

    // Allow specific origins
    if (cleanedOrigin === "https://sharecihuy.sytes.net") {
      return callback(null, true);
    }

    // Allow localhost in development
    if (process.env.NODE_ENV !== "production" && cleanedOrigin.includes("localhost")) {
      return callback(null, true);
    }

    // Check allowed origins
    if (allowedOrigins.includes(cleanedOrigin)) {
      return callback(null, true);
    }

    console.warn("❌ CORS blocked for origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key", "Authorization", "ngrok-skip-browser-warning",],
  optionsSuccessStatus: 200,
};

// === Global Middleware ===
app.use(cors(corsOptions)); // Apply CORS globally
app.use(bodyParser.json());
app.use(cookieParser());

// === Favicon ===
app.get("/favicon.ico", (req, res) => {
  res.type("image/png");
  res.sendFile(path.join(__dirname, "routes", "assets", "favicon.png"));
});

// === Share Endpoint ===
app.use("/share", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin !== "https://sharecihuy.sytes.net") {
    return res.status(403).json({ error: "Forbidden: hanya untuk sharecihuy.sytes.net" });
  }
  next();
}, share);

// === Webhook Payment Endpoint (skip API key juga) ===
app.use("/payment/webhook", webhookpayment);

// === API Key Middleware (Skip /share, /chat, dan /order/payment/webhook) ===
app.use((req, res, next) => {
  if (
    req.path.startsWith("/share") ||
    req.path.startsWith("/chat") ||
    req.path.startsWith("/order/payment/webhook")
  ) {
    return next();
  }
  return requireApiKey(req, res, next);
});

// === Cache Middleware ===
const cache = apicache.middleware;

// === Routes ===
app.use("/auth", authRoutes);
app.use("/product", productRoutes);
app.use(wilayah);
app.use("/categories", cache("10 minutes"), category);
app.use("/search", cache("2 minutes"), search);
app.use("/clean", clean);
app.use("/order", order);
app.use("/cart", cache("10 seconds"), cart);
app.use("/sticker", sticker);
app.use("/discount", discount);
app.use("/rating", ratingcustomer);
app.use("/seller", cache("10 seconds"), sellerWithProductsRoutes);

// === Seller V1 Routes ===
const sellerRouter = express.Router();
sellerRouter.use("/auth", authseller);
sellerRouter.use("/order", orderseller);
sellerRouter.use("/forum-pendaftaran", formseller);
sellerRouter.use("/products", productseller);
sellerRouter.use("/promoteseller", promoteproductseller);
sellerRouter.use("/ratingseller", ratingselelr);
sellerRouter.use("/statsSeller", StatistikSeller);
sellerRouter.use("/awbseller", awblabelseller);
sellerRouter.use("/withdrawpayment", paymentseller);
sellerRouter.get("/test", (req, res) => {
  res.json({ message: "Seller V1 API aktif 🚀" });
});
app.use("/seller/V1", sellerRouter);

// === Start Cron Jobs ===
startCronJobs();

// === Start Server ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));