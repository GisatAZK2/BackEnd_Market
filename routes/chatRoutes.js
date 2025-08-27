const { createProxyMiddleware } = require("http-proxy-middleware");
const { createProxyServer } = require("http-proxy");
const cors = require("cors");
const cookieParser = require("cookie-parser");

module.exports = (app, server) => {
  const GO_CHAT_SERVICE =
    process.env.GO_CHAT_SERVICE || "http://localhost:8080";

  console.log("🔌 Proxy target Go service:", GO_CHAT_SERVICE);

  // === CORS untuk REST API (chat) ===
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

  // === Proxy REST ke Go service ===
  app.use(
    ["/chats", "/messages", "/seller/v1/chats", "/seller/v1/messages"],
    createProxyMiddleware({
      target: GO_CHAT_SERVICE,
      changeOrigin: true,
      ws: false, // hanya REST, bukan ws
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

  // handle upgrade → arahkan ke /ws (Go backend)
  server.on("upgrade", (req, socket, head) => {
    console.log("⚡️ WS upgrade request:", req.url);

    if (req.url.startsWith("/ws-seller") || req.url.startsWith("/ws-customer")) {
      req.url = "/ws"; // backend Go hanya kenal /ws
      proxy.ws(req, socket, head);
    }
  });
};
