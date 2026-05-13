import crypto from 'crypto';
import express from 'express';
import { z } from 'zod';

import { prisma } from '../utils/prisma.js';
import { requireAuth, forbidVotingForAdmins } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { sha256VoteProof } from '../utils/hash.js';
import { audit } from '../utils/audit.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

const voteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 2, // Maximum 2 vote attempts per minute to prevent brute-force
  message: { error: 'Too many vote requests, please slow down.' }
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.get('/elections', requireAuth, async (req, res) => {
  const now = new Date();
  const roleIds = req.user.roles.map((r) => r.id);

  const elections = await prisma.election.findMany({
    where: {
      status: 'OPEN',
      isPublished: true,
      AND: [
        // Date window (null = open-ended)
        { OR: [{ startAt: null }, { startAt: { lte: now } }] },
        { OR: [{ endAt: null }, { endAt: { gte: now } }] },
        // Role filter: if no roles set, open to everyone
        { OR: [{ allowedRoles: { none: {} } }, { allowedRoles: { some: { roleId: { in: roleIds } } } }] },
        // Department filter: null = campus-wide
        { OR: [{ departmentId: null }, { departmentId: req.user.departmentId ?? '__NO_MATCH__' }] },
      ],
    },
    include: {
      type: true,
      department: true,
      positions: {
        include: {
          candidates: {
            where: { status: 'APPROVED' },
            include: { user: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ elections });
});

// Voter: get closed/archived elections to view results
router.get('/elections/closed', requireAuth, async (req, res) => {
  const roleIds = req.user.roles.map((r) => r.id);

  const elections = await prisma.election.findMany({
    where: {
      status: { in: ['CLOSED', 'ARCHIVED'] },
      allowedRoles: { some: { roleId: { in: roleIds } } },
      OR: [
        { departmentId: null },
        { departmentId: req.user.departmentId ?? '__NO_MATCH__' },
      ],
    },
    include: {
      type: true,
      department: true,
    },
    orderBy: { endAt: 'desc' },
  });

  res.json({ elections });
});

// Voter: get positions + approved candidates for a specific election
router.get('/elections/:id/positions', requireAuth, async (req, res) => {
  const electionId = req.params.id;
  const now = new Date();

  // Verify the election is accessible to this voter
  const election = await prisma.election.findUnique({
    where: { id: electionId },
    include: { allowedRoles: true },
  });

  if (!election) return res.status(404).json({ error: 'Election not found' });
  // Allow null dates (open-ended election)
  if (election.status !== 'OPEN') {
    return res.status(403).json({ error: 'Election is not currently active' });
  }
  if (election.startAt && election.startAt > now) {
    return res.status(403).json({ error: 'Election has not started yet' });
  }
  if (election.endAt && election.endAt < now) {
    return res.status(403).json({ error: 'Election has already ended' });
  }

  const roleIds = req.user.roles.map((r) => r.id);
  // If no allowed roles configured, everyone can access
  const allowed = !election.allowedRoles.length || election.allowedRoles.some((ar) => roleIds.includes(ar.roleId));
  if (!allowed) return res.status(403).json({ error: 'Not eligible for this election' });

  if (election.departmentId && election.departmentId !== req.user.departmentId) {
    return res.status(403).json({ error: 'Not eligible for this department election' });
  }

  const positions = await prisma.position.findMany({
    where: { electionId },
    include: {
      candidates: {
        where: { status: 'APPROVED' },
        include: { user: { select: { fullName: true, matricNo: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  res.json({ positions });
});

router.post('/votes', requireAuth, forbidVotingForAdmins, voteLimiter, validate(z.object({
  body: z.object({ positionId: z.string().uuid(), candidateId: z.string().uuid() }).strict(),
})), async (req, res) => {
  const { positionId, candidateId } = req.validated;

  const [position, candidate] = await Promise.all([
    prisma.position.findUnique({
      where: { id: positionId },
      include: { election: { include: { allowedRoles: true } } },
    }),
    prisma.candidate.findUnique({ where: { id: candidateId } }),
  ]);

  if (!position) return res.status(404).json({ error: 'Position not found' });
  const election = position.election;
  const now = new Date();

  if (election.status !== 'OPEN') {
    return res.status(400).json({ error: 'Election is not active' });
  }
  if (election.startAt && election.startAt > now) {
    return res.status(400).json({ error: 'Election has not started yet' });
  }
  if (election.endAt && election.endAt < now) {
    return res.status(400).json({ error: 'Election has ended' });
  }

  const roleIds = req.user.roles.map((r) => r.id);
  // If no allowed roles configured → open to all voters
  const allowed = !election.allowedRoles.length || election.allowedRoles.some((ar) => roleIds.includes(ar.roleId));
  if (!allowed) return res.status(403).json({ error: 'Not eligible for this election' });

  if (election.departmentId && election.departmentId !== req.user.departmentId) {
    return res.status(403).json({ error: 'Not eligible for this department election' });
  }

  if (!candidate || candidate.positionId !== positionId) return res.status(400).json({ error: 'Invalid candidate for this position' });
  if (candidate.status !== 'APPROVED') return res.status(400).json({ error: 'Candidate not approved' });

  try {
    const createdAt = new Date();
    const randomSalt = crypto.randomBytes(16).toString('hex');
    const voteHash = sha256VoteProof({ candidateId, electionId: election.id, createdAt, randomSalt });

    // 1. Transactionally create Receipt (identity) and PendingTally (anonymous buffer)
    const [receipt] = await prisma.$transaction(async (tx) => {
      const vReceipt = await tx.voteReceipt.create({
        data: { electionId: election.id, positionId, voterId: req.user.id }
      });

      const pTally = await tx.pendingTally.create({
        data: { electionId: election.id, positionId, candidateId, voteHash, createdAt }
      });

      await audit({
        actorId: req.user.id,
        action: 'CAST_VOTE_PENDING',
        entityType: 'pendingTally',
        entityId: pTally.id,
        details: { positionId }
      }, tx);

      return [vReceipt, pTally];
    });

    res.json({ ok: true, receiptId: receipt.receiptId, voteHash });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'You have already voted for this position' });
    res.status(500).json({ error: 'Failed to cast vote', details: e.message });
  }
});

// Voter: verify a vote receipt
router.get('/votes/receipt/:receiptId', requireAuth, async (req, res) => {
  const receipt = await prisma.voteReceipt.findUnique({
    where: { receiptId: req.params.receiptId },
    select: { receiptId: true, electionId: true, positionId: true, createdAt: true, voterId: true }
  });

  if (!receipt) return res.status(404).json({ error: 'Invalid receipt ID' });

  // Optional: Ensure only the voter or an admin can verify this receipt
  if (receipt.voterId !== req.user.id) {
    const isAdmin = req.user.roles.some(r => r.isAdminRole);
    if (!isAdmin) return res.status(403).json({ error: 'You cannot view this receipt' });
  }

  res.json({
    ok: true,
    receiptId: receipt.receiptId,
    electionId: receipt.electionId,
    positionId: receipt.positionId,
    timestamp: receipt.createdAt
  });
});

// Voter: get results for any election
router.get('/elections/:id/results', requireAuth, async (req, res) => {
  const electionId = req.params.id;

  const election = await prisma.election.findUnique({
    where: { id: electionId },
    include: { allowedRoles: true },
  });

  if (!election) return res.status(404).json({ error: 'Election not found' });
  // Allow results for any published election (OPEN, CLOSED, or ARCHIVED)
  if (!election.isPublished) {
    return res.status(403).json({ error: 'Results are not available for this election' });
  }

  const positions = await prisma.position.findMany({
    where: { electionId },
    include: { candidates: { include: { user: { select: { fullName: true, matricNo: true } } } } },
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

  res.json({ electionId, electionTitle: election.title, tally });
});

export default router;
