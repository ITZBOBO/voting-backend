import express from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';

import { prisma } from '../utils/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../utils/audit.js';
import { sha256VoteProof } from '../utils/hash.js';
import { sendElectionOpenEmail, sendElectionCloseEmail } from '../utils/mailer.js';

const router = express.Router();
router.use(requireAuth);

// Super Admin: create role
router.post('/roles', requireRole('super_admin'), validate(z.object({
  body: z.object({
    name: z.string().min(2).regex(/^[a-z_]+$/i),
    description: z.string().optional(),
    isAdminRole: z.boolean().optional(),
    canVote: z.boolean().optional(),
  }).strict(),
})), async (req, res) => {
  const { name, description, isAdminRole, canVote } = req.validated;
  const role = await prisma.role.create({
    data: { name: name.toLowerCase(), description, isAdminRole: !!isAdminRole, canVote: canVote ?? true },
  });
  await audit({ actorId: req.user.id, action: 'CREATE_ROLE', entityType: 'role', entityId: role.id, details: { name: role.name } });
  res.json(role);
});

// Admin: list all roles
router.get('/roles', requireRole(['admin', 'super_admin']), async (req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } });
  res.json({ roles });
});

// Admin: create user
router.post('/users', requireRole(['admin', 'super_admin']), validate(z.object({
  body: z.object({
    matricNo: z.string().min(3),
    schoolEmail: z.string().email().optional(),
    fullName: z.string().min(2).optional(),
    departmentId: z.string().uuid().optional(),
    password: z.string().min(6).optional(),
    roleNames: z.array(z.string().min(2)).default([]),
  }).strict(),
})), async (req, res) => {
  const { matricNo, schoolEmail, fullName, departmentId, password, roleNames } = req.validated;
  const chosenPassword = password ?? 'User@12345';
  const passwordHash = await bcrypt.hash(chosenPassword, 12);

  const user = await prisma.user.create({
    data: { matricNo, schoolEmail, fullName, departmentId, passwordHash, createdById: req.user.id },
  });

  for (const rn of roleNames) {
    const role = await prisma.role.findUnique({ where: { name: rn.toLowerCase() } });
    if (role) await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }

  await audit({ actorId: req.user.id, action: 'CREATE_USER', entityType: 'user', entityId: user.id, details: { matricNo, roleNames } });

  res.json({ user, tempPassword: chosenPassword });
});

// Admin: list all elections
router.get('/elections', requireRole(['admin', 'super_admin']), async (req, res) => {
  const elections = await prisma.election.findMany({
    include: {
      type: true,
      department: true,
      allowedRoles: { include: { role: true } },
      positions: { include: { candidates: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ elections });
});

// Admin: get single election details
router.get('/elections/:id', requireRole(['admin', 'super_admin']), async (req, res) => {
  const election = await prisma.election.findUnique({
    where: { id: req.params.id },
    include: {
      type: true,
      department: true,
      allowedRoles: { include: { role: true } },
      positions: {
        include: {
          candidates: {
            include: { user: { select: { id: true, fullName: true, matricNo: true } } },
          },
        },
      },
    },
  });
  if (!election) return res.status(404).json({ error: 'Election not found' });
  res.json(election);
});

// Admin: create election
router.post('/elections', requireRole(['admin', 'super_admin']), validate(z.object({
  body: z.object({
    title: z.string().min(3),
    typeName: z.string().min(1),
    departmentId: z.string().uuid().nullable().optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
  }).strict(),
})), async (req, res) => {
  const { title, typeName, departmentId, startAt, endAt } = req.validated;
  const type = await prisma.electionType.findUnique({ where: { name: typeName } });
  if (!type) return res.status(400).json({ error: `Invalid election type: "${typeName}"` });
  if (type.name === 'departmental' && !departmentId) return res.status(400).json({ error: 'departmentId required for departmental election' });

  const election = await prisma.election.create({
    data: {
      title,
      typeId: type.id,
      departmentId: type.name === 'departmental' ? departmentId : null,
      startAt: startAt ? new Date(startAt) : null,
      endAt: endAt ? new Date(endAt) : null,
      createdById: req.user.id,
      // Auto-activate so elections are immediately visible
      status: 'OPEN',
      isPublished: true,
      registrationOpen: true,
    },
    include: { type: true, department: true },
  });

  await audit({ actorId: req.user.id, action: 'CREATE_ELECTION', entityType: 'election', entityId: election.id, details: { title, typeName } });
  res.json(election);
});

// Admin: delete ALL elections (super_admin only)
router.delete('/elections', requireRole('super_admin'), async (req, res) => {
  try {
    const electionIds = (await prisma.election.findMany({ select: { id: true } })).map(e => e.id);
    if (!electionIds.length) return res.json({ ok: true, deleted: 0 });

    // Delete in order: tallies first (Restrict constraint), then cascade handles the rest
    await prisma.$transaction([
      prisma.pendingTally.deleteMany({ where: { electionId: { in: electionIds } } }),
      prisma.voteTally.deleteMany({ where: { electionId: { in: electionIds } } }),
      prisma.voteReceipt.deleteMany({ where: { electionId: { in: electionIds } } }),
      prisma.election.deleteMany({ where: { id: { in: electionIds } } }),
    ]);

    await audit({ actorId: req.user.id, action: 'DELETE_ALL_ELECTIONS', entityType: 'election', entityId: 'bulk', details: { count: electionIds.length } });
    res.json({ ok: true, deleted: electionIds.length });
  } catch (err) {
    console.error('DELETE /elections error:', err);
    res.status(500).json({ error: 'Failed to delete elections', details: err.message });
  }
});

// Admin: set election status
router.patch('/elections/:id/status', requireRole(['admin', 'super_admin']), validate(z.object({
  body: z.object({ status: z.enum(['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED']) }).strict()
})), async (req, res) => {
  const { status } = req.validated;
  const election = await prisma.election.update({
    where: { id: req.params.id },
    data: { status },
    include: { allowedRoles: true },
  });
  await audit({ actorId: req.user.id, action: 'SET_ELECTION_STATUS', entityType: 'election', entityId: election.id, details: { status } });

  // Send email notifications asynchronously (don't block response)
  if (status === 'OPEN' || status === 'CLOSED') {
    const roleIds = election.allowedRoles.map(r => r.roleId);
    const voters = await prisma.user.findMany({
      where: { isActive: true, schoolEmail: { not: null }, roles: { some: { roleId: { in: roleIds } } } },
      select: { schoolEmail: true },
    });
    if (status === 'OPEN') sendElectionOpenEmail(voters, election).catch(console.error);
    if (status === 'CLOSED') sendElectionCloseEmail(voters, election).catch(console.error);
  }

  res.json(election);
});

// Admin: set allowed roles for election
router.post(
  '/elections/:id/allowed-roles',
  requireRole(['admin', 'super_admin']),
  validate(
    z.object({
      body: z.object({ roleNames: z.array(z.string().min(2)).min(1) }).strict(),
    })
  ),
  async (req, res) => {
    const electionId = req.params.id;

    // 🔒 LOCK: only allow changing eligibility while election is DRAFT
    const election = await prisma.election.findUnique({
      where: { id: electionId },
      select: { status: true },
    });
    if (!election) return res.status(404).json({ error: 'Election not found' });

    // Allow role assignment on DRAFT or OPEN elections (not CLOSED/ARCHIVED)
    if (['CLOSED', 'ARCHIVED'].includes(election.status)) {
      return res.status(403).json({
        error: 'Election eligibility is locked',
        details: 'Cannot change allowed roles for a closed or archived election.',
      });
    }

    const { roleNames } = req.validated;
    const roles = await prisma.role.findMany({
      where: { name: { in: roleNames.map((r) => r.toLowerCase()) } },
    });
    if (!roles.length) return res.status(400).json({ error: 'No matching roles found' });

    await prisma.electionAllowedRole.deleteMany({ where: { electionId } });
    await prisma.electionAllowedRole.createMany({
      data: roles.map((r) => ({ electionId, roleId: r.id })),
    });

    await audit({
      actorId: req.user.id,
      action: 'SET_ALLOWED_ROLES',
      entityType: 'election',
      entityId: electionId,
      details: { roleNames },
    });

    res.json({ ok: true, electionId, allowed: roles.map((r) => r.name) });
  }
);

// Admin: list positions (optionally filtered by electionId)
router.get('/positions', requireRole(['admin', 'super_admin']), async (req, res) => {
  const { electionId } = req.query;
  const positions = await prisma.position.findMany({
    where: electionId ? { electionId: String(electionId) } : {},
    include: {
      election: { select: { id: true, title: true, status: true } },
      candidates: { include: { user: { select: { id: true, fullName: true, matricNo: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ positions });
});

// Admin: create position
router.post('/positions', requireRole(['admin', 'super_admin']), validate(z.object({
  body: z.object({ electionId: z.string().uuid(), name: z.string().min(2), maxWinners: z.number().int().min(1).default(1) }).strict(),
})), async (req, res) => {
  const { electionId, name, maxWinners } = req.validated;
  const pos = await prisma.position.create({ data: { electionId, name, maxWinners } });
  await audit({ actorId: req.user.id, action: 'CREATE_POSITION', entityType: 'position', entityId: pos.id, details: { electionId, name } });
  res.json(pos);
});

// Admin: list candidates (optionally filtered by positionId or electionId)
router.get('/candidates', requireRole(['admin', 'super_admin']), async (req, res) => {
  const { positionId, electionId } = req.query;
  const where = {};
  if (positionId) where.positionId = String(positionId);
  if (electionId) where.position = { electionId: String(electionId) };
  const candidates = await prisma.candidate.findMany({
    where,
    include: {
      user: { select: { id: true, fullName: true, matricNo: true } },
      position: { select: { id: true, name: true, electionId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ candidates });
});

// Admin: add candidate
router.post('/candidates', requireRole(['admin', 'super_admin']), validate(z.object({
  body: z.object({ positionId: z.string().uuid(), userId: z.string().uuid(), manifesto: z.string().optional(), photoUrl: z.string().url().optional() }).strict(),
})), async (req, res) => {
  try {
    const { positionId, userId, manifesto, photoUrl } = req.validated;
    const cand = await prisma.candidate.create({ data: { positionId, userId, manifesto, photoUrl, status: 'PENDING' } });
    await audit({ actorId: req.user.id, action: 'CREATE_CANDIDATE', entityType: 'candidate', entityId: cand.id, details: { positionId, userId } });
    res.json(cand);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'This user is already a candidate for this position.' });
    }
    console.error('Candidate creation error:', error);
    res.status(500).json({ error: 'Failed to add candidate due to server error.' });
  }
});

// Admin: approve/reject candidate
router.patch('/candidates/:id/decision', requireRole(['admin', 'super_admin']), validate(z.object({
  body: z.object({ status: z.enum(['APPROVED', 'REJECTED']) }).strict(),
})), async (req, res) => {
  const { status } = req.validated;
  const cand = await prisma.candidate.update({
    where: { id: req.params.id },
    data: {
      status,
      approvedById: status === 'APPROVED' ? req.user.id : null,
      approvedAt: status === 'APPROVED' ? new Date() : null,
    },
  });
  await audit({ actorId: req.user.id, action: 'DECIDE_CANDIDATE', entityType: 'candidate', entityId: cand.id, details: { status } });
  res.json(cand);
});

// Admin: results
router.get('/results/elections/:id', requireRole(['admin', 'super_admin']), async (req, res) => {
  const electionId = req.params.id;
  const positions = await prisma.position.findMany({
    where: { electionId },
    include: { candidates: { include: { user: true } } },
  });
  const tallies = await prisma.voteTally.findMany({ where: { electionId } });

  const tally = positions.map((p) => ({
    positionId: p.id,
    positionName: p.name,
    results: p.candidates.map((c) => ({
      candidateId: c.id,
      name: c.user.fullName ?? c.user.matricNo,
      count: tallies.filter((v) => v.positionId === p.id && v.candidateId === c.id).length,
    })).sort((a, b) => b.count - a.count),
  }));

  res.json({ electionId, tally });
});

// Admin: verify a vote tally hash (integrity check)
router.get('/tallies/:id/verify', requireRole(['admin', 'super_admin']), async (req, res) => {
  const tallyId = req.params.id;

  const tally = await prisma.voteTally.findUnique({
    where: { id: tallyId },
  });

  if (!tally) return res.status(404).json({ error: 'Tally not found' });
  if (!tally.voteHash) return res.status(400).json({ error: 'Tally has no hash to verify' });

  // Note: Since randomSalt is not stored to guarantee absolute anonymity, 
  // re-computation by an admin is not possible without the original salt.
  // The hash serves as a one-way integrity proof for the voter holding the receipt.
  
  res.json({
    ok: true,
    tallyId: tally.id,
    electionId: tally.electionId,
    stored: tally.voteHash,
    message: 'Cryptographic proof exists. Full verification requires voter salt.'
  });
});
// Admin: get audit logs
router.get('/audit-logs', requireRole(['admin', 'super_admin']), async (req, res) => {
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    include: { actor: { select: { fullName: true, matricNo: true } } },
    take: 100,
  });
  res.json(logs);
});

// Admin: get election types
router.get('/election-types', requireRole(['admin', 'super_admin']), async (req, res) => {
  const types = await prisma.electionType.findMany({
    orderBy: { name: 'asc' },
  });
  res.json(types);
});

// Admin: get departments
router.get('/departments', requireRole(['admin', 'super_admin']), async (req, res) => {
  const departments = await prisma.department.findMany({
    orderBy: { name: 'asc' },
  });
  res.json(departments);
});

// Super Admin: create department
router.post('/departments', requireRole('super_admin'), validate(z.object({
  body: z.object({ name: z.string().min(2) }),
})), async (req, res) => {
  const { name } = req.validated;
  const dept = await prisma.department.create({ data: { name } });
  await audit({ actorId: req.user.id, action: 'CREATE_DEPARTMENT', entityType: 'department', entityId: dept.id, details: { name } });
  res.json(dept);
});

// Super Admin: rename department
router.patch('/departments/:id', requireRole('super_admin'), validate(z.object({
  body: z.object({ name: z.string().min(2) }),
})), async (req, res) => {
  const { name } = req.validated;
  const dept = await prisma.department.update({ where: { id: req.params.id }, data: { name } });
  await audit({ actorId: req.user.id, action: 'UPDATE_DEPARTMENT', entityType: 'department', entityId: dept.id, details: { name } });
  res.json(dept);
});

// Super Admin: delete department
router.delete('/departments/:id', requireRole('super_admin'), async (req, res) => {
  const dept = await prisma.department.delete({ where: { id: req.params.id } });
  await audit({ actorId: req.user.id, action: 'DELETE_DEPARTMENT', entityType: 'department', entityId: dept.id, details: {} });
  res.json({ ok: true });
});



// Super Admin: create new user (admin)
router.post('/users', requireRole('super_admin'), validate(z.object({
  body: z.object({
    matricNo: z.string().min(3),
    fullName: z.string().optional(),
    schoolEmail: z.string().email().optional().or(z.literal('')),
    password: z.string().optional(),
    roleNames: z.array(z.string()).min(1),
  }).strict()
})), async (req, res) => {
  try {
    const { matricNo, fullName, schoolEmail, password, roleNames } = req.validated;
    
    // Check if user exists
    let user = await prisma.user.findUnique({ where: { matricNo } });
    if (user) {
      return res.status(400).json({ error: 'User with this Matric Number already exists' });
    }

    // Hash password (default: User@12345)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password || 'User@12345', salt);
    
    // Resolve roles
    const roles = await prisma.role.findMany({ where: { name: { in: roleNames } } });
    if (roles.length !== roleNames.length) {
      return res.status(400).json({ error: 'One or more specified roles do not exist' });
    }

    // Create user and attach roles in transaction
    user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          matricNo,
          fullName: fullName || null,
          schoolEmail: schoolEmail || null,
          passwordHash: hashedPassword,
          isActive: true,
        }
      });

      await tx.userRole.createMany({
        data: roles.map(r => ({ userId: newUser.id, roleId: r.id }))
      });

      return newUser;
    });

    await audit({ actorId: req.user.id, action: 'CREATE_USER', entityType: 'user', entityId: user.id, details: { matricNo, roles: roleNames } });
    res.json({ message: 'User created successfully', user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error while creating admin' });
  }
});

// Admin: list all users
router.get('/users', requireRole(['admin', 'super_admin']), async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      roles: { include: { role: { select: { name: true } } } },
      department: { select: { name: true } },
    },
  });
  res.json(users.map(u => ({
    id: u.id, matricNo: u.matricNo, fullName: u.fullName,
    schoolEmail: u.schoolEmail, isActive: u.isActive,
    department: u.department?.name || null,
    roles: u.roles.map(r => r.role.name),
    createdAt: u.createdAt,
  })));
});

// Admin: toggle user active status
router.patch('/users/:id/activate', requireRole(['admin', 'super_admin']), validate(z.object({
  body: z.object({ isActive: z.boolean() }).strict(),
})), async (req, res) => {
  const { isActive } = req.validated;
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { isActive } });
  await audit({ actorId: req.user.id, action: isActive ? 'ACTIVATE_USER' : 'DEACTIVATE_USER', entityType: 'user', entityId: user.id });
  res.json({ id: user.id, matricNo: user.matricNo, isActive: user.isActive });
});

// Admin: assign department to a user
router.patch('/users/:id/department', requireRole(['admin', 'super_admin']), validate(z.object({
  body: z.object({ departmentId: z.string().uuid().nullable() }).strict(),
})), async (req, res) => {
  const { departmentId } = req.validated;
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { departmentId } });
  await audit({ actorId: req.user.id, action: 'ASSIGN_DEPARTMENT', entityType: 'user', entityId: user.id, details: { departmentId } });
  res.json({ id: user.id, matricNo: user.matricNo, departmentId: user.departmentId });
});

export default router;
