import express from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';

import { prisma } from '../utils/prisma.js';
import { signToken, blacklistToken } from '../utils/jwt.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../utils/audit.js';
import { requireAuth } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';
import { verifySchoolStudent } from '../utils/schoolApi.js';

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

  let user = await prisma.user.findFirst({
    where: { OR: [{ matricNo: identifier }, { schoolEmail: identifier }] },
    include: { roles: { include: { role: true } }, department: true },
  });

  const isLocalAdmin = user && user.roles.some((ur) => ur.role.isAdminRole);

  if (isLocalAdmin) {
    if (!user.isActive) return res.status(401).json({ error: 'Account disabled' });
    const ok = user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!ok) return res.status(401).json({ error: 'Invalid admin credentials' });
  } else {
    // Student Login via School API
    let schoolStudent;
    try {
      schoolStudent = await verifySchoolStudent(identifier, password);
    } catch (err) {
      console.error(err);
      return res.status(503).json({ error: err.message });
    }
    
    if (!schoolStudent) {
      return res.status(401).json({ error: 'Invalid school portal credentials' });
    }

    // Sync Department
    let department = await prisma.department.findFirst({
      where: { name: schoolStudent.department }
    });
    if (!department) {
      department = await prisma.department.create({
        data: { name: schoolStudent.department }
      });
    }

    // Sync User
    if (user) {
      // Update existing student with latest API details
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          fullName: schoolStudent.fullName,
          level: schoolStudent.level,
          faculty: schoolStudent.faculty,
          semester: schoolStudent.semester,
          departmentId: department.id,
          isActive: true
        },
        include: { roles: { include: { role: true } }, department: true }
      });
    } else {
      // Create new student
      user = await prisma.user.create({
        data: {
          matricNo: schoolStudent.matricNo,
          fullName: schoolStudent.fullName,
          level: schoolStudent.level,
          faculty: schoolStudent.faculty,
          semester: schoolStudent.semester,
          departmentId: department.id,
          isActive: true,
        },
        include: { roles: { include: { role: true } }, department: true }
      });

      // Assign 'student' role
      const studentRole = await prisma.role.findUnique({ where: { name: 'student' } });
      if (studentRole) {
        await prisma.userRole.create({ data: { userId: user.id, roleId: studentRole.id } });
        user.roles = [{ role: studentRole }];
      } else {
        user.roles = [];
      }
    }
  }

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
      level: user.level,
      faculty: user.faculty,
      semester: user.semester,
      departmentId: user.departmentId,
      department: user.department?.name || null,
      roles: roles.map((r) => r.name),
    },
  });
});

router.post('/register', (req, res) => {
  res.status(400).json({ error: 'Registration is disabled. Please log in with your school portal credentials.' });
});

router.post('/logout', requireAuth, async (req, res) => {
  await blacklistToken(req.token);
  await audit({ actorId: req.user.id, action: 'LOGOUT', entityType: 'user', entityId: req.user.id });
  res.json({ message: 'Logged out successfully' });
});

router.post('/change-password', requireAuth, validate(z.object({
  body: z.object({
    currentPassword: z.string(),
    newPassword: z.string().min(6),
  }).strict(),
})), async (req, res) => {
  const { currentPassword, newPassword } = req.validated;
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'Incorrect current password' });

  const newHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash: newHash },
  });

  await audit({ actorId: req.user.id, action: 'CHANGE_PASSWORD', entityType: 'user', entityId: req.user.id });

  res.json({ message: 'Password changed successfully' });
});

export default router;
