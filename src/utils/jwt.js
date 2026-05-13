import jwt from 'jsonwebtoken';
import { hashToken } from './hash.js';
import redis from './redis.js';

export function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is missing');
  return jwt.sign(payload, secret, { expiresIn: '1h' });
}

export function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is missing');
  return jwt.verify(token, secret);
}

export async function isTokenBlacklisted(token) {
  const tokenHash = hashToken(token);
  try {
    const exists = await redis.get(`bl:${tokenHash}`);
    return !!exists;
  } catch (e) {
    return false; // Fallback if Redis fails
  }
}

export async function blacklistToken(token) {
  const decoded = jwt.decode(token);
  if (!decoded || !decoded.exp) return;
  const tokenHash = hashToken(token);
  
  const now = Math.floor(Date.now() / 1000);
  const ttl = decoded.exp - now;
  
  if (ttl > 0) {
    try {
      await redis.set(`bl:${tokenHash}`, '1', 'EX', ttl);
    } catch (e) {
      console.warn('Failed to blacklist token in Redis', e.message);
    }
  }
}
