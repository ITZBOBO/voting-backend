import express from 'express';
import 'express-async-errors';
import cors from 'cors';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import voterRoutes from './routes/voter.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => res.json({ ok: true, name: 'RUNSA Voting API' }));

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/', voterRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error occurred.'
  });
});

export default app;
