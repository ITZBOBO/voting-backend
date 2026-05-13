import crypto from 'crypto';

export function sha256VoteProof({ candidateId, electionId, createdAt, randomSalt }) {
  const secret = process.env.VOTE_HASH_SECRET || 'default-secret';
  const raw = `${candidateId}|${electionId}|${createdAt.toISOString()}|${randomSalt}|${secret}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function sha256AuditLogHash({ currentLogData, previousHash }) {
  const raw = `${JSON.stringify(currentLogData)}|${previousHash}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
