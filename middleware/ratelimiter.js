const redis = require('redis');

// Setup Redis client
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redisClient.connect().catch(console.error);

module.exports = async function rateLimiter(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key is required' });

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

  const key = `rate-limit:${apiKey}:${ip}`;
  const limit = 60; 
  const windowSeconds = 60; 

  try {
    const current = await redisClient.incr(key);

    
    if (current === 1) {
      await redisClient.expire(key, windowSeconds);
    }

    if (current > limit) {
      const ttl = await redisClient.ttl(key);
      return res.status(429).json({
        error: `Too many requests. Try again in ${ttl} seconds.`,
      });
    }

    next();
  } catch (err) {
    console.error('Redis rate limiter error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
