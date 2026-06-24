import 'dotenv/config';
import app from './app.js';
import { startVoteBatcher } from './utils/batcher.js';

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`✅ API running on http://localhost:${port}`);
  startVoteBatcher();
});
