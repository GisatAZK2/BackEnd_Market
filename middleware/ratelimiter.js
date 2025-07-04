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
  const now = Date.now();

  try {
    const lastRequest = await redisClient.get(key);

    if (lastRequest) {
      const secondsPassed = (now - parseInt(lastRequest)) / 1000;
      if (secondsPassed < 30) {
        return res.status(429).json({
          error: `Rate limit exceeded. Please wait ${Math.ceil(30 - secondsPassed)} seconds.`,
        });
      }
    }


    await redisClient.set(key, now, { EX: 10 }); 

    next();
  } catch (err) {
    console.error('Redis rate limiter error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
