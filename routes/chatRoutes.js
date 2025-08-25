const { createProxyMiddleware } = require("http-proxy-middleware");
const { createProxyServer } = require("http-proxy");

module.exports = (app, server) => {
  const GO_CHAT_SERVICE =
    "http://localhost:8080";

  console.log("🔌 Proxy target Go service:", GO_CHAT_SERVICE);

  // --- Proxy REST API ---
  // Customer routes
  app.use(
  ["/chats", "/messages"],
  createProxyMiddleware({
    target: GO_CHAT_SERVICE,
    changeOrigin: true,
    pathRewrite: (path, req) => path, // biarin path asli
  })
);

app.use(
  ["/seller/v1/chats", "/seller/v1/messages"],
  createProxyMiddleware({
    target: GO_CHAT_SERVICE,
    changeOrigin: true,
    pathRewrite: (path, req) => path, // biarin path asli juga
  })
);


  // --- Proxy WebSocket ---
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

    // Bisa bedain path ws
    if (req.url.startsWith("/ws-seller") || req.url.startsWith("/ws-customer")) {
      req.url = "/ws"; // arahkan ke Go
    }

    proxy.ws(req, socket, head);
  });
};
