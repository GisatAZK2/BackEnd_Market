const supabase = require("../config/supabase");

// Limit: 5 request per 5 menit per IP per endpoint
const RATE_LIMIT = 5;
const WINDOW_MINUTES = 5;

async function rateLimiter(req, res, next) {
  const ip =
    req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;
  const endpoint = req.originalUrl;

  const windowStart = new Date(
    Date.now() - WINDOW_MINUTES * 60 * 1000,
  ).toISOString();

  const { count, error } = await supabase
    .from("rate_limit_logs")
    .select("*", { count: "exact", head: true })
    .gte("created_at", windowStart)
    .eq("ip_address", ip)
    .eq("endpoint", endpoint);

  if (error) return res.status(500).json({ error: "Rate limiter error" });

  if (count >= RATE_LIMIT) {
    return res
      .status(429)
      .json({ error: "Too many requests, please try again later." });
  }

  // Log request
  await supabase.from("rate_limit_logs").insert({
    ip_address: ip,
    endpoint,
    user_agent: req.headers["user-agent"] || null,
    email: req.body?.email || null,
  });

  next();
}

module.exports = rateLimiter;
