const supabase = require("../config/supabase");

const RATE_LIMIT = 5;
const WINDOW_MINUTES = 5;

async function rateLimiter(req, res, next) {
  const rawIp =
    req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;

  // Format IP: hilangkan ::ffff: jika ada (IPv6 mapped)
  const ip = rawIp.replace(/^::ffff:/, "");
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

  if (error) {
    console.error("Rate limiter error:", error.message);
    req.requireCaptcha = false;
    return next();
  }

  req.requireCaptcha = count >= RATE_LIMIT;

  // Debugging
  console.log(
    `📶 IP: ${ip} | Endpoint: ${endpoint} | Count: ${count} | Captcha? ${req.requireCaptcha}`,
  );

  // Simpan log
  await supabase.from("rate_limit_logs").insert({
    ip_address: ip,
    endpoint,
    user_agent: req.headers["user-agent"] || null,
    email: req.body?.email || null,
  });

  next();
}

module.exports = rateLimiter;
