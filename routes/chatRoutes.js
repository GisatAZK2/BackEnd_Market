const { createProxyMiddleware } = require("http-proxy-middleware");
const { createProxyServer } = require("http-proxy");
const cors = require("cors");
const cookieParser = require("cookie-parser");

module.exports = (app, server) => {
  const GO_CHAT_SERVICE = process.env.GO_CHAT_SERVICE || "http://localhost:8080";

  // Define separate allowed origins for customer and seller
  const allowedCustomerOrigins = process.env.CORS_ORIGIN_CUSTOMER
    ? process.env.CORS_ORIGIN_CUSTOMER.split(",").map((o) => o.trim())
    : [];
  const allowedSellerOrigins = process.env.CORS_ORIGIN_SELLER
    ? process.env.CORS_ORIGIN_SELLER.split(",").map((o) => o.trim())
    : [];

  // Dynamic CORS configuration based on request path
  const dynamicCors = (req, cb) => {
    const isSellerPath =
      req.originalUrl.includes("/seller/v1") ||
      req.originalUrl.startsWith("/ws-seller");

    const allowedOrigins = isSellerPath ? allowedSellerOrigins : allowedCustomerOrigins;

    const options = {
      origin: (origin, callback) => {
        console.log("Request Origin:", origin);
        console.log("Allowed Origins for this path:", allowedOrigins);
        if (!origin) return callback(null, true);

        const cleanedOrigin = origin.replace(/\/$/, "");

        // Special allowance for sharecihuy.sytes.net (consistent with main app)
        if (cleanedOrigin === "https://sharecihuy.sytes.net") {
          console.log("Allowing special origin: https://sharecihuy.sytes.net");
          return callback(null, true);
        }

        if (
          process.env.NODE_ENV !== "production" &&
          origin.includes("localhost")
        ) {
          console.log("Allowing localhost in non-production");
          return callback(null, true);
        }

        if (allowedOrigins.includes(cleanedOrigin)) {
          console.log("Origin allowed:", origin);
          return callback(null, true);
        }

        return callback(new Error("Not allowed by CORS (chat)"));
      },
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "Accept",
        "Origin",
        "x-api-key",
        "ngrok-skip-browser-warning"
      ],
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    };

    cb(null, options);
  };

  // Apply dynamic CORS globally, but since chat routes are specific, it will use path-based logic
  app.use(cors(dynamicCors));
  app.use(cookieParser());

  // === Proxy REST ke Go service ===
  app.use(["/seller/v1/chats", "/seller/v1/messages"], (req, res, next) => {
    if (req.headers.cookie) {
      const cookies = req.headers.cookie
        .split(";")
        .map((c) => c.trim())
        .filter((c) => c.startsWith("seller_info="));

      req.headers.cookie = cookies.join("; ");
    }
    next();
  });

  app.use(
    ["/chats", "/messages", "/seller/v1/chats", "/seller/v1/messages"],
    createProxyMiddleware({
      target: GO_CHAT_SERVICE,
      changeOrigin: true,
      ws: false,
      pathRewrite: { "^/": "/" },
    })
  );

  // === WebSocket Proxy ===
  const proxy = createProxyServer({
    target: GO_CHAT_SERVICE,
    ws: true,
    changeOrigin: true,
  });

  proxy.on("error", (err) => {
    console.error("❌ Proxy WS error:", err.message);
  });

  // Handle WebSocket upgrade
  server.on("upgrade", (req, socket, head) => {
    const filterCookie = (cookieHeader, allowedKey) => {
      if (!cookieHeader) return "";
      return cookieHeader
        .split(";")
        .map((c) => c.trim())
        .filter((c) => c.startsWith(`${allowedKey}=`))
        .join("; ");
    };

    if (req.url.startsWith("/ws-customer")) {
      const cookies = filterCookie(req.headers.cookie, "user_info");
      if (!cookies) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      req.headers.cookie = cookies;
      req.url = "/ws-customer";
    } else if (req.url.startsWith("/ws-seller")) {
      const cookies = filterCookie(req.headers.cookie, "seller_info");
      if (!cookies) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      req.headers.cookie = cookies;
      req.url = "/ws-seller";
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    proxy.ws(req, socket, head);
  });
};
