# Examination Management Platform

Classroom project: digitizes the exam lifecycle from question-paper preparation to final marks.
Modular monolith: Node.js + Express 5, EJS, Bootstrap 5, **PostgreSQL**, **pnpm**.

> Stack change vs. the original brief: PostgreSQL (`pg`, `connect-pg-simple`) replaces MySQL; pnpm replaces npm.

## What is implemented
Every sidebar page is a real, database-backed workflow (no mock screens):

- **Admin** — user accounts and roles, student registry (add/edit/deactivate records used by script uploads), departments, courses, faculty-course assignments, filterable audit log.
- **Controller** — create/edit examinations and advance their lifecycle; monitor approved papers and release them for printing; upload answer-script PDFs with page-count validation, hold/verify/reallocate them; finalize verified marks; view results and export CSV.
- **Faculty** — question bank for assigned courses (MCQ/short/descriptive with answer keys), multi-set paper builder with mark-total validation, PDF generation on submission, revisions after rejection, per-question evaluation of allocated scripts with drafts and correction cycles.
- **Reviewer** — submitted-paper queue, paper detail, approve/reject with comments, PDF download.
- **Printing Coordinator** — released-paper queue and PDF downloads only.
- **Marks Verifier** — submitted-marks queue, verify or send back with a reason, download scripts, read finalized results.

Every signed-in role also has **My account**: a read-only profile summary plus self-service display-name update and password change. Changing a password keeps the current session signed in and terminates every other session for that account. Students are records in a registry, not sign-in accounts — deactivating one hides them from the script-upload picker but keeps their historical scripts and results.

Uploaded scripts and generated papers live outside the web root and are only served through authorized, role-checked download routes. Every form is CSRF-protected and every route enforces RBAC server-side.

## Prerequisites (Windows)
- Node.js 22+ (`node -v`)
- pnpm 10+ (`npm i -g pnpm`)
- PostgreSQL 16+ with `psql` on PATH

## Setup
```powershell
git clone <repo-url>; cd examination-management-platform
pnpm install
copy .env.example .env        # then edit secrets
```
Create the databases (run in psql as the `postgres` superuser):
```sql
CREATE ROLE emp WITH LOGIN PASSWORD 'emp_dev_password' CREATEDB;
CREATE DATABASE emp OWNER emp;
CREATE DATABASE emp_test OWNER emp;
```
Initialize and run:
```powershell
pnpm db:migrate     # applies database/migrations/*.sql
pnpm db:seed        # roles + synthetic demo data
pnpm dev            # http://localhost:3000
pnpm test           # rebuilds emp_test, runs Jest + Supertest
```
`pnpm db:reset` drops and recreates the dev schema (never in production).

## Deploying to Vercel
1. Create a hosted Postgres database (Neon via Vercel Marketplace, or Supabase) and copy its connection string.
2. In Vercel → Project → Settings → Environment Variables add:
   - `DATABASE_URL` – the connection string (Supabase: use the pooler URI)
   - `SESSION_SECRET` – a long random value
   - `SEED_DEMO_DATA=true` – optional, creates the demo accounts below
3. Redeploy. The build (`pnpm build`) applies pending migrations and seeds roles automatically.

If a variable is missing, the site shows a "Server is not configured yet" page instead of crashing.

## Demo accounts (synthetic; password `Demo@12345`)
| Role | Email |
|---|---|
| Admin | admin@college.test |
| Controller | controller@college.test |
| Faculty (CS101) | faculty1@college.test |
| Faculty (CS102) | faculty2@college.test |
| Reviewer | reviewer@college.test |
| Printing Coordinator | printing@college.test |
| Marks Verifier | verifier@college.test |

## Conventions (shared contracts)
- **DB**: snake_case plural tables, `bigint` identity PKs, `timestamptz` (UTC), status via `CHECK`. Schema changes only via new numbered files in `database/migrations/` (never edit an applied one).
- **Modules**: `modules/<name>/<name>.routes.js` exporting an Express router; register in `app.js`.
- **Errors**: throw `AppError` subclasses from `config/errors.js`; handled centrally.
- **API responses**: `{ success: true, data }` or `{ success: false, error: { code, message, details? } }`.
- **Auth**: `requireAuth` then `requireRole('CODE', ...)` on every route; resource-level checks (course/owner) inside services.
- **Transactions**: use `withTransaction` from `config/database.js`; pass the client to `logAudit` so audit commits atomically.
- **Files**: stored under `storage/` (never statically served); delivered only through authorized routes.
- **Git**: feature branches, PR + 1 review, never commit `.env`, uploads or real data.

See `docs/permissions.md` and `docs/status.md`.
