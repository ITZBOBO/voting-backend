import 'dotenv/config';
import app from './app.js';
import { startVoteBatcher } from './utils/batcher.js';

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`✅ API running on http://localhost:${port}`);
  startVoteBatcher();
});
