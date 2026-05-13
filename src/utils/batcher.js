import { prisma } from './prisma.js';

// Randomly shuffles an array in-place (Fisher-Yates)
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

export function startVoteBatcher() {
  console.log('⏳ Starting Anti-Timing Vote Batcher...');
  
  // Run every 5 seconds
  setInterval(async () => {
    try {
      // 1. Fetch all pending tallies
      const pending = await prisma.pendingTally.findMany({
        take: 500, // Batch limit
      });

      if (pending.length === 0) return;

      // 2. Memory Shuffle! Obliterates insertion-order timing links
      shuffleArray(pending);

      // 3. Insert shuffles records and delete pending in a transaction
      await prisma.$transaction(async (tx) => {
        const tallyData = pending.map(p => ({
          electionId: p.electionId,
          positionId: p.positionId,
          candidateId: p.candidateId,
          voteHash: p.voteHash,
          createdAt: p.createdAt // keep original timestamp for integrity check
        }));

        await tx.voteTally.createMany({ data: tallyData });
        
        await tx.pendingTally.deleteMany({
          where: { id: { in: pending.map(p => p.id) } }
        });
      });

      console.log(`[Batcher] Flushed ${pending.length} anonymized tallies to DB.`);
    } catch (e) {
      console.error('[Batcher] Error flushing votes:', e.message);
    }
  }, 5000);
}
