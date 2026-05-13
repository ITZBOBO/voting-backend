import Redis from 'ioredis';

// Graceful fallback if Redis isn't running
const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => {
    if (times > 3) {
      console.warn('Redis connection failed, giving up after 3 retries.');
      return null;
    }
    return Math.min(times * 50, 2000);
  }
});

redis.on('error', (err) => {
  console.warn('Redis Error:', err.message);
});

export default redis;
