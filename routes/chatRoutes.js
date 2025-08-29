const { createProxyMiddleware } = require("http-proxy-middleware");
const { createProxyServer } = require("http-proxy");
const cors = require("cors");
const cookieParser = require("cookie-parser");

module.exports = (app, server) => {
  const GO_CHAT_SERVICE = "http://localhost:8080";

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
