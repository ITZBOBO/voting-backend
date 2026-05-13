# RUNSA Voting System — Backend Starter (Node.js + Express + PostgreSQL + Prisma)

Starter backend for the **Role-Based Department-Specific Voting System** (Departmental + RUNSA elections).

## Quick start
1) Install Node.js 18+ and PostgreSQL.
2) Create DB: `runsa_voting`
3) Copy `.env.example` → `.env` and set `DATABASE_URL`, `JWT_SECRET`, `VOTE_HASH_SECRET`
4) Install deps: `npm install`
5) Migrate: `npx prisma migrate dev --name init`
6) Seed: `npm run seed`
7) Run: `npm run dev`

Seeded Super Admin:
- matric_no: RUN/ADMIN/0001
- password: Admin@12345
