const { createProxyMiddleware } = require("http-proxy-middleware");
const { createProxyServer } = require("http-proxy");
const cors = require("cors");
const cookieParser = require("cookie-parser");

module.exports = (app, server) => {
  // Ambil dari environment variable, kasih default ke localhost:8080
  const GO_CHAT_SERVICE = "http://localhost:8080";

  console.log("🔌 Proxy target Go service:", GO_CHAT_SERVICE);

  // ====== CORS Middleware ======
  app.use(
    cors({
      origin: [
        "http://localhost:5173",
        "http://127.0.0.1:5500",
        "https://cihuy-store-production.up.railway.app",
        "https://cihuy.sytes.net",
        "https://cihuy-store.sytes.net",
        "https://sellercihuy.sytes.net",
      ],
      credentials: true,
      allowedHeaders: ["Content-Type", "x-api-key"],
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    })
  );

  // Parsing cookie
  app.use(cookieParser());

  // ====== Proxy REST API ======
  app.use(
    ["/chats", "/messages"],
    createProxyMiddleware({
      target: GO_CHAT_SERVICE,
      changeOrigin: true,
      pathRewrite: (path, req) => path,
    })
  );

  app.use(
    ["/seller/v1/chats", "/seller/v1/messages"],
    createProxyMiddleware({
      target: GO_CHAT_SERVICE,
      changeOrigin: true,
      pathRewrite: (path, req) => path,
    })
  );

  // ====== Proxy WebSocket ======
  const proxy = createProxyServer({
    target: GO_CHAT_SERVICE,
    ws: true,
    changeOrigin: true,
  });

  proxy.on("error", (err) => {
    console.error("❌ Proxy error:", err.message);
  });

  server.on("upgrade", (req, socket, head) => {
    console.log("⚡️ Incoming WS upgrade:", req.url);

    if (req.url.startsWith("/ws-seller") || req.url.startsWith("/ws-customer")) {
      req.url = "/ws"; // arahkan ke Go
    }

    proxy.ws(req, socket, head);
  });
};
