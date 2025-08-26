const { createProxyMiddleware } = require("http-proxy-middleware");
const { createProxyServer } = require("http-proxy");
const cors = require("cors");
const cookieParser = require("cookie-parser");

module.exports = (app, server) => {
  // Ambil target Go service dari ENV (default ke localhost:8080)
  const GO_CHAT_SERVICE =
    process.env.GO_CHAT_SERVICE || "http://localhost:8080";

  console.log("🔌 Proxy target Go service:", GO_CHAT_SERVICE);

  // ====== Ambil allowed origins dari ENV ======
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((o) =>
        o.trim().replace(/\/$/, "")
      )
    : [];

  // ====== CORS Middleware ======
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true); // skip kalau request non-browser (misal curl/Postman)

        const cleaned = origin.replace(/\/$/, "");
        if (allowedOrigins.includes(cleaned)) {
          return callback(null, true);
        }

        console.warn("❌ CORS blocked for:", origin);
        return callback(new Error("Not allowed by CORS"));
      },
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

    // Mapping custom WS endpoint → Go WebSocket
    if (req.url.startsWith("/ws-seller") || req.url.startsWith("/ws-customer")) {
      req.url = "/ws"; // arahkan ke Go service
    }

    proxy.ws(req, socket, head);
  });
};
