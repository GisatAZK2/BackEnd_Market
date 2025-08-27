const { createProxyMiddleware } = require("http-proxy-middleware");
const { createProxyServer } = require("http-proxy");
const cors = require("cors");

module.exports = (app, server) => {
  const GO_CHAT_SERVICE = process.env.GO_CHAT_SERVICE || "http://localhost:8080";

  console.log("🔌 Proxy target Go service:", GO_CHAT_SERVICE);

  // === CORS for Chat Routes ===
  const corsOptions = {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      const allowedOrigins = process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim().replace(/\/$/, ""))
        : [];

      const cleanedOrigin = origin.replace(/\/$/, "");

      if (process.env.NODE_ENV !== "production" && cleanedOrigin.includes("localhost")) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(cleanedOrigin)) {
        return callback(null, true);
      }

      console.warn("❌ CORS blocked for CHAT origin:", origin);
      return callback(new Error("Not allowed by CORS (chat)"));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    optionsSuccessStatus: 200,
  };

  // Apply CORS to chat routes
  app.use(["/chats", "/messages", "/seller/v1/chats", "/seller/v1/messages"], cors(corsOptions));

  // === REST Proxy ===
  app.use(
    ["/chats", "/messages", "/seller/v1/chats", "/seller/v1/messages"],
    createProxyMiddleware({
      target: GO_CHAT_SERVICE,
      changeOrigin: true,
      ws: true,
      pathRewrite: { "^/": "/" },
      onError: (err, req, res) => {
        console.error("❌ Proxy REST error:", err.message);
        res.status(500).json({ error: "Chat service unavailable" });
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
    socket.end("HTTP/1.1 500 WebSocket proxy error\r\n\r\n");
  });

  server.on("upgrade", (req, socket, head) => {
    console.log("⚡️ WS upgrade request:", req.url);

    if (req.url.startsWith("/ws-seller") || req.url.startsWith("/ws-customer")) {
      req.url = "/ws";
    }

    proxy.ws(req, socket, head);
  });
};