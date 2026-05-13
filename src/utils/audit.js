import { prisma } from './prisma.js';
import { sha256AuditLogHash } from './hash.js';
import fs from 'fs/promises';
import path from 'path';

let actionCounter = 0;

export async function audit({ actorId, action, entityType, entityId, details }, tx = null) {
  const db = tx || prisma;
  
  // Find previous log hash
  const lastLog = await db.auditLog.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { hash: true }
  });
  
  const previousHash = lastLog?.hash || 'GENESIS';
  
  const currentLogData = { actorId, action, entityType, entityId, details: details ?? {} };
  const hash = sha256AuditLogHash({ currentLogData, previousHash });
  
  const log = await db.auditLog.create({
    data: { actorId, action, entityType, entityId, details: details ?? undefined, hash, previousHash },
  });

  // Local persistent anchoring
  fs.appendFile(
    path.join(process.cwd(), 'audit_anchor.txt'),
    `${new Date().toISOString()} | ${action} | ${hash}\n`
  ).catch(console.error);

  // External Anchoring every 10 actions
  actionCounter++;
  if (actionCounter >= 10) {
    actionCounter = 0;
    
    const snapshotPayload = {
      timestamp: new Date().toISOString(),
      latestHash: hash,
      previousHash: previousHash,
      actionCount: 10
    };

    // 1. Mock Remote API call to external immutable ledger
    fetch('https://mock-audit-anchor.runsa.org/api/anchor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshotPayload)
    }).catch(() => { /* Fire and forget, ignore mock fetch failures */ });

    // 2. Secondary Local JSON Snapshot Dump
    fs.appendFile(
      path.join(process.cwd(), 'audit_external_snapshots.json'),
      JSON.stringify(snapshotPayload) + '\n'
    ).catch(console.error);
  }

  return log;
}
