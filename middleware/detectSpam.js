const supabase = require("../config/supabase");

const RATE_LIMIT = 5;
const WINDOW_MINUTES = 5;

async function rateLimiter(req, res, next) {
  // Ambil IP asli dari header x-forwarded-for jika tersedia
  const rawIp = (
    req.headers["x-forwarded-for"] ||
    req.ip ||
    req.connection.remoteAddress ||
    ""
  )
    .split(",")[0]
    .trim();

  // Hilangkan prefix IPv6 jika ada
  const ip = rawIp.replace(/^::ffff:/, "");
  const endpoint = req.originalUrl;

  const now = new Date();
  const windowStart = new Date(
    now.getTime() - WINDOW_MINUTES * 60 * 1000,
  ).toISOString();

  try {
    const { count, error } = await supabase
      .from("rate_limit_logs")
      .select("*", { count: "exact", head: true })
      .gte("created_at", windowStart)
      .eq("ip_address", ip)
      .eq("endpoint", endpoint);

    if (error) {
      console.error("❌ Rate limiter query error:", error.message);
      req.requireCaptcha = false;
      return next();
    }

    req.requireCaptcha = count >= RATE_LIMIT;

    console.log(
      `📶 IP: ${ip} | Endpoint: ${endpoint} | Count: ${count} | Captcha? ${req.requireCaptcha} | Since: ${windowStart}`,
    );

    await supabase.from("rate_limit_logs").insert({
      created_at: new Date().toISOString(),
      ip_address: ip,
      endpoint,
      user_agent: req.headers["user-agent"] || null,
      email: req.body?.email || null,
    });

    return next();
  } catch (err) {
    console.error("❌ Rate limiter internal error:", err.message);
    req.requireCaptcha = false;
    return next();
  }
}

module.exports = rateLimiter;
