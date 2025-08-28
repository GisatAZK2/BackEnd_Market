const { createProxyMiddleware } = require("http-proxy-middleware");
const { createProxyServer } = require("http-proxy");
const cors = require("cors");
const cookieParser = require("cookie-parser");

module.exports = (app, server) => {
  const GO_CHAT_SERVICE = process.env.GO_CHAT_SERVICE || "http://localhost:8080";

  console.log("🔌 Proxy target Go service:", GO_CHAT_SERVICE);

  // === CORS for REST API (chat) ===
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);

        const allowedOrigins = process.env.CORS_ORIGIN
          ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
          : [];

        if (
          process.env.NODE_ENV !== "production" &&
          origin.includes("localhost")
        ) {
          return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        console.warn("❌ CORS blocked for CHAT origin:", origin);
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
      ],
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    })
  );

  app.use(cookieParser());

  // === Proxy REST to Go service ===
  app.use(
    ["/chats", "/messages", "/seller/v1/chats", "/seller/v1/messages"],
    createProxyMiddleware({
      target: GO_CHAT_SERVICE,
      changeOrigin: true,
      ws: false, // REST only, not WebSocket
      pathRewrite: { "^/seller/v1": "/" }, // Rewrite /seller/v1 to root for backend
      onProxyReq: (proxyReq, req, res) => {
        // Log request for debugging
        console.log(`📡 Proxying REST request: ${req.method} ${req.url}`);
      },
    })
  );

  // === WebSocket Proxy ===
  const proxy = createProxyServer({
    target: GO_CHAT_SERVICE,
    ws: true,
    changeOrigin: true,
  });

  proxy.on("error", (err, req, socket) => {
    console.error("❌ Proxy WS error:", err.message);
    socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
  });

  // Handle WebSocket upgrade
  server.on("upgrade", (req, socket, head) => {
    console.log("⚡️ WS upgrade request:", req.url, "Cookies:", req.headers.cookie || "none");

    // Validate cookies for WebSocket routes
    const cookies = req.headers.cookie ? require("cookie").parse(req.headers.cookie) : {};
    const hasUserInfo = !!cookies.user_info;
    const hasSellerInfo = !!cookies.seller_info;

    if (req.url.startsWith("/ws-customer")) {
      if (!hasUserInfo) {
        console.warn("❌ WS /ws-customer blocked: user_info cookie required");
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      if (hasSellerInfo) {
        console.warn("❌ WS /ws-customer blocked: seller_info cookie not allowed");
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      req.url = "/ws-customer"; // Route to Go backend /ws-customer
      console.log(`🔄 Proxying WS request to ${GO_CHAT_SERVICE}/ws-customer`);
      proxy.ws(req, socket, head);
    } else if (req.url.startsWith("/ws-seller")) {
      if (!hasSellerInfo) {
        console.warn("❌ WS /ws-seller blocked: seller_info cookie required");
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      if (hasUserInfo) {
        console.warn("❌ WS /ws-seller blocked: user_info cookie not allowed");
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      req.url = "/ws-seller"; // Route to Go backend /ws-seller
      console.log(`🔄 Proxying WS request to ${GO_CHAT_SERVICE}/ws-seller`);
      proxy.ws(req, socket, head);
    } else {
      console.warn("❌ Invalid WS route:", req.url);
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    }
  });
};