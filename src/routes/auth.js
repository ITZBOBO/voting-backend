import express from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';

import { prisma } from '../utils/prisma.js';
import { signToken, blacklistToken } from '../utils/jwt.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../utils/audit.js';
import { requireAuth } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 requests per IP
  message: { error: 'Too many login attempts, please try again after a minute' }
});

router.post('/login', loginLimiter, validate(z.object({
  body: z.object({
    identifier: z.string().min(3),
    password: z.string().min(6),
  }).strict(),
})), async (req, res) => {
  const { identifier, password } = req.validated;

  const user = await prisma.user.findFirst({
    where: { OR: [{ matricNo: identifier }, { schoolEmail: identifier }] },
    include: { roles: { include: { role: true } } },
  });

  if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const roles = user.roles.map((ur) => ur.role);

  const token = signToken({
    userId: user.id,
    matricNo: user.matricNo,
    departmentId: user.departmentId,
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
  });

  await audit({ actorId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id });

  res.json({
    token,
    user: {
      id: user.id,
      matricNo: user.matricNo,
      fullName: user.fullName,
      departmentId: user.departmentId,
      roles: roles.map((r) => r.name),
    },
  });
});

router.post('/register', validate(z.object({
  body: z.object({
    matricNo: z.string().min(3),
    fullName: z.string().min(2),
    schoolEmail: z.string().email().optional(),
    password: z.string().min(6),
  }).strict(),
})), async (req, res) => {
  const { matricNo, fullName, schoolEmail, password } = req.validated;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ matricNo }, ...(schoolEmail ? [{ schoolEmail }] : [])] },
  });
  if (existing) return res.status(409).json({ error: 'A user with this matric number or email already exists.' });

  const passwordHash = await bcrypt.hash(password, 12);

  const studentRole = await prisma.role.findUnique({ where: { name: 'student' } });

  const user = await prisma.user.create({
    data: { matricNo, fullName, schoolEmail, passwordHash, isActive: true },
  });

  if (studentRole) {
    await prisma.userRole.create({ data: { userId: user.id, roleId: studentRole.id } });
  }

  await audit({ actorId: user.id, action: 'SELF_REGISTER', entityType: 'user', entityId: user.id, details: { matricNo } });

  res.status(201).json({ message: 'Registration successful. You can now log in.', matricNo });
});

router.post('/logout', requireAuth, async (req, res) => {
  await blacklistToken(req.token);
  await audit({ actorId: req.user.id, action: 'LOGOUT', entityType: 'user', entityId: req.user.id });
  res.json({ message: 'Logged out successfully' });
});

export default router;
